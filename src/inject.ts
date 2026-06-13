/**
 * Read path: system-prompt assembly (memory instructions + project/global
 * layers + keys index, every turn) and the one-shot rebuild dump injected
 * after resume / fork / compaction.
 */
import * as fs from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { buildActiveActorsSection } from "./actors.ts";
import { budgetText, budgetedRead, estimateTokens } from "./budget.ts";
import type { PushCaps } from "./config.ts";
import {
  checkpointPath,
  globalMemoryPath,
  notesPath,
  projectMemoryPath,
} from "./paths.ts";

export interface InjectContext {
  root: string;
  sid: string;
  pid: string;
  caps: PushCaps;
}

/**
 * Adapted from MiMoCode's buildMemoryInstructions. §4 tracks subagent/actor
 * activity (Phase 2, reconciled from the actor ledger) rather than MiMoCode's
 * user task graph, for which pi has no registry.
 */
export function buildMemoryInstructions(ctx: InjectContext): string {
  const projectPath = projectMemoryPath(ctx.pid, ctx.root);
  const globalPath = globalMemoryPath(ctx.root);
  const cpPath = checkpointPath(ctx.sid, ctx.root);
  const nPath = notesPath(ctx.sid, ctx.root);
  return `# Memory system

You have a persistent file-based memory system. Four layers:

- Project memory at \`${projectPath}\` — persistent across all sessions in this project. Contains: project context, rules, architecture decisions, durable cross-task knowledge.
- Session checkpoint at \`${cpPath}\` — current session's structured state, written ONLY by the checkpoint writer. 11 sections covering active intent, next action, directives, subagents, current work, files, learnings, errors, live resources, design decisions, and open notes.
- Global memory at \`${globalPath}\` — user-level preferences and cross-project feedback that persist across all projects. Read-only from the agent side; the dream pass promotes entries there.
- Raw history — every past session's conversation, indexed machine-wide. Search it with the \`history\` tool when curated memory has no answer.

The checkpoint writer is the sole curator of the structured files. You don't maintain them mid-task — the writer extracts everything from the conversation at checkpoint events.

## When to Edit MEMORY.md directly

You may Edit \`${projectPath}\` when:
- User states a project-level rule that should hold across sessions → ## Rules
- User states a project-level architectural decision → ## Architecture decisions
- A clearly durable cross-session fact emerges that you want available immediately, before the next checkpoint → ## Discovered durable knowledge

These are exceptions, not the norm. The writer covers most extraction at checkpoint time.

## Notes scratchpad

You have a single legal scratchpad at \`${nPath}\`. Append entries to it when you want to record:

- A quote (from the user, an article, a known engineer) that has lasting value but isn't a task-specific decision
- An unresolved question — something you noticed but won't answer this turn
- A cross-project observation — "we did this in project X, similar pattern here"
- A note for future-self — context that would matter weeks later but doesn't fit any current task

Format each entry as:
  ## [turn N · YYYY-MM-DDTHH:MM:SSZ]
  Free-form body. The writer reorganizes structured content at checkpoint time.

This is your ONLY legal scratchpad — don't create \`learning.md\`, \`scratch.md\`, or any other ad-hoc memory file.

## What NOT to do

- Don't Edit checkpoint.md — that's the writer's domain.
- Don't create memory files other than notes.md (no learning.md, no scratch.md). Use notes.md for any free-form entry.
- Don't ask the user about something memory may already record — search first via the memory tool / Grep / Read.

## Active recall protocol

Project memory and global memory are injected below when present. After a resume, fork, or compaction, a "Summary of previous conversation from checkpoint files:" dump (checkpoint.md, notes.md) may also be in your context.

If these dumps are visible in your context:

- Do NOT Read them again as whole files. The bytes are already in front of you.
- For specific past details (a particular turn's content, a specific tool output, an old command), use the memory tool or Grep with a keyword pattern to target the exact item — do not pull a whole file.
- For files NOT dumped (other sessions' checkpoints, spillover files), Read on demand; the "Memory keys index" below lists what exists.

If a dump shows "⚠️ Truncated at ~N tokens. Read(<path>, offset=L) for the rest." — that file was budget-cut. Use Read with the offset only when you need the missing tail.

Memory entries name functions, files, flags, paths — those are CLAIMS about a point in time when they were written. Verify before acting on a specific name.

Don't ask the user about something memory may already record.`;
}

/**
 * Per-DB-handle state for the read path: prepared statements (node:sqlite
 * recompiles SQL on every prepare(), and these run every turn) plus the cached
 * appendix. Keyed by DB handle in a WeakMap, so it's per-session (one handle
 * per session) and GC'd when the DB closes — never a cross-session singleton.
 */
interface InjectState {
  keysStmt: StatementSync;
  /** COUNT(*) + MAX(last_indexed_at) over memory_fts — the appendix cache key's index component. */
  aggStmt: StatementSync;
  appendix?: { key: string; value: string };
}
const injectState = new WeakMap<DatabaseSync, InjectState>();
function stateFor(db: DatabaseSync): InjectState {
  let s = injectState.get(db);
  if (s === undefined) {
    s = {
      keysStmt: db.prepare(
        `SELECT path FROM memory_fts
         WHERE scope = 'global' OR (scope = 'sessions' AND scope_id = ?) OR (scope = 'projects' AND scope_id = ?)
         ORDER BY path`,
      ),
      aggStmt: db.prepare(
        "SELECT COUNT(*) AS n, COALESCE(MAX(last_indexed_at), 0) AS mx FROM memory_fts",
      ),
    };
    injectState.set(db, s);
  }
  return s;
}

/**
 * Memory keys index: paths visible to this session (global ∪ this session ∪
 * this project), minus files already dumped, budgeted.
 */
export function memoryKeysIndex(
  db: DatabaseSync,
  ctx: InjectContext,
  exclude: ReadonlySet<string>,
): string | undefined {
  const rows = stateFor(db).keysStmt.all(ctx.sid, ctx.pid) as unknown as { path: string }[];
  const paths = rows.map((r) => r.path).filter((p) => !exclude.has(p));
  if (paths.length === 0) return undefined;
  let body = "";
  let truncatedAt = 0;
  for (const [i, p] of paths.entries()) {
    const next = body + `- ${p}\n`;
    if (estimateTokens(next) > ctx.caps.memoryKeys) {
      truncatedAt = paths.length - i;
      break;
    }
    body = next;
  }
  if (truncatedAt > 0) body += `…and ${truncatedAt} more (search with the memory tool)\n`;
  return body.trimEnd();
}

/**
 * Cache key capturing every input that can change the appendix. statSync (no
 * read) detects edits to the two MEMORY.md files; (count, max last_indexed_at)
 * over memory_fts detects any add/prune/reindex that the keys index would show.
 * MAX is monotonic (reconcile stamps Date.now()), so it catches an add+prune
 * that nets a zero count delta. Errs toward over-invalidation: an unrelated cc
 * file change rebuilds an identical string — wasteful, never stale.
 */
function appendixCacheKey(state: InjectState, ctx: InjectContext): string {
  const statKey = (p: string): string => {
    try {
      const s = fs.statSync(p, { bigint: true });
      return `${s.size}-${s.mtimeNs}`;
    } catch {
      return "-"; // absent ⇒ section omitted; distinct from any real stat
    }
  };
  const agg = state.aggStmt.get() as { n: number; mx: number };
  return [
    ctx.root,
    ctx.sid,
    ctx.pid,
    ctx.caps.memory,
    ctx.caps.global,
    ctx.caps.memoryKeys,
    statKey(projectMemoryPath(ctx.pid, ctx.root)),
    statKey(globalMemoryPath(ctx.root)),
    agg.n,
    String(agg.mx),
  ].join("|");
}

/**
 * Per-turn system prompt appendix. Stable across turns ⇒ prompt cache stays
 * warm; cached on the (file stats + index state) key so the synchronous file
 * reads + keys query only re-run when memory actually changed, not every turn.
 */
export function buildSystemPromptAppendix(db: DatabaseSync, ctx: InjectContext): string {
  const state = stateFor(db);
  const key = appendixCacheKey(state, ctx);
  if (state.appendix?.key === key) return state.appendix.value;

  const sections: string[] = [buildMemoryInstructions(ctx)];
  const dumped = new Set<string>();
  const projectPath = projectMemoryPath(ctx.pid, ctx.root);
  const project = budgetedRead(projectPath, ctx.caps.memory);
  if (project !== undefined) {
    dumped.add(projectPath);
    sections.push(`## Project memory\n\n${project.trimEnd()}`);
  }
  const globalPath = globalMemoryPath(ctx.root);
  const global = budgetedRead(globalPath, ctx.caps.global);
  if (global !== undefined) {
    dumped.add(globalPath);
    sections.push(`## Global memory\n\n${global.trimEnd()}`);
  }
  const keys = memoryKeysIndex(db, ctx, dumped);
  if (keys !== undefined) {
    sections.push(`## Memory keys index\n\n${keys}`);
  }
  const value = sections.join("\n\n");
  state.appendix = { key, value };
  return value;
}

/** True when the checkpoint file has no real content beyond the template. */
export function isCheckpointEmpty(text: string | undefined): boolean {
  if (text === undefined) return true;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (
      t === "" ||
      t === "(none yet)" ||
      t === "(none)" ||
      t === "(no task registry)" ||
      t === "(no subagents this session)" ||
      t === "(no tasks or subagents this session)" ||
      t === "(no tasks this session)"
    )
      continue;
    if (t.startsWith("#")) continue;
    if (t.startsWith("_") && t.endsWith("_")) continue;
    return false;
  }
  return true;
}

/**
 * One-shot rebuild dump (resume / fork / post-compaction). Project and global
 * memory are NOT here — they ride in the system prompt every turn.
 */
export function buildRebuildDump(
  db: DatabaseSync,
  ctx: InjectContext,
  taskTree?: string,
): string | undefined {
  const cpPath = checkpointPath(ctx.sid, ctx.root);
  let checkpointRaw: string | undefined;
  try {
    checkpointRaw = fs.readFileSync(cpPath, "utf8");
  } catch {
    checkpointRaw = undefined;
  }
  if (isCheckpointEmpty(checkpointRaw)) return undefined;
  const sections: string[] = [
    "This session is being continued from a previous conversation. Summary of previous conversation from checkpoint files:",
  ];
  const dumped = new Set<string>([cpPath]);
  sections.push(`## Session checkpoint\n\n${budgetText(checkpointRaw!, ctx.caps.checkpoint, cpPath).trimEnd()}`);
  const nPath = notesPath(ctx.sid, ctx.root);
  const notes = budgetedRead(nPath, ctx.caps.notes);
  if (notes !== undefined) {
    dumped.add(nPath);
    sections.push(`## Session notes\n\n${notes.trimEnd()}`);
  }
  // Open tasks (plan §7). The still-actionable slice of the @juicesharp/rpiv-todo
  // task graph (in_progress + pending), rendered by the caller from the live
  // branch snapshot — the broader frame, so it sits above the subagents. Empty
  // string ⇒ rpiv-todo absent / no open tasks ⇒ section omitted.
  if (taskTree && taskTree.trim()) sections.push(`## Open tasks\n\n${taskTree.trim()}`);
  // In-flight subagents (Phase 2). Non-terminal actors only — on a same-process
  // compaction these are genuinely still running; on a cross-process resume the
  // ledger reaps stale rows at session_start, so this is empty and omitted.
  const actors = buildActiveActorsSection(db, ctx.sid, ctx.caps.actors);
  if (actors !== undefined) sections.push(`## Active actors\n\n${actors}`);
  const keys = memoryKeysIndex(db, ctx, dumped);
  if (keys !== undefined) sections.push(`## Memory keys index\n\n${keys}`);
  sections.push(
    "Resume directly. Do not acknowledge this memory dump, do not recap — continue the work as if the conversation had never been interrupted.",
  );
  return sections.join("\n\n");
}
