/**
 * /memory, /dream, /distill commands.
 */
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CmeConfig } from "./config.ts";
import { describeClearPlan, describeClearResult, executeClear, planClear } from "./clear.ts";
import { metaGet, validationSummary, writerMetricsSummary } from "./db.ts";
import { estimateTokens } from "./budget.ts";
import { bar, fmtK, sectionHeader, kvLine, tokenBarLine } from "./formatting.ts";
import { getAppendixBreakdown, getRebuildBreakdown } from "./injection-breakdown.ts";
import { buildSystemPromptAppendix, buildRebuildDump, type InjectContext } from "./inject.ts";
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

function statusText(deps: CommandDeps, cwd: string, sid: string, contextWindow?: number): string {
  const { db, root } = deps;
  const pid = projectId(cwd);
  const cw = contextWindow ?? 200_000;
  const scopes = db
    .prepare("SELECT scope, COUNT(*) AS n FROM memory_fts GROUP BY scope ORDER BY scope")
    .all() as unknown as { scope: string; n: number }[];
  const totalIdx = scopes.reduce((s, r) => s + r.n, 0);
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

  // --- Injection breakdown (zero-cost in-memory read) ---
  const ab = getAppendixBreakdown();
  const injectionLines: string[] = [];
  injectionLines.push("", sectionHeader("Injection Overhead"));
  if (ab) {
    const total = ab.instructions + ab.projectMem + ab.globalMem + ab.keys;
    injectionLines.push(
      kvLine("instructions", `≈${fmtK(ab.instructions)} tok`),
      kvLine("project MEMORY.md", `≈${fmtK(ab.projectMem)} tok`),
      kvLine("global MEMORY.md", `≈${fmtK(ab.globalMem)} tok`),
      kvLine("keys index", `≈${fmtK(ab.keys)} tok`),
      tokenBarLine("total:", total, cw, cw),
      kvLine("cached", ab.cached ? "yes (same as last turn)" : "no (just computed)"),
    );
  } else {
    injectionLines.push(kvLine("", "(not yet computed this session)"));
  }

  // --- Rebuild breakdown (populated on resume/fork/compaction, undefined otherwise) ---
  const rb = getRebuildBreakdown();
  const rebuildLines: string[] = [];
  rebuildLines.push("", sectionHeader("Rebuild Dump (last resume)"));
  if (rb && (rb.checkpoint > 0 || rb.notes > 0)) {
    rebuildLines.push(
      kvLine("checkpoint", `≈${fmtK(rb.checkpoint)} tok`),
      kvLine("notes", `≈${fmtK(rb.notes)} tok`),
      kvLine("keys", String(rb.keyCount)),
      kvLine("actors", String(rb.actorCount)),
      kvLine("total", `≈${fmtK(rb.checkpoint + rb.notes + rb.keysTokens)} tok`),
    );
  } else {
    rebuildLines.push(kvLine("", "(no rebuild yet this session)"));
  }

  const scopeText = scopes.length === 0 ? "0" : scopes.map((s) => `${s.scope}=${s.n}`).join(" ");
  const actorText = actorRows.length === 0 ? "none" : actorRows.map((a) => `${a.status}=${a.n}`).join(" ");

  const lines = [
    "mimo-cme memory status",
    "",
    sectionHeader("Memory Index"),
    tokenBarLine("memory files:", totalIdx, Math.max(totalIdx, 100), cw),
    kvLine("", scopeText),
    tokenBarLine("history rows:", history.n, Math.max(history.n, 1000), cw),
    kvLine("", `${history.n} total · ${projectHistory.n} this project`),
    ...injectionLines,
    ...rebuildLines,
    "",
    sectionHeader("Session"),
    kvLine("session", sid),
    kvLine("checkpoint", checkpointPath(sid, root)),
    kvLine("notes", notesPath(sid, root)),
    kvLine("subagents", actorText),
    "",
    sectionHeader("Project"),
    kvLine("project", pid),
    kvLine("memory", projectMemoryPath(pid, root)),
    kvLine("global", globalMemoryPath(root)),
    "",
    sectionHeader("Meta"),
    kvLine("db", `${dbPath(root)} (${(dbSize / 1024).toFixed(1)} KB)`),
    kvLine("last dream", `${fmtMeta(`last_dream_at:${pid}`)} (auto=${deps.config.dream.auto}, every ${deps.config.dream.intervalDays}d)`),
    kvLine("last distill", `${fmtMeta(`last_distill_at:${pid}`)} (auto=${deps.config.distill.auto}, every ${deps.config.distill.intervalDays}d)`),
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
export function metricsText(deps: CommandDeps, cwd: string, contextWindow?: number): string {
  const pid = projectId(cwd);
  const cw = contextWindow ?? 200_000;
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
  const forkBestCase = parent == null ? null : parent * 0.1;
  const verdict =
    parent == null
      ? "no parent-context sizes captured — cannot compare against a fork"
      : forkBestCase! > proj.avgInput
        ? `fork LOSES even best case: ~${fmt(forkBestCase!)} cache-read tok/run > ${fmt(proj.avgInput)} full-price input now → Phase 3 not worth building`
        : `fork MIGHT help: best case ~${fmt(forkBestCase!)} cache-read tok/run < ${fmt(proj.avgInput)} full-price input now → worth deeper measurement`;
  const okRate = proj.n > 0 ? Math.round((proj.okCount / proj.n) * 100) : 0;
  void cw; // available for future bar() calls if needed
  return [
    'mimo-cme writer metrics (Phase 3 "measure first")',
    "",
    sectionHeader("This Project"),
    kvLine("runs", `${proj.n} (${proj.okCount} ok, ${okRate}% success)`),
    kvLine("writer tokens/run", `input≈${fmt(proj.avgInput)}  output≈${fmt(proj.avgOutput)}  total≈${fmt(proj.avgTotal)}`),
    kvLine("cache tokens/run", `read≈${fmt(proj.avgCacheRead)}  write≈${fmt(proj.avgCacheWrite)}`),
    kvLine("cost/run", `$${proj.avgCostUsd.toFixed(4)}`),
    kvLine("delta fed/run", `≈${fmt(proj.avgDeltaTokensEst)} tok`),
    kvLine("parent ctx at fire", parent == null ? "n/a" : `≈${fmt(parent)} tok`),
    kvLine("wall-clock/run", `${fmt(proj.avgDurationMs)} ms`),
    "",
    sectionHeader("Fork Verdict"),
    kvLine("verdict", verdict),
    "",
    sectionHeader("All Projects"),
    kvLine("runs", `${all.n} (${all.okCount} ok)`),
    kvLine("writer input", `≈${fmt(all.avgInput)} tok`),
    kvLine("parent ctx", all.avgParentTokens == null ? "n/a" : `≈${fmt(all.avgParentTokens)} tok`),
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
    sectionHeader("This Project"),
    kvLine("checkpoints", `${proj.n} validated`),
    "",
    `  clean rate:  ${bar(proj.cleanCount, proj.n)}  ${proj.cleanCount} (${pct(proj.cleanCount, proj.n)})`,
    "",
    kvLine("with error", `${proj.withError} (${pct(proj.withError, proj.n)})`),
    kvLine("with extract-required", `${proj.withExtract} (${pct(proj.withExtract, proj.n)})`),
    kvLine("with warn", `${proj.withWarn} (${pct(proj.withWarn, proj.n)})`),
    kvLine("avg violations/run", `error≈${proj.avgError.toFixed(2)} extract≈${proj.avgExtract.toFixed(2)} warn≈${proj.avgWarn.toFixed(2)}`),
    kvLine("worst budget overrun", `${proj.maxOverrunPct}%`),
    "",
    sectionHeader("Code Histogram"),
    histText,
    "",
    sectionHeader("All Projects"),
    kvLine("validated", `${all.n}`),
    kvLine("clean", `${all.cleanCount} (${pct(all.cleanCount, all.n)})`),
    "",
    `Phase 2 (retry + revert) is gated on this data — see docs/FUTURE-IMPROVEMENTS.md.`,
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

  // Destructive, irreversible-ish wipe of THIS project's memory. Distinct from
  // the read-only readouts: it mutates the shared DB the live session uses, so it
  // requires idle (like showReadout). Flow: preview (deletes nothing) → confirm
  // → execute → reseed the cached footer. `--yes`/`-y`/`force` skips the dialog,
  // and is REQUIRED in headless/RPC modes where ui.confirm has no surface.
  const runClear = async (ctx: ExtensionCommandContext, rest: string): Promise<void> => {
    if (!ctx.isIdle()) {
      ctx.ui.notify("mimo-cme: agent is busy — run /memory clear when idle", "warning");
      return;
    }
    const forced = /(^|\s)(--yes|-y|force)(\s|$)/.test(rest);
    const sid = ctx.sessionManager.getSessionId();
    const plan = planClear(deps.db, ctx.cwd, { root: deps.root, currentSessionId: sid });
    if (plan.empty) {
      ctx.ui.notify(`mimo-cme: nothing to clear for project ${plan.projectId}`, "info");
      return;
    }
    pi.sendMessage({ customType: "mimo-cme:clear-preview", content: describeClearPlan(plan), display: true });

    let execute = forced;
    if (!forced) {
      if (!ctx.hasUI) {
        ctx.ui.notify("mimo-cme: no interactive UI — re-run `/memory clear --yes` to execute", "warning");
        return;
      }
      execute = await ctx.ui.confirm(
        "mimo-cme: clear this project's memory?",
        `Project ${plan.projectId}: curated files move to trash, derived DB rows are deleted. The current session is preserved. Proceed?`,
      );
    }
    if (!execute) {
      ctx.ui.notify("mimo-cme: clear cancelled", "info");
      return;
    }

    const result = executeClear(deps.db, plan, { root: deps.root, currentSessionId: sid });
    // The wipe changed memory_fts and history_fts — reseed both cached footer
    // counters so the live footer reflects the post-clear state (invariant #4).
    deps.counts?.seed(deps.db, plan.projectId);
    pi.sendMessage({ customType: "mimo-cme:clear-result", content: describeClearResult(result), display: true });
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
    description: "mimo-cme: status | search <query> | metrics | validations | preview | system-prompt | system-prompt size | dream | distill | clear",
    getArgumentCompletions: (prefix) =>
      ["status", "search", "metrics", "validations", "preview", "system-prompt", "system-prompt size", "dream", "distill", "clear"]
        .filter((s) => s.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "clear" || trimmed.startsWith("clear ")) {
        await runClear(ctx, trimmed.slice("clear".length).trim());
        return;
      }
      if (trimmed === "dream") {
        sendManualPass(ctx, buildDreamPrompt(deps, ctx.cwd), "dream");
        return;
      }
      if (trimmed === "metrics") {
        const metricsUsage = ctx.getContextUsage();
        showReadout(ctx, "mimo-cme:metrics", metricsText(deps, ctx.cwd, metricsUsage?.contextWindow));
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
      if (trimmed === "preview") {
        const injectCtx: InjectContext = {
          root: deps.root,
          sid: ctx.sessionManager.getSessionId(),
          pid: projectId(ctx.cwd),
          caps: deps.config.checkpoint.pushCaps,
        };
        const appendix = buildSystemPromptAppendix(deps.db, injectCtx);
        const rebuild = buildRebuildDump(deps.db, injectCtx);
        const parts: string[] = [];
        parts.push(sectionHeader("System Prompt Appendix (every turn)"));
        parts.push(appendix);
        if (rebuild !== undefined) {
          parts.push("");
          parts.push(sectionHeader("Rebuild Dump (last resume/fork/compaction)"));
          parts.push(rebuild);
        } else {
          parts.push("");
          parts.push(sectionHeader("Rebuild Dump (last resume/fork/compaction)"));
          parts.push("(none — no checkpoint loaded this session)");
        }
        showReadout(ctx, "mimo-cme:preview", parts.join("\n"));
        return;
      }
      if (trimmed === "system-prompt" || trimmed.startsWith("system-prompt ")) {
        const sub = trimmed.slice("system-prompt".length).trim();
        if (sub === "size") {
          const prompt = ctx.getSystemPrompt();
          const tokens = estimateTokens(prompt);
          const lines = [
            sectionHeader("System Prompt Size"),
            kvLine("Characters", prompt.length.toLocaleString()),
            kvLine("Estimated tokens", fmtK(tokens)),
            "",
            "Note: size reflects the full system prompt (harness + context + skills + CME + other extensions).",
          ];
          showReadout(ctx, "mimo-cme:system-prompt:size", lines.join("\n"));
          return;
        }
        showReadout(ctx, "mimo-cme:system-prompt", ctx.getSystemPrompt());
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
      const statusUsage = ctx.getContextUsage();
      showReadout(
        ctx,
        "mimo-cme:status",
        statusText(deps, ctx.cwd, ctx.sessionManager.getSessionId(), statusUsage?.contextWindow),
      );
    },
  });
}
