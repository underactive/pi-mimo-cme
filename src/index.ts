/**
 * pi-mimo-cme — MiMoCode-style cross-session memory for pi.
 *
 * Factory: env recursion guard, open DB, wire events/tools/commands, close on
 * session_shutdown. Every handler is wrapped so memory failures never break
 * the session (SPEC §9.5).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  isToolCallEventType,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ActorLedger, buildSubagentProgress, type ActorEvent, type ActorPhase } from "./actors.ts";
import { CheckpointManager, type WriterFn } from "./checkpoint.ts";
import {
  buildDistillPrompt,
  buildDreamPrompt,
  registerCommands,
  type CommandDeps,
} from "./commands.ts";
import { loadConfig } from "./config.ts";
import { metaGet, metaSet, openDb } from "./db.ts";
import { FooterCounts } from "./footer-counts.ts";
import { checkMemoryWrite } from "./guard.ts";
import { backfillProject, HistoryIndexer } from "./history.ts";
import { buildRebuildDump, buildSystemPromptAppendix } from "./inject.ts";
import { agentDir, dbPath, logsDir, memoryRoot, projectId, sessionsJsonlDir } from "./paths.ts";
import { reconcile } from "./reconcile.ts";
import { registerHistoryTool, registerMemoryTool } from "./tools.ts";

/** argv prefix to re-invoke pi for the dream/distill subprocesses. */
function resolvePiCommand(): string[] {
  const entry = process.argv[1];
  if (entry && /[\\/]cli\.js$/.test(entry)) return [process.execPath, entry];
  return ["pi"];
}

export default function piMimoCme(pi: ExtensionAPI) {
  // Recursion guard for the dream/distill subprocesses: they re-invoke pi and
  // must not re-run the extension (spawned with --no-extensions AND this env
  // belt). The in-process checkpoint writer needs no env guard — its
  // noExtensions resource loader is what keeps pi-mimo-cme from binding to it.
  if (process.env["PI_MIMO_CME_CHILD"] === "1") return;

  const root = memoryRoot();
  fs.mkdirSync(logsDir(root), { recursive: true });
  const config = loadConfig(root);
  const db = openDb(dbPath(root));
  const logFile = path.join(logsDir(root), "extension.log");
  const log = (message: string) => {
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      /* logging must never throw */
    }
  };

  // The latest ctx seen by any event handler. Memory's "transformation
  // moments" (the in-process checkpoint writer, the dream/distill subprocesses)
  // resolve asynchronously, OUTSIDE any handler's scope, and none of them has a
  // UI of its own — so they reach whatever UI is currently live through this
  // shim rather than a captured-at-spawn ctx. The writer also reads its model /
  // modelRegistry off this shim for the same reason. Updated in safe() on every
  // handler invocation; a fresh per-event ctx is fine since they all front the
  // same live session/UI.
  let latestCtx: ExtensionContext | undefined;
  const notify = (message: string, level: "info" | "warning" | "error" = "info"): void => {
    if (latestCtx?.hasUI) latestCtx.ui.notify(message, level);
  };

  // Surface failures as a toast, but at most once per window. Every failure is
  // logged; the UI gets a throttled heads-up. A permanent one-shot latch would
  // hide every later (distinct) failure for the life of the process — and since
  // the factory runs once per process across many sessions, that could be hours
  // — so throttle on time instead of latching forever.
  const ERROR_NOTIFY_THROTTLE_MS = 60_000;
  let lastErrorNotifyAt = 0;
  const reportError = (name: string, err: unknown, ctx?: ExtensionContext) => {
    log(`${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const c = ctx ?? latestCtx; // backfill etc. pass no ctx — fall back to the live one
    if (!c?.hasUI) return;
    const now = Date.now();
    if (now - lastErrorNotifyAt < ERROR_NOTIFY_THROTTLE_MS) return; // warned recently; the log has the rest
    lastErrorNotifyAt = now;
    c.ui.notify("mimo-cme: a memory operation failed (see pi-mimo-cme/logs/extension.log)", "warning");
  };

  /** SPEC §9.5: handler failures are logged, surfaced once, and swallowed. */
  function safe<E, R>(
    name: string,
    fn: (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void,
  ): (event: E, ctx: ExtensionContext) => Promise<R | void> {
    return async (event, ctx) => {
      latestCtx = ctx; // keep the notify shim pointed at the live UI
      try {
        return await fn(event, ctx);
      } catch (err) {
        reportError(name, err, ctx);
      }
    };
  }

  const indexer = new HistoryIndexer(db, config.history.kinds);
  // Cached footer counters (phase 1): seeded per session_start, mutated by pure
  // arithmetic on the hot path, reseeded after the infrequent reconcile. Shared
  // across the factory's reconcile call sites (here + reconcileAndNotify) so the
  // footer stays exact however memory_fts changed mid-turn. See footer-counts.ts.
  const counts = new FooterCounts();
  // Actor (subagent) ledger (Phase 2): observes pi-subagents lifecycle events
  // off the shared `pi.events` bus and derives the §4 source + progress.md
  // journals. A soft dependency — with pi-subagents absent it simply stays
  // empty. Shares the one DB handle, so it lives and dies with everything else.
  const ledger = new ActorLedger({ db, root });
  /**
   * In-process checkpoint writer (Phase 1) — replaces the headless
   * `pi --no-extensions --no-session -p` subprocess. Builds a throwaway pi SDK
   * session and hands it the writer prompt with the conversation delta inlined.
   *
   * Why it's safe to run in our own process:
   * - `DefaultResourceLoader({ noExtensions: true, ... })` loads ZERO extensions
   *   for this session, so pi-mimo-cme never binds to it. That IS the in-process
   *   recursion guard — the `PI_MIMO_CME_CHILD` env belt only stops subprocesses,
   *   and in-process that var is unset. noExtensions also keeps our path guard,
   *   history indexer, and turn_end threshold from firing on the writer's work.
   * - `SessionManager.inMemory()` never persists a session JSONL, so the layer-4
   *   backfill can't index the writer's own transcript (replaces `--no-session`).
   * - model + modelRegistry come from the LIVE ctx via the `latestCtx` shim: this
   *   runs async, after the handler returned, so a captured ctx may be stale
   *   (AGENTS.md "async UI after await" rule). The registry carries auth, so the
   *   writer authenticates exactly as the live session does.
   * - tools are read/write/edit only (least privilege for a memory daemon).
   *
   * Success/failure mirrors pi's own print mode (modes/print-mode.js): a thrown
   * error, or a final assistant message with stopReason error/aborted, is a
   * failure. We do NOT require non-empty final text — the writer is instructed to
   * stay silent after its Edits, so empty output is the success case.
   */
  const runWriter: WriterFn = async ({ prompt, cwd }) => {
    const ctx = latestCtx;
    if (!ctx?.model || !ctx.modelRegistry) {
      return { ok: false, error: "in-process writer: no live model/registry available" };
    }
    const dir = agentDir();
    let session: AgentSession | undefined;
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: dir,
        noExtensions: true, // critical: no pi-mimo-cme in the writer session (recursion/binding guard)
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir: dir,
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        tools: ["read", "write", "edit"],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd), // ephemeral: no JSONL → never backfilled
      });
      session = created.session;
      await session.prompt(prompt);
      // Mirror print-mode's success check: inspect the final assistant message.
      const messages = session.state.messages as ReadonlyArray<{
        role?: string;
        stopReason?: string;
        errorMessage?: string;
      }>;
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
        return { ok: false, error: last.errorMessage ?? `writer stopped: ${last.stopReason}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
    } finally {
      try {
        session?.dispose();
      } catch {
        /* dispose is best-effort */
      }
    }
  };

  const checkpoints = new CheckpointManager({
    db,
    root,
    thresholds: config.checkpoint.thresholds,
    maxWriterFailures: config.checkpoint.maxWriterFailures,
    runWriter,
    // §4 Subagents source: the actor ledger for this session, capped. Omitted
    // when the tasks layer is off, so the writer renders §4 as "(none)".
    buildSubagentProgress: config.tasks.enabled
      ? (sid) => buildSubagentProgress(db, sid, config.checkpoint.pushCaps.actors)
      : undefined,
    log,
    notify,
  });

  let pendingRebuild = false;
  const sidOf = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const injectCtx = (ctx: ExtensionContext) => ({
    root,
    sid: sidOf(ctx),
    pid: projectId(ctx.cwd),
    caps: config.checkpoint.pushCaps,
  });
  const branchMessages = (ctx: ExtensionContext): unknown[] =>
    ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: unknown }).message);

  /**
   * Live footer: `🧠 <idx> idx · <hist> hist`.
   *   idx  = rows in memory_fts  — every indexed memory layer (global/project/
   *          session markdown); the agent's recallable knowledge, global.
   *   hist = rows in history_fts for THIS project — the layer-4 capture.
   * Phase 1: both numbers come from the in-memory `counts` cache, NOT a live
   * COUNT(*). `history_fts WHERE project_id` was an index range scan that grew
   * with the table; per turn that is now two integer reads and zero SQL. The
   * cache is seeded at session_start and kept current by `addHistory` (inserts)
   * and `reseedMemory` (reconcile). No-op without a UI (-p / json modes).
   * Reusing the "mimo-cme" key overwrites the footer in place, which is what
   * makes it update live rather than stacking entries.
   */
  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const { memIdx, projHist } = counts.snapshot();
    // Append a `· N actors` segment only while subagents are in flight this
    // session (in-memory count, zero SQL on the hot path) — omitted otherwise so
    // the footer stays clean when the tasks layer is unused.
    const actors = ledger.activeCount(sidOf(ctx));
    const actorSeg = actors > 0 ? ` · ${actors} actor${actors === 1 ? "" : "s"}` : "";
    ctx.ui.setStatus("mimo-cme", `🧠 ${memIdx} idx · ${projHist} hist${actorSeg}`);
  }

  /**
   * Absolute paths of every file under the skill/extension asset dirs (global
   * pi agent dir + this project's .pi). Distill runs headless and may write a
   * skill, an extension, or nothing at all ("created nothing" is a valid,
   * expected outcome), so the only honest "what got packaged" signal is the
   * set of files that appear between a snapshot taken before the pass and one
   * taken after — never the agent's freeform stdout.
   */
  function assetSnapshot(cwd: string): Set<string> {
    const roots = [
      path.join(agentDir(), "skills"),
      path.join(agentDir(), "extensions"),
      path.join(cwd, ".pi", "skills"),
      path.join(cwd, ".pi", "extensions"),
    ];
    const out = new Set<string>();
    for (const dir of roots) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir, { recursive: true }) as string[];
      } catch {
        continue; // dir absent — nothing to snapshot
      }
      for (const rel of entries) {
        const full = path.join(dir, rel);
        try {
          if (fs.statSync(full).isFile()) out.add(full);
        } catch {
          /* race / broken symlink — skip */
        }
      }
    }
    return out;
  }

  /** Human label for a new asset: the skill dir name for a SKILL.md, else basename. */
  function assetLabel(p: string): string {
    const base = path.basename(p);
    if (/^skill\.md$/i.test(base)) return path.basename(path.dirname(p));
    return base;
  }

  /**
   * After an auto dream/distill subprocess exits cleanly, re-derive what it
   * changed and surface it. Honest by construction: a dream's effect is the
   * memory-index diff (reconcile picks up its markdown edits); a distill's is
   * the set of asset files that newly exist. No prose parsing.
   */
  function reportPassResult(cwd: string, pass: "dream" | "distill", before: Set<string> | undefined): void {
    if (pass === "dream") {
      const stats = reconcile(db, { root, ccIndex: config.memory.ccIndex });
      counts.reseedMemory(db); // reconcile mutated memory_fts — keep the cached footer exact (invariant #4)
      if (stats.indexed === 0 && stats.removed === 0) {
        notify("🧠 mimo-cme: dream complete — no memory changes");
      } else {
        const parts = [`${stats.indexed} consolidated`];
        if (stats.removed > 0) parts.push(`${stats.removed} pruned`);
        if (stats.globalIndexed > 0) parts.push(`${stats.globalIndexed} to global`);
        notify(`🧠 mimo-cme: dream — ${parts.join(", ")}`);
        if (latestCtx) refreshStatus(latestCtx); // refresh the LIVE footer (spawn-time ctx may be stale post-await)
      }
      return;
    }
    // distill: diff against the spawn-time snapshot, so use the captured cwd (a
    // plain string) — never a post-await ctx, which pi may have invalidated.
    const created = [...assetSnapshot(cwd)].filter((p) => !(before?.has(p) ?? false));
    if (created.length === 0) {
      notify("✨ mimo-cme: distill complete — nothing worth packaging");
    } else if (created.length === 1) {
      notify(`✨ mimo-cme: distilled — packaged ${assetLabel(created[0]!)}`);
    } else {
      notify(`✨ mimo-cme: distilled — packaged ${created.length} assets (${assetLabel(created[0]!)}, …)`);
    }
  }

  function maybeAutoPass(ctx: ExtensionContext, pass: "dream" | "distill"): void {
    const cfg = config[pass];
    if (!cfg.auto) return;
    const pid = projectId(ctx.cwd);
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ?")
      .get(pid) as { n: number };
    if (n === 0) return;
    const metaKey = `last_${pass}_at:${pid}`;
    const last = metaGet(db, metaKey);
    if (last === undefined) {
      // First sighting: start the interval clock now instead of dreaming
      // immediately on a fresh install ("project younger than the interval").
      metaSet(db, metaKey, String(Date.now()));
      return;
    }
    if (Date.now() - Number(last) < cfg.intervalDays * 86_400_000) return;
    metaSet(db, metaKey, String(Date.now()));
    const deps: CommandDeps = { db, root, config, notify };
    const prompt = pass === "dream" ? buildDreamPrompt(deps, ctx.cwd) : buildDistillPrompt(deps, ctx.cwd);
    notify(
      pass === "dream"
        ? "🌙 mimo-cme: dream consolidation running in background"
        : "📦 mimo-cme: distill pass running in background",
    );
    // Capture cwd as a plain string at spawn: the .then runs after an await, and
    // pi invalidates a captured ctx once the user switches/forks the session
    // (runner.js invalidate()). Post-await work must never touch ctx — use this
    // string for project identity and the live notify shim for UI.
    const cwd = ctx.cwd;
    // Distill writes outside the memory tree, so capture the asset set NOW to
    // diff against once the child exits (dream's effect is read from the index
    // instead, so it needs no before-snapshot).
    const before = pass === "distill" ? assetSnapshot(cwd) : undefined;
    const logName = path.join(logsDir(root), `${pass}-${Date.now()}.log`);
    // The child queries the DB read-only via `sqlite3` (see dream/distill prompts).
    // Flush committed WAL frames into the main file first so the child's readonly
    // snapshot includes this session's history/memory writes; TRUNCATE also keeps
    // the WAL bounded across a long-lived parent session.
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      log(`${pass}: wal_checkpoint before spawn failed (continuing): ${String(err)}`);
    }
    // --no-session: ephemeral child, must not persist a session JSONL into the dir
    // the layer-4 backfill scans (else the memory system indexes its own transcripts).
    void pi
      .exec(
        "/usr/bin/env",
        ["PI_MIMO_CME_CHILD=1", ...resolvePiCommand(), "--no-extensions", "--no-session", "-p", prompt],
        { cwd },
      )
      .then((res) => {
        fs.writeFileSync(logName, `code=${res.code}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}\n`);
        log(`${pass}: background pass finished code=${res.code} (log: ${logName})`);
        if (res.code === 0) {
          try {
            reportPassResult(cwd, pass, before);
          } catch (err) {
            reportError(`${pass}_report`, err); // no ctx: spawn-time ctx may be stale post-await — fall back to the live shim
          }
        }
      })
      .catch((err) => log(`${pass}: background pass failed to spawn: ${String(err)}`));
  }

  pi.on(
    "session_start",
    safe("session_start", (event, ctx) => {
      if (event.reason === "resume" || event.reason === "fork") pendingRebuild = true;

      // On a resume the session id continues but its prior process is gone, so any
      // actor row still marked running/created is stale (those subagents died with
      // the old process). Reap them to "stopped" so the rebuild dump's "Active
      // actors" reflects reality. A same-process compaction never hits this path,
      // so genuinely in-flight actors there are preserved.
      if (config.tasks.enabled && event.reason === "resume") {
        const reaped = ledger.reapStale(sidOf(ctx));
        if (reaped > 0) log(`actor: reaped ${reaped} stale running actor(s) on resume`);
      }

      // Layer-4 backfill of this project's past sessions: background + idempotent.
      setTimeout(() => {
        try {
          const stats = backfillProject(
            db,
            sessionsJsonlDir(ctx.cwd),
            projectId(ctx.cwd),
            config.history.kinds,
            sidOf(ctx),
          );
          if (stats.files > 0) log(`backfill: ${stats.rows} rows from ${stats.files} session files`);
          if (stats.rows > 0) {
            counts.addHistory(stats.rows); // backfill inserted history rows — bump the cached count
            refreshStatus(ctx); // backfill grew hist — update footer
          }
        } catch (err) {
          reportError("backfill", err);
        }
      }, 0);

      // Auto evolution passes (dream default on / distill default off).
      if (event.reason === "startup" || event.reason === "new") {
        maybeAutoPass(ctx, "dream");
        maybeAutoPass(ctx, "distill");
      }

      // Seed the cached footer counters once from COUNT(*), then the per-turn
      // paths only do arithmetic. Reseeding every session_start is also the
      // self-heal: any drift from a prior session starts fresh here.
      counts.seed(db, projectId(ctx.cwd));
      refreshStatus(ctx); // initial footer (backfill above refreshes again once it lands)
    }),
  );

  pi.on(
    "session_compact",
    safe("session_compact", () => {
      pendingRebuild = true;
    }),
  );

  // 1) System prompt: memory instructions + project/global layers + keys index,
  //    every turn. Always APPEND to event.systemPrompt (chaining rule).
  pi.on(
    "before_agent_start",
    safe("inject_system_prompt", (event, ctx) => {
      const appendix = buildSystemPromptAppendix(db, injectCtx(ctx));
      return { systemPrompt: event.systemPrompt + "\n\n" + appendix };
    }),
  );

  // 2) One-shot rebuild dump after resume / fork / compaction.
  pi.on(
    "before_agent_start",
    safe("inject_rebuild", (_event, ctx) => {
      if (!pendingRebuild) return;
      pendingRebuild = false;
      const dump = buildRebuildDump(db, injectCtx(ctx));
      if (dump === undefined) return; // checkpoint absent or all "(none yet)" — skip silently
      return { message: { customType: "mimo-cme:rebuild", content: dump, display: true } };
    }),
  );

  // 3) Memory-flush nudge at 70% / 85% context usage, once per level.
  pi.on(
    "before_agent_start",
    safe("inject_nudge", (_event, ctx) => {
      const nudge = checkpoints.nudgeFor(sidOf(ctx), ctx.getContextUsage()?.percent);
      if (nudge === undefined) return;
      return { message: { customType: "mimo-cme:nudge", content: nudge, display: false } };
    }),
  );

  // Layer 4: continuous history indexing.
  pi.on(
    "message_end",
    safe("message_end", (event, ctx) => {
      const added = indexer.indexMessage(sidOf(ctx), projectId(ctx.cwd), event.message);
      if (added > 0) {
        counts.addHistory(added); // pure arithmetic on the hot path — no per-turn COUNT(*)
        refreshStatus(ctx); // hist ticked up — update footer live
      }
    }),
  );

  // Threshold-driven checkpoint writer.
  pi.on(
    "turn_end",
    safe("turn_end", (_event, ctx) => {
      checkpoints.maybeCheckpoint({
        sid: sidOf(ctx),
        pid: projectId(ctx.cwd),
        cwd: ctx.cwd,
        percent: ctx.getContextUsage()?.percent,
        messages: branchMessages(ctx),
      });
      refreshStatus(ctx); // backstop: also picks up idx changes from in-turn memory searches
    }),
  );

  // Capture state before pi compacts; wait for the writer up to 60s.
  pi.on(
    "session_before_compact",
    safe("session_before_compact", async (_event, ctx) => {
      checkpoints.fireCheckpoint({
        sid: sidOf(ctx),
        pid: projectId(ctx.cwd),
        cwd: ctx.cwd,
        messages: branchMessages(ctx),
      });
      await checkpoints.waitForIdle(60_000);
    }),
  );

  // Path guard: only notes.md (this session) and MEMORY.md (this project) are
  // writable by the main agent under the memory root.
  pi.on(
    "tool_call",
    safe("tool_call_guard", (event, ctx) => {
      if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;
      const verdict = checkMemoryWrite(root, sidOf(ctx), projectId(ctx.cwd), event.input.path, ctx.cwd);
      if (!verdict.allowed) return { block: true, reason: verdict.reason };
    }),
  );

  // Phase 2: observe pi-subagents lifecycle events off the shared `pi.events`
  // bus (soft dependency — no import, no spawn RPC; if pi-subagents isn't loaded
  // these channels simply never fire). Each payload is serializable and recorded
  // into the actor ledger; the writer reconciles it into §4 and the rebuild dump
  // surfaces in-flight actors. Bus handlers run outside the `safe()` lifecycle
  // path, so they wrap their own try/catch (a throw here could disrupt the bus).
  const busUnsubs: (() => void)[] = [];
  if (config.tasks.enabled) {
    const recordActor = (phase: ActorPhase) => (data: unknown) => {
      const ctx = latestCtx; // attribute the actor to whatever session is live now
      if (!ctx) return;
      const ev = (data ?? {}) as ActorEvent;
      const wrote = ledger.record(phase, sidOf(ctx), projectId(ctx.cwd), ev);
      // Trace every observed event (file log only) — the real channel sequence is
      // what the smoke test and any future debugging need to see.
      log(`actor ${phase}: id=${typeof ev.id === "string" ? ev.id : "?"}${wrote ? ` → wrote ${wrote}` : ""}`);
      refreshStatus(ctx); // active-actor count may have changed
    };
    const onBus = (channel: string, handler: (data: unknown) => void): void => {
      busUnsubs.push(
        pi.events.on(channel, (data) => {
          try {
            handler(data);
          } catch (err) {
            reportError(`events:${channel}`, err);
          }
        }),
      );
    };
    onBus("subagents:created", recordActor("created"));
    onBus("subagents:started", recordActor("started"));
    onBus("subagents:completed", recordActor("completed"));
    onBus("subagents:failed", recordActor("failed"));
    onBus("subagents:compacted", recordActor("compacted"));
    onBus("subagents:ready", () => log("subagents: ready signal received"));
  }

  pi.on(
    "session_shutdown",
    safe("session_shutdown", () => {
      for (const off of busUnsubs.splice(0)) {
        try {
          off();
        } catch {
          /* unsubscribe is best-effort */
        }
      }
      db.close();
    }),
  );

  registerMemoryTool(pi, { db, root, config, counts, notify });
  registerHistoryTool(pi, { db, root, config, counts, notify });
  registerCommands(pi, { db, root, config, counts, notify });
}
