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
import { estimateTokens } from "./budget.ts";
import { actorTaskDir, progressPath } from "./paths.ts";
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
function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap) + "…";
}
/** Collapse a multi-line value to a single trimmed line for ledger renderers. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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
  /**
   * In-memory set of non-terminal actor IDs per session — the footer's
   * active-count source (O(1), zero SQL on the hot path). Intentionally process-
   * local: an actor from a prior process is dead, so a fresh process correctly
   * starts at zero. The DB-backed renderers handle the persisted view.
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
  }

  /**
   * Record one lifecycle event. Returns the progress.md path it wrote (on
   * completed/failed) or undefined. A missing/blank actor id is ignored — we
   * can't key a ledger row without it.
   */
  record(phase: ActorPhase, sid: string, pid: string, ev: ActorEvent): string | undefined {
    const id = asString(ev.id).trim();
    if (!id) return undefined;
    const ts = this.now();
    const type = asString(ev.type);
    const description = asString(ev.description);

    if (phase === "compacted") {
      this.upsertCompacted.run(sid, id, pid, type, description, asInt(ev.tokensBefore), asInt(ev.compactionCount), ts, ts);
      return undefined;
    }

    const terminal = phase === "completed" || phase === "failed";
    const resultSummary = clip(asString(ev.result), RESULT_CAP);
    const errorText = clip(asString(ev.error), RESULT_CAP);
    this.upsertMain.run(
      sid,
      id,
      pid,
      type,
      description,
      statusFor(phase),
      asInt(ev.tokens),
      asInt(ev.toolUses),
      0,
      resultSummary,
      errorText,
      ts,
      ts,
      terminal ? ts : null,
    );

    // Track the live active set for the footer.
    const set = this.activeIds.get(sid) ?? new Set<string>();
    if (terminal) set.delete(id);
    else set.add(id);
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
      tokens: asInt(ev.tokens) || row?.tokens || 0,
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
  const status = statusFor(phase);
  const type = asString(ev.type) || "(unknown)";
  const description = asString(ev.description).trim() || "(none)";
  const result = clip(asString(ev.result).trim(), RESULT_CAP) || "(no result text)";
  const error = clip(asString(ev.error).trim(), RESULT_CAP) || "(none)";
  const meta = [
    `**Type:** ${type}`,
    `**Status:** ${status}`,
    `**Tokens:** ${asInt(ev.tokens)}`,
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

/** Accumulate rendered lines until the token cap, noting any dropped tail. */
function capLines(lines: string[], capTokens: number): string {
  let body = "";
  let dropped = 0;
  for (const [i, line] of lines.entries()) {
    const next = body + line + "\n";
    if (estimateTokens(next) > capTokens) {
      dropped = lines.length - i;
      break;
    }
    body = next;
  }
  if (dropped > 0) body += `…and ${dropped} more (see tasks/<id>/progress.md)\n`;
  return body.trimEnd();
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
  return capLines(rows.map(renderLine), capTokens);
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
  return capLines(lines, capTokens);
}
