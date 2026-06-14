/**
 * /memory, /dream, /distill commands.
 */
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CmeConfig } from "./config.ts";
import { metaGet, validationSummary, writerMetricsSummary } from "./db.ts";
import type { FooterCounts } from "./footer-counts.ts";
import { memorySearch } from "./fts.ts";
import {
  agentDir,
  checkpointPath,
  dbPath,
  globalMemoryPath,
  notesPath,
  projectId,
  projectMemoryPath,
} from "./paths.ts";
import { dreamPrompt } from "./prompts/dream.ts";
import { distillPrompt } from "./prompts/distill.ts";
import { reconcile } from "./reconcile.ts";

export interface CommandDeps {
  db: DatabaseSync;
  root: string;
  config: CmeConfig;
  /**
   * Cached footer counters (phase 1). Optional: prompt-building call sites
   * (maybeAutoPass) don't need it, but any path that reconciles must reseed it
   * so the live footer stays exact (invariant #4). See reconcileAndNotify.
   */
  counts?: FooterCounts;
  /** UI toast, no-op without a UI (see index.ts notify shim). */
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/**
 * Per-session debounce clock for search-triggered reconcile, keyed by DB handle.
 * A WeakMap (not a module `let`) is deliberate: each session opens its own
 * DatabaseSync, so the key differs per session — the clock physically cannot be
 * mis-shared across concurrent sessions, and it's GC'd when the handle closes.
 * In-memory (not persisted in `meta`) so the first search of every session
 * always reconciles; only rapid repeat searches within a session are skipped.
 */
const lastReconcileAt = new WeakMap<DatabaseSync, number>();

/**
 * Reconcile, then surface "🔄 Memory indexed" only when rows actually changed.
 * Shared by the /memory search command and the memory tool (ToolDeps is
 * structurally identical to CommandDeps). Reconcile reports a non-zero diff
 * only when a file's size-mtime fingerprint changed since last index, so the
 * toast is naturally rare — repeat searches over an unchanged tree stay quiet.
 *
 * The full tree walk is synchronous and grows with session count, so it is
 * debounced: if a reconcile ran < reconcileDebounceMs ago this session, skip the
 * walk entirely (the agent is told to search memory FIRST and may fire several
 * searches per turn — without this each one re-walks the whole tree on the
 * interactive event loop). The clock starts on completion, so a burst collapses
 * to one walk; a window of 0 disables debouncing.
 */
export function reconcileAndNotify(deps: CommandDeps): void {
  const windowMs = deps.config.checkpoint.reconcileDebounceMs;
  if (windowMs > 0) {
    const last = lastReconcileAt.get(deps.db);
    if (last !== undefined && Date.now() - last < windowMs) return; // reconciled this session very recently — stay off the hot path
  }
  const stats = reconcile(deps.db, { root: deps.root, ccIndex: deps.config.memory.ccIndex });
  lastReconcileAt.set(deps.db, Date.now());
  if (stats.indexed === 0 && stats.removed === 0) return; // nothing changed on disk — stay quiet
  // memory_fts moved during the turn — reseed the cached footer so the turn_end
  // backstop refresh shows the new idx count (invariant #4). Exact, off the hot
  // path (only fires on a search that actually re-indexed something).
  deps.counts?.reseedMemory(deps.db);
  const parts = [`${stats.indexed} indexed`];
  if (stats.removed > 0) parts.push(`${stats.removed} removed`);
  deps.notify?.(`🔄 mimo-cme: memory indexed — ${parts.join(", ")}`);
}

function statusText(deps: CommandDeps, cwd: string, sid: string): string {
  const { db, root } = deps;
  const pid = projectId(cwd);
  const scopes = db
    .prepare("SELECT scope, COUNT(*) AS n FROM memory_fts GROUP BY scope ORDER BY scope")
    .all() as unknown as { scope: string; n: number }[];
  const history = db.prepare("SELECT COUNT(*) AS n FROM history_fts").get() as { n: number };
  const projectHistory = db
    .prepare("SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ?")
    .get(pid) as { n: number };
  const actorRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM actor WHERE session_id = ? GROUP BY status ORDER BY status")
    .all(sid) as unknown as { status: string; n: number }[];
  let dbSize = 0;
  try {
    dbSize = fs.statSync(dbPath(root)).size;
  } catch {
    /* not created yet */
  }
  const fmtMeta = (key: string) => {
    const v = metaGet(db, key);
    return v ? new Date(Number(v)).toISOString() : "never";
  };
  const lines = [
    "mimo-cme memory status",
    "",
    `memory files indexed: ${scopes.length === 0 ? "0" : scopes.map((s) => `${s.scope}=${s.n}`).join(" ")}`,
    `history rows: ${history.n} total, ${projectHistory.n} this project`,
    `subagents (this session): ${actorRows.length === 0 ? "none" : actorRows.map((a) => `${a.status}=${a.n}`).join(" ")}`,
    `db: ${dbPath(root)} (${(dbSize / 1024).toFixed(1)} KB)`,
    `last dream: ${fmtMeta(`last_dream_at:${pid}`)} (auto=${deps.config.dream.auto}, every ${deps.config.dream.intervalDays}d)`,
    `last distill: ${fmtMeta(`last_distill_at:${pid}`)} (auto=${deps.config.distill.auto}, every ${deps.config.distill.intervalDays}d)`,
    "",
    `session  ${sid}`,
    `  checkpoint: ${checkpointPath(sid, root)}`,
    `  notes:      ${notesPath(sid, root)}`,
    `project  ${pid}`,
    `  memory:     ${projectMemoryPath(pid, root)}`,
    `global   ${globalMemoryPath(root)}`,
  ];
  return lines.join("\n");
}

/**
 * The Phase 3 "measure first" readout (SUBAGENT-INTEGRATION-PLAN §6): turns the
 * recorded writer_metrics rows into the build-vs-skip verdict the plan's
 * precondition asks for. The comparison is conservative — it pits the parent
 * context billed at the ~10% cache-read rate (a fork's impossible-best case,
 * every checkpoint a warm hit) against what the writer pays in full-price input
 * today. If even that best case loses, the fork is not worth building.
 */
export function metricsText(deps: CommandDeps, cwd: string): string {
  const pid = projectId(cwd);
  const proj = writerMetricsSummary(deps.db, { projectId: pid });
  const all = writerMetricsSummary(deps.db);
  if (all.n === 0) {
    return [
      'mimo-cme writer metrics (Phase 3 "measure first")',
      "",
      "no checkpoint-writer runs recorded yet. Run a session past a context",
      "threshold (20/40/60/80%) so the in-process writer fires, then re-run",
      "/memory metrics to see its cost vs. what a fork=true writer would carry.",
    ].join("\n");
  }
  const fmt = (n: number) => Math.round(n).toLocaleString();
  const parent = proj.avgParentTokens;
  const forkBestCase = parent == null ? null : parent * 0.1; // cache-read ≈ 10% of input price
  const verdict =
    parent == null
      ? "no parent-context sizes captured — cannot compare against a fork"
      : forkBestCase! > proj.avgInput
        ? `fork LOSES even best case: ~${fmt(forkBestCase!)} cache-read tok/run > ${fmt(proj.avgInput)} full-price input now → Phase 3 not worth building`
        : `fork MIGHT help: best case ~${fmt(forkBestCase!)} cache-read tok/run < ${fmt(proj.avgInput)} full-price input now → worth deeper measurement`;
  return [
    'mimo-cme writer metrics (Phase 3 "measure first")',
    "",
    `this project (${pid}): ${proj.n} run(s), ${proj.okCount} ok`,
    `  writer tokens/run:   input≈${fmt(proj.avgInput)}  output≈${fmt(proj.avgOutput)}  total≈${fmt(proj.avgTotal)}`,
    `  cache tokens/run:    read≈${fmt(proj.avgCacheRead)}  write≈${fmt(proj.avgCacheWrite)}   (read≈0 = no prefix reuse today)`,
    `  cost/run:            $${proj.avgCostUsd.toFixed(4)}`,
    `  delta fed/run:       ≈${fmt(proj.avgDeltaTokensEst)} tok`,
    `  parent ctx at fire:  ${parent == null ? "n/a" : "≈" + fmt(parent) + " tok"}   (what a fork=true writer would carry)`,
    `  wall-clock/run:      ${fmt(proj.avgDurationMs)} ms`,
    "",
    `verdict: ${verdict}`,
    "",
    `all projects: ${all.n} run(s) · writer input≈${fmt(all.avgInput)} tok · parent≈${all.avgParentTokens == null ? "n/a" : fmt(all.avgParentTokens) + " tok"}`,
  ].join("\n");
}

/**
 * CHECKPOINT-VALIDATOR-PLAN Phase 1 readout: turns the recorded
 * checkpoint_validations rows into the "measure first" histogram that gates
 * Phase 2 (retry + revert). The three numbers that decide whether to enable
 * enforcement are surfaced directly: how often anything fires (clean rate),
 * which codes dominate, and how big budget overruns get.
 */
export function validationText(deps: CommandDeps, cwd: string): string {
  const pid = projectId(cwd);
  const proj = validationSummary(deps.db, { projectId: pid });
  const all = validationSummary(deps.db);
  if (all.n === 0) {
    return [
      'mimo-cme checkpoint validations (Phase 1 "measure first")',
      "",
      "no checkpoints validated yet. Run a session past a context threshold",
      "(20/40/60/80%) so the in-process writer fires, then re-run",
      "/memory validations to see how the writer's output scores against the spec.",
    ].join("\n");
  }
  const pct = (part: number, whole: number) => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`);
  const hist = Object.entries(proj.codeHistogram).sort((a, b) => b[1] - a[1]);
  const histText = hist.length === 0 ? "    (none)" : hist.map(([c, n]) => `    ${c}: ${n}`).join("\n");
  return [
    'mimo-cme checkpoint validations (Phase 1 "measure first")',
    "",
    `this project (${pid}): ${proj.n} checkpoint(s) validated`,
    `  clean (no error/extract):  ${proj.cleanCount} (${pct(proj.cleanCount, proj.n)})`,
    `  with error:                ${proj.withError} (${pct(proj.withError, proj.n)})`,
    `  with extract-required:     ${proj.withExtract} (${pct(proj.withExtract, proj.n)})`,
    `  with warn:                 ${proj.withWarn} (${pct(proj.withWarn, proj.n)})`,
    `  avg violations/run:        error≈${proj.avgError.toFixed(2)} extract≈${proj.avgExtract.toFixed(2)} warn≈${proj.avgWarn.toFixed(2)}`,
    `  worst budget overrun:      ${proj.maxOverrunPct}%`,
    `  code histogram (runs):`,
    histText,
    "",
    `Phase 2 (retry + revert) is gated on this data — see docs/FUTURE-IMPROVEMENTS.md.`,
    "",
    `all projects: ${all.n} validated, ${all.cleanCount} clean (${pct(all.cleanCount, all.n)})`,
  ].join("\n");
}

export function buildDreamPrompt(deps: CommandDeps, cwd: string): string {
  const pid = projectId(cwd);
  return dreamPrompt({
    memoryRoot: deps.root,
    dbPath: dbPath(deps.root),
    projectId: pid,
    projectMemoryPath: projectMemoryPath(pid, deps.root),
    globalMemoryPath: globalMemoryPath(deps.root),
  });
}

export function buildDistillPrompt(deps: CommandDeps, cwd: string): string {
  const pid = projectId(cwd);
  return distillPrompt({
    memoryRoot: deps.root,
    dbPath: dbPath(deps.root),
    projectId: pid,
    projectMemoryPath: projectMemoryPath(pid, deps.root),
    agentDir: agentDir(),
  });
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  // Manual evolution passes run in the CURRENT session: the user intentionally
  // started them and is watching (MiMoCode's /dream is the same). pi.sendUserMessage
  // THROWS when the agent is streaming unless a deliverAs is given, and pi lets
  // commands be entered mid-turn — so guard on ctx.isIdle() and queue as a follow-up
  // (runs after the current turn, same session) rather than steer (which would
  // interrupt the user's in-flight request). See examples/extensions/send-user-message.ts.
  const sendManualPass = (ctx: ExtensionCommandContext, prompt: string, label: string): void => {
    if (ctx.isIdle()) {
      pi.sendUserMessage(prompt);
      return;
    }
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    ctx.ui.notify(`mimo-cme: ${label} queued — runs after the current turn`, "info");
  };

  // Display-only readouts (status / search). Pi renders a custom message in the
  // UI ONLY via sendCustomMessage's non-streaming, no-trigger path (it emits
  // message_start/_end there). deliverAs:"nextTurn" instead parks the message in
  // _pendingNextTurnMessages — an invisible "aside" merged into the next request
  // as context and never rendered — which is why /memory printed nothing. We also
  // can't reach the render path mid-stream without steering the readout into the
  // agent's live turn, and these readouts are instant to re-run, so when busy we
  // ask the user to retry rather than disrupt the turn.
  const showReadout = (ctx: ExtensionCommandContext, customType: string, content: string): void => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("mimo-cme: agent is busy — run that again when idle", "warning");
      return;
    }
    pi.sendMessage({ customType, content, display: true });
  };

  pi.registerCommand("dream", {
    description: "mimo-cme: consolidate durable memory from recent sessions (manual dream pass)",
    handler: async (_args, ctx) => {
      sendManualPass(ctx, buildDreamPrompt(deps, ctx.cwd), "dream");
    },
  });

  pi.registerCommand("distill", {
    description: "mimo-cme: package repeated workflows into skills/commands (manual distill pass)",
    handler: async (_args, ctx) => {
      sendManualPass(ctx, buildDistillPrompt(deps, ctx.cwd), "distill");
    },
  });

  pi.registerCommand("memory", {
    description: "mimo-cme: status | search <query> | metrics | validations | dream | distill",
    getArgumentCompletions: (prefix) =>
      ["status", "search", "metrics", "validations", "dream", "distill"]
        .filter((s) => s.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "dream") {
        sendManualPass(ctx, buildDreamPrompt(deps, ctx.cwd), "dream");
        return;
      }
      if (trimmed === "metrics") {
        showReadout(ctx, "mimo-cme:metrics", metricsText(deps, ctx.cwd));
        return;
      }
      if (trimmed === "validations") {
        showReadout(ctx, "mimo-cme:validations", validationText(deps, ctx.cwd));
        return;
      }
      if (trimmed === "distill") {
        sendManualPass(ctx, buildDistillPrompt(deps, ctx.cwd), "distill");
        return;
      }
      if (trimmed.startsWith("search")) {
        const query = trimmed.slice("search".length).trim();
        if (!query) {
          ctx.ui.notify("usage: /memory search <query>", "warning");
          return;
        }
        if (deps.config.checkpoint.reconcileOnSearch) {
          reconcileAndNotify(deps);
        }
        const hits = memorySearch(deps.db, {
          query,
          limit: 10,
          floorRatio: deps.config.checkpoint.scoreFloor,
        });
        const text =
          hits.length === 0
            ? `no memory hits for "${query}"`
            : hits.map((h) => `${h.score.toFixed(2)}  ${h.path}\n      ${h.snippet}`).join("\n");
        showReadout(ctx, "mimo-cme:search", `memory search "${query}"\n\n${text}`);
        return;
      }
      // default / "status"
      showReadout(ctx, "mimo-cme:status", statusText(deps, ctx.cwd, ctx.sessionManager.getSessionId()));
    },
  });
}
