/**
 * /memory clear — wipe ONE project's memory. Pure module (no pi imports) so it
 * runs under plain `node --test`, mirroring reconcile.ts / paths.ts.
 *
 * Two-phase by design: planClear() computes exactly what would go (a dry-run the
 * command previews), executeClear() performs it. Splitting them lets the command
 * show the user the blast radius and get a confirm BEFORE anything is destroyed.
 *
 * What gets cleared (scope = "this project", pid = sha256(cwd)[:12]):
 *   - curated files:  projects/<pid>/**            → MOVED to trash (recoverable)
 *   - linked sessions: sessions/<sid>/**           → MOVED to trash (recoverable)
 *   - derived DB rows tagged project_id=<pid>      → DELETED (rebuildable index)
 *   - session-scoped memory_fts rows for those sids → DELETED
 *   - dream/distill timestamps in `meta`           → DELETED
 *
 * Deliberately NOT touched (see the command's preview text):
 *   - global/  and the cc (Claude Code) index       — shared / external
 *   - pi's own session transcripts under ~/.pi/agent — pi's data, not ours
 *   - the CURRENT live session (excluded by session_id) — stays functional
 *   - sessions whose DB link was pruned — unattributable, so they survive
 *
 * Files move to trash rather than rm -rf because the curated projects/<pid> tree
 * is hand-written source-of-truth; the DB is a derived index that rebuilds from
 * files, so its rows are hard-deleted. Deletes use plain `DELETE FROM` so the
 * external-content FTS5 'delete' triggers (see db.ts) purge the shadow vtab.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { projectDir, projectId, sessionDir, trashDir } from "./paths.ts";

/** Tables carrying BOTH session_id and project_id — the only project↔session link. */
const TAGGED_TABLES = ["history_fts", "actor", "writer_metrics", "checkpoint_validations"] as const;

export interface ClearScopeOptions {
  root: string;
  /** The live session — excluded from the wipe so the current run keeps working. */
  currentSessionId: string;
  /** Wall-clock ms for the trash dir name; injected so tests stay deterministic. */
  now?: number;
}

export interface ClearCounts {
  /** memory_fts rows for projects/<pid> (scope='projects'). */
  memoryProjectRows: number;
  /** memory_fts rows for the wiped sessions (scope='sessions'). */
  memorySessionRows: number;
  history: number;
  actor: number;
  writerMetrics: number;
  validations: number;
  /** meta timestamp keys ending in :<pid> (last_dream_at / last_distill_at). */
  metaKeys: number;
}

export interface SessionTarget {
  sid: string;
  path: string;
  exists: boolean;
}

export interface ClearPlan {
  projectId: string;
  currentSessionId: string;
  projectDir: string;
  projectDirExists: boolean;
  /** Linked sessions to wipe (excludes current + cross-project), with disk presence. */
  sessionDirs: SessionTarget[];
  /** Linked to this project but ALSO tagged to another — left untouched, reported. */
  skippedCrossProject: string[];
  counts: ClearCounts;
  /** True ⇔ nothing on disk and zero rows to delete. */
  empty: boolean;
}

export interface ClearResult extends ClearPlan {
  /** Trash subdir the files were moved into, or null when no files existed. */
  trashPath: string | null;
  movedDirs: number;
  deletedRows: number;
}

function countRows(db: DatabaseSync, sql: string, params: (string | number)[] = []): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/**
 * Resolve which sessions belong to this project. The link only exists in the
 * project-tagged tables; a sid that ALSO appears under a different project_id is
 * treated as cross-project and left untouched (defensive — a pi session maps to
 * one cwd/project, so this should be empty, but a misattributed row must never
 * cause us to move another project's session files).
 */
function linkedSessionIds(db: DatabaseSync, pid: string): { linked: string[]; crossProject: string[] } {
  const linked = new Set<string>();
  for (const table of TAGGED_TABLES) {
    const rows = db
      .prepare(`SELECT DISTINCT session_id AS sid FROM ${table} WHERE project_id = ?`)
      .all(pid) as unknown as { sid: string }[];
    for (const r of rows) linked.add(r.sid);
  }
  const crossProject = new Set<string>();
  for (const table of TAGGED_TABLES) {
    const rows = db
      .prepare(`SELECT DISTINCT session_id AS sid FROM ${table} WHERE project_id <> ?`)
      .all(pid) as unknown as { sid: string }[];
    for (const r of rows) if (linked.has(r.sid)) crossProject.add(r.sid);
  }
  return { linked: [...linked], crossProject: [...crossProject] };
}

/** Dry-run: compute the exact blast radius without touching anything. */
export function planClear(db: DatabaseSync, cwd: string, opts: ClearScopeOptions): ClearPlan {
  const pid = projectId(cwd);
  const { root, currentSessionId } = opts;
  const { linked, crossProject } = linkedSessionIds(db, pid);
  const crossSet = new Set(crossProject);

  // Sessions we will wipe: linked, minus the current live session, minus any
  // cross-project sid. These drive both the file moves and the session-scoped
  // memory_fts deletes.
  const wipeSids = linked.filter((sid) => sid !== currentSessionId && !crossSet.has(sid));
  const sessionDirs: SessionTarget[] = wipeSids.map((sid) => {
    const dir = sessionDir(sid, root);
    return { sid, path: dir, exists: fs.existsSync(dir) };
  });

  const pdir = projectDir(pid, root);
  const memSessRows =
    wipeSids.length === 0
      ? 0
      : countRows(
          db,
          `SELECT COUNT(*) AS n FROM memory_fts WHERE scope = 'sessions' AND scope_id IN (${wipeSids
            .map(() => "?")
            .join(",")})`,
          wipeSids,
        );

  const counts: ClearCounts = {
    memoryProjectRows: countRows(
      db,
      "SELECT COUNT(*) AS n FROM memory_fts WHERE scope = 'projects' AND scope_id = ?",
      [pid],
    ),
    memorySessionRows: memSessRows,
    history: countRows(
      db,
      "SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ? AND session_id <> ?",
      [pid, currentSessionId],
    ),
    actor: countRows(db, "SELECT COUNT(*) AS n FROM actor WHERE project_id = ? AND session_id <> ?", [
      pid,
      currentSessionId,
    ]),
    writerMetrics: countRows(
      db,
      "SELECT COUNT(*) AS n FROM writer_metrics WHERE project_id = ? AND session_id <> ?",
      [pid, currentSessionId],
    ),
    validations: countRows(
      db,
      "SELECT COUNT(*) AS n FROM checkpoint_validations WHERE project_id = ? AND session_id <> ?",
      [pid, currentSessionId],
    ),
    metaKeys: countRows(db, "SELECT COUNT(*) AS n FROM meta WHERE key LIKE '%:' || ?", [pid]),
  };

  const projectDirExists = fs.existsSync(pdir);
  const anyFiles = projectDirExists || sessionDirs.some((s) => s.exists);
  const anyRows = Object.values(counts).some((n) => n > 0);

  return {
    projectId: pid,
    currentSessionId,
    projectDir: pdir,
    projectDirExists,
    sessionDirs,
    skippedCrossProject: crossProject,
    counts,
    empty: !anyFiles && !anyRows,
  };
}

/**
 * Execute a previously computed plan. DB deletes run first in one transaction
 * (atomic, and the precious files survive a crash mid-clear because they move
 * last); the index for any leftover file self-heals on the next reconcile.
 */
export function executeClear(db: DatabaseSync, plan: ClearPlan, opts: ClearScopeOptions): ClearResult {
  const pid = plan.projectId;
  const { root, currentSessionId } = opts;
  const wipeSids = plan.sessionDirs.map((s) => s.sid);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM memory_fts WHERE scope = 'projects' AND scope_id = ?").run(pid);
    if (wipeSids.length > 0) {
      db.prepare(
        `DELETE FROM memory_fts WHERE scope = 'sessions' AND scope_id IN (${wipeSids
          .map(() => "?")
          .join(",")})`,
      ).run(...wipeSids);
    }
    for (const table of TAGGED_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND session_id <> ?`).run(pid, currentSessionId);
    }
    db.prepare("DELETE FROM meta WHERE key LIKE '%:' || ?").run(pid);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Move curated/session files to trash (recoverable). Same filesystem as the
  // memory root, so renameSync is atomic and cheap. Provenance preserved by
  // mirroring the original projects/<pid> and sessions/<sid> layout under trash.
  const trashRoot = path.join(trashDir(root), `${pid}-${opts.now ?? Date.now()}`);
  let movedDirs = 0;
  const move = (from: string, toRel: string): void => {
    if (!fs.existsSync(from)) return;
    const to = path.join(trashRoot, toRel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    movedDirs += 1;
  };
  move(plan.projectDir, path.join("projects", pid));
  for (const s of plan.sessionDirs) move(s.path, path.join("sessions", s.sid));

  const deletedRows = Object.values(plan.counts).reduce((a, b) => a + b, 0);
  return {
    ...plan,
    trashPath: movedDirs > 0 ? trashRoot : null,
    movedDirs,
    deletedRows,
  };
}

/** Human-readable dry-run preview (shown before the confirm). */
export function describeClearPlan(plan: ClearPlan): string {
  const c = plan.counts;
  const onDisk = plan.sessionDirs.filter((s) => s.exists).length;
  const lines = [
    `mimo-cme: clear memory for project ${plan.projectId}`,
    `(current session ${plan.currentSessionId} is preserved)`,
    "",
    "Files → moved to trash:",
    `  projects/${plan.projectId}/        ${plan.projectDirExists ? "(curated memory)" : "(none on disk)"}`,
    `  ${plan.sessionDirs.length} linked session(s), ${onDisk} with files on disk`,
    "",
    "DB rows → deleted:",
    `  curated project index (memory_fts):   ${c.memoryProjectRows}`,
    `  session index (memory_fts):           ${c.memorySessionRows}`,
    `  conversation history (history_fts):   ${c.history}`,
    `  subagent ledger (actor):              ${c.actor}`,
    `  writer metrics:                       ${c.writerMetrics}`,
    `  checkpoint validations:               ${c.validations}`,
    `  dream/distill timestamps (meta):      ${c.metaKeys}`,
  ];
  if (plan.skippedCrossProject.length > 0) {
    lines.push(
      "",
      `Skipped ${plan.skippedCrossProject.length} session(s) also tagged to another project.`,
    );
  }
  lines.push(
    "",
    "Not touched: global memory, the Claude Code index, pi's own transcripts, the",
    "current session, and any session whose DB link was pruned (unattributable).",
    "",
    "This is a preview — nothing has been removed yet.",
  );
  return lines.join("\n");
}

/** Human-readable result summary (shown after execution). */
export function describeClearResult(result: ClearResult): string {
  return [
    `mimo-cme: project ${result.projectId} memory cleared.`,
    `  moved ${result.movedDirs} director(ies)${result.trashPath ? ` → ${result.trashPath}` : ""}`,
    `  deleted ${result.deletedRows} DB row(s)`,
    result.trashPath
      ? "Restore by moving the dirs back from trash; the index rebuilds on next search."
      : "No files were on disk; only derived DB rows were removed.",
  ].join("\n");
}
