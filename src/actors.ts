/**
 * Actor (subagent) ledger — Phase 2 of the subagent integration.
 *
 * pi-subagents (a soft, optional dependency) emits lifecycle events on the
 * shared `pi.events` bus: subagents:created|started|completed|failed|compacted.
 * We OBSERVE those events — purely serializable payloads, never the other
 * extension's live objects — and derive two durable artifacts:
 *
 *   1. an `actor` ledger row per subagent (status, tokens, result), and
 *   2. a `progress.md` journal under sessions/<sid>/tasks/<actorId>/, synthesized
 *      from the completion payload (MiMoCode forced the subagent to write this
 *      via a postStop hook; we can't run a hook inside another extension's
 *      subagent, so we synthesize it from the payload instead — a deliberate,
 *      documented simplification).
 *
 * The checkpoint writer reconciles the ledger into checkpoint §4 Subagents (via
 * an inlined SUBAGENT PROGRESS block); the rebuild dump surfaces in-flight
 * actors. The progress.md journals live under the memory root, so reconcile's
 * tree walk indexes them as `type='progress'` and they become FTS-searchable
 * like every other layer.
 *
 * Pure module (no pi imports) so it runs under plain `node --test`. The clock is
 * injectable for deterministic tests; it defaults to Date.now.
 */
import * as fs from "node:fs";
import { actorTaskDir, progressPath } from "./paths.ts";
import { capLines, clip, oneLine } from "./text-utils.ts";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** The five pi-subagents lifecycle phases we observe. */
export type ActorPhase = "created" | "started" | "completed" | "failed" | "compacted";

/**
 * Loosely-typed subagents event payload (see SUBAGENT-INTEGRATION-PLAN §2). All
 * fields are optional and validated defensively — this crosses an extension
 * boundary, so we trust nothing about its shape.
 */
export interface ActorEvent {
  id?: unknown;
  type?: unknown;
  description?: unknown;
  result?: unknown;
  error?: unknown;
  status?: unknown;
  toolUses?: unknown;
  durationMs?: unknown;
  tokens?: unknown;
  reason?: unknown; // compacted
  tokensBefore?: unknown; // compacted
  compactionCount?: unknown; // compacted
}

/** Clip applied to the result/error text persisted into a progress.md journal. */
const RESULT_CAP = 4000;
/** Clip applied to a single ledger line in the §4 / rebuild renderers. */
const LINE_CAP = 200;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}
/**
 * Extract a token count from a pi-subagents payload. `tokens` is emitted as an
 * object `{ input, output, total }` (or `undefined` when nothing was produced),
 * NOT a scalar — `subagents:completed` in pi-subagents@0.10.x. `tokensBefore`
 * (compacted) is a plain number. Accept both shapes so the ledger records real
 * usage instead of silently storing 0.
 */
function asTokenCount(v: unknown): number {
  if (typeof v === "number") return asInt(v);
  if (v && typeof v === "object") {
    const total = (v as { total?: unknown }).total;
    if (typeof total === "number") return asInt(total);
  }
  return 0;
}
/** Terminal statuses pi-subagents reports on subagents:completed|failed payloads. */
const TERMINAL_STATUSES = new Set(["completed", "error", "stopped", "aborted"]);

/** Maps a lifecycle phase to the status stored in the ledger. */
function statusFor(phase: ActorPhase): string {
  switch (phase) {
    case "created":
      return "created";
    case "started":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "compacted":
      return "running"; // only used when compacted is the first event seen
  }
}

export interface LedgerRow {
  id: string;
  type: string;
  description: string;
  status: string;
  tokens: number;
  tool_uses: number;
  compaction_count: number;
  result_summary: string;
  error: string;
}

const SELECT_COLS =
  "id, type, description, status, tokens, tool_uses, compaction_count, result_summary, error";

export interface ActorLedgerDeps {
  db: DatabaseSync;
  root: string;
  /** Injectable clock (tests pass a fixed/stepping clock); defaults to Date.now. */
  now?: () => number;
}

export class ActorLedger {
  private db: DatabaseSync;
  private root: string;
  private now: () => number;
  private upsertMain: StatementSync;
  private upsertCompacted: StatementSync;
  private existsStmt!: StatementSync;
  /**
   * In-memory set of non-terminal actor IDs per session — backs `activeCount`
   * (O(1), zero SQL on the hot path). Intentionally process-local: an actor from
   * a prior process is dead, so a fresh process correctly starts at zero. The
   * DB-backed renderers handle the persisted view.
   */
  private activeIds = new Map<string, Set<string>>();

  constructor(deps: ActorLedgerDeps) {
    this.db = deps.db;
    this.root = deps.root;
    this.now = deps.now ?? (() => Date.now());
    // status is set on the main upsert; compacted deliberately leaves status
    // untouched (a compaction does not end a run) and only bumps counters.
    this.upsertMain = this.db.prepare(
      `INSERT INTO actor
         (session_id, id, project_id, type, description, status, tokens, tool_uses,
          compaction_count, result_summary, error, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, id) DO UPDATE SET
         project_id = excluded.project_id,
         type = CASE WHEN excluded.type <> '' THEN excluded.type ELSE actor.type END,
         description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE actor.description END,
         status = excluded.status,
         tokens = MAX(actor.tokens, excluded.tokens),
         tool_uses = MAX(actor.tool_uses, excluded.tool_uses),
         result_summary = CASE WHEN excluded.result_summary <> '' THEN excluded.result_summary ELSE actor.result_summary END,
         error = CASE WHEN excluded.error <> '' THEN excluded.error ELSE actor.error END,
         updated_at = excluded.updated_at,
         completed_at = COALESCE(excluded.completed_at, actor.completed_at)`,
    );
    this.upsertCompacted = this.db.prepare(
      `INSERT INTO actor
         (session_id, id, project_id, type, description, status, tokens, tool_uses,
          compaction_count, result_summary, error, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, 0, ?, '', '', ?, ?, NULL)
       ON CONFLICT(session_id, id) DO UPDATE SET
         tokens = MAX(actor.tokens, excluded.tokens),
         compaction_count = MAX(actor.compaction_count, excluded.compaction_count),
         updated_at = excluded.updated_at`,
    );
    this.existsStmt = this.db.prepare("SELECT 1 FROM actor WHERE session_id = ? AND id = ? LIMIT 1");
  }

  private exists(sid: string, id: string): boolean {
    // Fast path: if the actor is in the in-memory active set, it definitely exists.
    const active = this.activeIds.get(sid);
    if (active?.has(id)) return true;
    return this.existsStmt.get(sid, id) !== undefined;
  }

  /**
   * Record one lifecycle event. Returns the progress.md path it wrote (on
   * completed/failed) or undefined.
   *
   * SCOPE: the ledger tracks BACKGROUND subagents only. pi-subagents emits
   * `subagents:created` exclusively in its background branch and fires the
   * terminal `completed`/`failed` events only for background agents
   * (agent-manager.js gates `onComplete` on `isBackground`). FOREGROUND agents
   * emit just `started` and return their result inline to the caller — already
   * in the conversation, so the checkpoint delta captures it without us. We
   * therefore let ONLY `created` introduce a row and gate every other phase on
   * an existing row. This both targets the out-of-band results worth keeping and
   * avoids a foreground agent (which never emits a terminal event) lingering as
   * "running" forever. It's robust to pi-subagents emitting `started` before
   * `created` for non-queued background agents — the orphan `started` is simply
   * dropped and `created` establishes the row a moment later.
   *
   * A missing/blank actor id is ignored — we can't key a row without it.
   */
  record(phase: ActorPhase, sid: string, pid: string, ev: ActorEvent): string | undefined {
    const id = asString(ev.id).trim();
    if (!id) return undefined;
    if (phase !== "created" && !this.exists(sid, id)) return undefined; // foreground / orphan event
    const ts = this.now();
    const type = asString(ev.type);
    const description = asString(ev.description);

    if (phase === "compacted") {
      this.upsertCompacted.run(sid, id, pid, type, description, asTokenCount(ev.tokensBefore), asInt(ev.compactionCount), ts, ts);
      return undefined;
    }

    const terminal = phase === "completed" || phase === "failed";
    // created → "created"; started → "running"; terminal → pi-subagents' own
    // status (completed/error/stopped/aborted) when present, else phase default
    // (so a stopped/aborted subagent isn't flattened to "error").
    const payloadStatus = asString(ev.status);
    const status = terminal && TERMINAL_STATUSES.has(payloadStatus) ? payloadStatus : statusFor(phase);
    const resultSummary = clip(asString(ev.result), RESULT_CAP);
    const errorText = clip(asString(ev.error), RESULT_CAP);
    this.upsertMain.run(
      sid,
      id,
      pid,
      type,
      description,
      status,
      asTokenCount(ev.tokens),
      asInt(ev.toolUses),
      0,
      resultSummary,
      errorText,
      ts,
      ts,
      terminal ? ts : null,
    );

    // Live active set (backs `activeCount`): a background agent enters on
    // `created` and leaves on its terminal event; `started`/`compacted` don't
    // change membership.
    const set = this.activeIds.get(sid) ?? new Set<string>();
    if (phase === "created") set.add(id);
    else if (terminal) set.delete(id);
    this.activeIds.set(sid, set);

    if (terminal) return this.writeProgress(sid, id, ev, phase, ts);
    return undefined;
  }

  /** Number of non-terminal actors observed THIS process for a session. */
  activeCount(sid: string): number {
    return this.activeIds.get(sid)?.size ?? 0;
  }

  /**
   * Mark a session's non-terminal actors as stopped. Called on a resume: those
   * subagents ran in a now-dead process, so a persisted "running" row is stale.
   * Same-process compaction never calls this, so genuinely in-flight actors are
   * preserved there.
   */
  reapStale(sid: string): number {
    const ts = this.now();
    const res = this.db
      .prepare(
        "UPDATE actor SET status = 'stopped', updated_at = ? WHERE session_id = ? AND status IN ('created', 'running')",
      )
      .run(ts, sid);
    this.activeIds.delete(sid);
    return Number(res.changes ?? 0);
  }

  /**
   * Synthesize the per-actor progress.md journal. Built from the MERGED ledger
   * row (which carries type/description/tokens accumulated across the actor's
   * earlier created/started events) overlaid with the terminal payload, so a
   * sparse completed/failed event still yields a complete journal.
   */
  private writeProgress(sid: string, id: string, ev: ActorEvent, phase: ActorPhase, ts: number): string {
    const row = this.db
      .prepare("SELECT type, description, tokens, tool_uses FROM actor WHERE session_id = ? AND id = ?")
      .get(sid, id) as { type: string; description: string; tokens: number; tool_uses: number } | undefined;
    const merged: ActorEvent = {
      ...ev,
      type: asString(ev.type) || row?.type || "",
      description: asString(ev.description) || row?.description || "",
      tokens: asTokenCount(ev.tokens) || row?.tokens || 0,
      toolUses: asInt(ev.toolUses) || row?.tool_uses || 0,
    };
    const file = progressPath(sid, id, this.root);
    fs.mkdirSync(actorTaskDir(sid, id, this.root), { recursive: true });
    fs.writeFileSync(file, renderProgressJournal(id, merged, phase, new Date(ts).toISOString()), "utf8");
    return file;
  }
}

/**
 * The progress.md body. Synthesized from the completion payload rather than
 * written by the subagent itself (we have no postStop hook inside it). Plain
 * markdown so reconcile indexes it as `type='progress'` and the writer/dream
 * can reconcile or search it.
 */
export function renderProgressJournal(
  id: string,
  ev: ActorEvent,
  phase: ActorPhase,
  isoTime: string,
): string {
  const payloadStatus = asString(ev.status);
  const status = TERMINAL_STATUSES.has(payloadStatus) ? payloadStatus : statusFor(phase);
  const type = asString(ev.type) || "(unknown)";
  const description = asString(ev.description).trim() || "(none)";
  const result = clip(asString(ev.result).trim(), RESULT_CAP) || "(no result text)";
  const error = clip(asString(ev.error).trim(), RESULT_CAP) || "(none)";
  const meta = [
    `**Type:** ${type}`,
    `**Status:** ${status}`,
    `**Tokens:** ${asTokenCount(ev.tokens)}`,
    `**Tool uses:** ${asInt(ev.toolUses)}`,
    `**Duration:** ${asInt(ev.durationMs)}ms`,
  ].join(" · ");
  return `# Subagent progress — ${id}

${meta}
**Recorded:** ${isoTime}

## Description

${description}

## Result

${result}

## Error

${error}
`;
}

/** One ledger row → a single condensed line for the renderers. */
function renderLine(r: LedgerRow): string {
  const summary = oneLine(r.result_summary || r.error || "(no result)");
  const meta = r.tokens > 0 || r.tool_uses > 0 ? `  (tokens: ${r.tokens}, tools: ${r.tool_uses})` : "";
  const type = r.type || "subagent";
  return clip(`- ${r.id} · ${type} · ${r.status} — ${summary}`, LINE_CAP) + meta;
}


/**
 * The SUBAGENT PROGRESS block inlined into the checkpoint-writer prompt — every
 * actor this session, newest first, for the writer to reconcile into §4.
 * Returns "" when the session has no actors (the writer then renders §4 as
 * "(no subagents this session)").
 */
export function buildSubagentProgress(db: DatabaseSync, sid: string, capTokens: number): string {
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM actor WHERE session_id = ? ORDER BY updated_at DESC`)
    .all(sid) as unknown as LedgerRow[];
  if (rows.length === 0) return "";
  return capLines(rows.map(renderLine), capTokens, "(see tasks/<id>/progress.md)");
}

/**
 * The `## Active actors` section body for the rebuild dump — non-terminal
 * actors only (still in flight at compaction time). Returns undefined when none,
 * so the caller can omit the section entirely.
 */
export function buildActiveActorsSection(
  db: DatabaseSync,
  sid: string,
  capTokens: number,
): string | undefined {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM actor
       WHERE session_id = ? AND status IN ('created', 'running')
       ORDER BY updated_at DESC`,
    )
    .all(sid) as unknown as LedgerRow[];
  if (rows.length === 0) return undefined;
  const lines = rows.map((r) => {
    const desc = oneLine(r.description || r.result_summary || "(no description)");
    return clip(`- ${r.id} · ${r.type || "subagent"} · ${r.status} — ${desc}`, LINE_CAP);
  });
  return capLines(lines, capTokens, "(see tasks/<id>/progress.md)");
}
