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
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CheckpointManager } from "./checkpoint.ts";
import {
  buildDistillPrompt,
  buildDreamPrompt,
  registerCommands,
  type CommandDeps,
} from "./commands.ts";
import { loadConfig } from "./config.ts";
import { metaGet, metaSet, openDb } from "./db.ts";
import { checkMemoryWrite } from "./guard.ts";
import { backfillProject, HistoryIndexer } from "./history.ts";
import { buildRebuildDump, buildSystemPromptAppendix } from "./inject.ts";
import { agentDir, dbPath, logsDir, memoryRoot, projectId, sessionsJsonlDir } from "./paths.ts";
import { reconcile } from "./reconcile.ts";
import { registerHistoryTool, registerMemoryTool } from "./tools.ts";

/** argv prefix to re-invoke pi for writer/dream/distill subprocesses. */
function resolvePiCommand(): string[] {
  const entry = process.argv[1];
  if (entry && /[\\/]cli\.js$/.test(entry)) return [process.execPath, entry];
  return ["pi"];
}

export default function piMimoCme(pi: ExtensionAPI) {
  // Recursion guard: writer/dream/distill children must not re-run the
  // extension (they are spawned with --no-extensions AND this env belt).
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
  // moments" (checkpoint writer, dream/distill subprocesses) resolve
  // asynchronously, OUTSIDE any handler's scope, and the headless children
  // doing the work have no UI of their own — so they reach whatever UI is
  // currently live through this shim rather than a captured-at-spawn ctx.
  // Updated in safe() on every handler invocation; a fresh per-event ctx is
  // fine since they all front the same live session/UI.
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
  const checkpoints = new CheckpointManager({
    db,
    root,
    thresholds: config.checkpoint.thresholds,
    maxWriterFailures: config.checkpoint.maxWriterFailures,
    exec: (command, args, options) => pi.exec(command, args, options),
    piCommand: resolvePiCommand(),
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
   * Live footer: `🧠 mem · <idx> idx · <hist> hist`.
   *   idx  = rows in memory_fts  — every indexed memory layer (global/project/
   *          session markdown); the agent's recallable knowledge, global.
   *   hist = rows in history_fts for THIS project — the layer-4 capture.
   * memory_fts is small and history_fts is project-indexed, so the two
   * COUNT(*)s are cheap enough to run per message/turn. No-op without a UI
   * (-p / json modes). Reusing the "mimo-cme" key overwrites the footer in
   * place, which is what makes it update live rather than stacking entries.
   */
  // Prepared once per session and reused: node:sqlite recompiles SQL on every
  // prepare(), and these two counts fire on every message_end AND turn_end.
  const countMemoryRows = db.prepare("SELECT COUNT(*) AS n FROM memory_fts");
  const countProjectHistoryRows = db.prepare(
    "SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ?",
  );
  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const idx = (countMemoryRows.get() as { n: number }).n;
    const hist = (countProjectHistoryRows.get(projectId(ctx.cwd)) as { n: number }).n;
    ctx.ui.setStatus("mimo-cme", `🧠 mem · ${idx} idx · ${hist} hist`);
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
          if (stats.rows > 0) refreshStatus(ctx); // backfill grew hist — update footer
        } catch (err) {
          reportError("backfill", err);
        }
      }, 0);

      // Auto evolution passes (dream default on / distill default off).
      if (event.reason === "startup" || event.reason === "new") {
        maybeAutoPass(ctx, "dream");
        maybeAutoPass(ctx, "distill");
      }

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
      if (added > 0) refreshStatus(ctx); // hist ticked up — update footer live
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

  pi.on(
    "session_shutdown",
    safe("session_shutdown", () => {
      db.close();
    }),
  );

  registerMemoryTool(pi, { db, root, config, notify });
  registerHistoryTool(pi, { db, root, config, notify });
  registerCommands(pi, { db, root, config, notify });
}
