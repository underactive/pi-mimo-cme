/**
 * /memory, /dream, /distill commands.
 */
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CmeConfig } from "./config.ts";
import { metaGet } from "./db.ts";
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
  // started them and is watching (MiMoCode's /dream is the same).
  pi.registerCommand("dream", {
    description: "mimo-cme: consolidate durable memory from recent sessions (manual dream pass)",
    handler: async (_args, ctx) => {
      pi.sendUserMessage(buildDreamPrompt(deps, ctx.cwd));
    },
  });

  pi.registerCommand("distill", {
    description: "mimo-cme: package repeated workflows into skills/commands (manual distill pass)",
    handler: async (_args, ctx) => {
      pi.sendUserMessage(buildDistillPrompt(deps, ctx.cwd));
    },
  });

  pi.registerCommand("memory", {
    description: "mimo-cme: status | search <query> | dream | distill",
    getArgumentCompletions: (prefix) =>
      ["status", "search", "dream", "distill"]
        .filter((s) => s.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "dream") {
        pi.sendUserMessage(buildDreamPrompt(deps, ctx.cwd));
        return;
      }
      if (trimmed === "distill") {
        pi.sendUserMessage(buildDistillPrompt(deps, ctx.cwd));
        return;
      }
      if (trimmed.startsWith("search")) {
        const query = trimmed.slice("search".length).trim();
        if (!query) {
          ctx.ui.notify("usage: /memory search <query>", "warning");
          return;
        }
        if (deps.config.checkpoint.reconcileOnSearch) {
          reconcile(deps.db, { root: deps.root, ccIndex: deps.config.memory.ccIndex });
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
        pi.sendMessage(
          { customType: "mimo-cme:search", content: `memory search "${query}"\n\n${text}`, display: true },
          { deliverAs: "nextTurn" },
        );
        return;
      }
      // default / "status"
      pi.sendMessage(
        {
          customType: "mimo-cme:status",
          content: statusText(deps, ctx.cwd, ctx.sessionManager.getSessionId()),
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    },
  });
}
