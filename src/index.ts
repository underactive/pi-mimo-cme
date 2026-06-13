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
import { dbPath, logsDir, memoryRoot, projectId, sessionsJsonlDir } from "./paths.ts";
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

  let notifiedError = false;
  const reportError = (name: string, err: unknown, ctx?: ExtensionContext) => {
    log(`${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (!notifiedError && ctx?.hasUI) {
      notifiedError = true;
      ctx.ui.notify("mimo-cme: a memory operation failed (see memory/logs/extension.log)", "warning");
    }
  };

  /** SPEC §9.5: handler failures are logged, surfaced once, and swallowed. */
  function safe<E, R>(
    name: string,
    fn: (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void,
  ): (event: E, ctx: ExtensionContext) => Promise<R | void> {
    return async (event, ctx) => {
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
    const deps: CommandDeps = { db, root, config };
    const prompt = pass === "dream" ? buildDreamPrompt(deps, ctx.cwd) : buildDistillPrompt(deps, ctx.cwd);
    if (ctx.hasUI) {
      ctx.ui.notify(
        pass === "dream"
          ? "🌙 mimo-cme: dream consolidation running in background"
          : "📦 mimo-cme: distill pass running in background",
        "info",
      );
    }
    const logName = path.join(logsDir(root), `${pass}-${Date.now()}.log`);
    void pi
      .exec(
        "/usr/bin/env",
        ["PI_MIMO_CME_CHILD=1", ...resolvePiCommand(), "--no-extensions", "-p", prompt],
        { cwd: ctx.cwd },
      )
      .then((res) => {
        fs.writeFileSync(logName, `code=${res.code}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}\n`);
        log(`${pass}: background pass finished code=${res.code} (log: ${logName})`);
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
        } catch (err) {
          reportError("backfill", err);
        }
      }, 0);

      // Auto evolution passes (dream default on / distill default off).
      if (event.reason === "startup" || event.reason === "new") {
        maybeAutoPass(ctx, "dream");
        maybeAutoPass(ctx, "distill");
      }

      if (ctx.hasUI) {
        const { n } = db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number };
        ctx.ui.setStatus("mimo-cme", `🧠 ${n} memories`);
      }
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
      indexer.indexMessage(sidOf(ctx), projectId(ctx.cwd), event.message);
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

  registerMemoryTool(pi, { db, root, config });
  registerHistoryTool(pi, { db, root, config });
  registerCommands(pi, { db, root, config });
}
