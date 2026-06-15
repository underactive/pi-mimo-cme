import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { describeClearPlan, executeClear, planClear } from "../src/clear.ts";
import { metaSet, openDb, recordValidation, recordWriterMetrics } from "../src/db.ts";
import { projectId } from "../src/paths.ts";
import { reconcile } from "../src/reconcile.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-clear-"));
}

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function insertHistory(
  db: ReturnType<typeof openDb>,
  sid: string,
  pid: string,
  seq: number,
  body: string,
): void {
  db.prepare(
    "INSERT INTO history_fts (session_id, project_id, seq, kind, body, time_created) VALUES (?, ?, ?, 'message', ?, ?)",
  ).run(sid, pid, seq, body, 1000 + seq);
}

function insertActor(db: ReturnType<typeof openDb>, sid: string, pid: string, id: string): void {
  db.prepare(
    "INSERT INTO actor (session_id, id, project_id, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', 1, 1)",
  ).run(sid, id, pid);
}

const CWD_A = "/work/project-a";
const CWD_B = "/work/project-b";

test("planClear scopes to one project; executeClear moves files to trash and deletes derived rows", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  const pidA = projectId(CWD_A);
  const pidB = projectId(CWD_B);
  const sidCurrent = "sess-current";
  const sidPast = "sess-past";
  const sidOther = "sess-other-project";

  // Curated + session files on disk.
  write(root, "global/MEMORY.md", "shared global rule survives");
  write(root, `projects/${pidA}/MEMORY.md`, "project A curated zebraprojectA token");
  write(root, `projects/${pidB}/MEMORY.md`, "project B curated survives");
  write(root, `sessions/${sidCurrent}/checkpoint.md`, "current session checkpoint survives");
  write(root, `sessions/${sidPast}/checkpoint.md`, "past session A checkpoint");
  write(root, `sessions/${sidOther}/checkpoint.md`, "project B session survives");
  reconcile(db, { root });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n, 6);

  // Derived DB rows: project A spread across current + past sessions; project B separate.
  insertHistory(db, sidPast, pidA, 1, "past A history row");
  insertHistory(db, sidCurrent, pidA, 1, "current session A history row");
  insertHistory(db, sidOther, pidB, 1, "project B history row");
  insertActor(db, sidPast, pidA, "actor-1");
  recordWriterMetrics(db, {
    sessionId: sidPast, projectId: pidA, ts: 1, ok: true, input: 10, output: 5, cacheRead: 0,
    cacheWrite: 0, total: 15, costUsd: 0.01, deltaChars: 0, deltaTokensEst: 0, parentTokens: null,
    parentContextWindow: 0, messageCount: 1, durationMs: 1,
  });
  recordValidation(db, {
    sessionId: sidPast, projectId: pidA, ts: 1, nError: 0, nExtract: 0, nWarn: 0, codes: "",
    maxSectionOverrunPct: 0, endedValid: true,
  });
  metaSet(db, `last_dream_at:${pidA}`, "111");
  metaSet(db, `last_distill_at:${pidA}`, "222");
  metaSet(db, `last_dream_at:${pidB}`, "333");

  const plan = planClear(db, CWD_A, { root, currentSessionId: sidCurrent });
  // Past session is wiped; current session is excluded.
  assert.deepEqual(plan.sessionDirs.map((s) => s.sid), [sidPast]);
  assert.equal(plan.skippedCrossProject.length, 0);
  assert.equal(plan.counts.memoryProjectRows, 1); // projects/<pidA>/MEMORY.md
  assert.equal(plan.counts.memorySessionRows, 1); // sessions/<sidPast>/checkpoint.md only
  assert.equal(plan.counts.history, 1); // sidPast only — current session excluded
  assert.equal(plan.counts.actor, 1);
  assert.equal(plan.counts.writerMetrics, 1);
  assert.equal(plan.counts.validations, 1);
  assert.equal(plan.counts.metaKeys, 2); // pidA dream + distill, NOT pidB
  assert.equal(plan.empty, false);

  const result = executeClear(db, plan, { root, currentSessionId: sidCurrent, now: 12345 });
  assert.equal(result.movedDirs, 2); // projects/<pidA> + sessions/<sidPast>
  assert.equal(result.deletedRows, 1 + 1 + 1 + 1 + 1 + 1 + 2);

  // Files: project A + past session moved to trash; everything else stays put.
  const trash = path.join(root, "trash", `${pidA}-12345`);
  assert.ok(fs.existsSync(path.join(trash, "projects", pidA, "MEMORY.md")));
  assert.ok(fs.existsSync(path.join(trash, "sessions", sidPast, "checkpoint.md")));
  assert.ok(!fs.existsSync(path.join(root, "projects", pidA)));
  assert.ok(!fs.existsSync(path.join(root, "sessions", sidPast)));
  assert.ok(fs.existsSync(path.join(root, "projects", pidB, "MEMORY.md")));
  assert.ok(fs.existsSync(path.join(root, "global", "MEMORY.md")));
  assert.ok(fs.existsSync(path.join(root, "sessions", sidCurrent, "checkpoint.md")));
  assert.ok(fs.existsSync(path.join(root, "sessions", sidOther, "checkpoint.md")));

  // DB: project A's derived rows gone; project B + current session intact.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE scope='projects' AND scope_id=?").get(pidA) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE scope='projects' AND scope_id=?").get(pidB) as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history_fts WHERE project_id=?").get(pidA) as { n: number }).n, 1); // current session's row survives
  assert.equal((db.prepare("SELECT session_id FROM history_fts WHERE project_id=?").get(pidA) as { session_id: string }).session_id, sidCurrent);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history_fts WHERE project_id=?").get(pidB) as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actor WHERE project_id=?").get(pidA) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE '%:'||?").get(pidA) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE '%:'||?").get(pidB) as { n: number }).n, 1);

  // FTS5 war story: the deleted project's tokens must be purged from the shadow
  // vtab (plain DELETE → AFTER DELETE 'delete' trigger), not left dangling.
  const ghost = db
    .prepare(`SELECT memory_fts.id FROM memory_fts_idx JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid WHERE memory_fts_idx MATCH '"zebraprojectA"'`)
    .all();
  assert.equal(ghost.length, 0, "deleted project's FTS tokens must be gone");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("planClear leaves a session that is also tagged to another project untouched", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  const pidA = projectId(CWD_A);
  const pidB = projectId(CWD_B);
  const sidShared = "sess-shared";
  write(root, `sessions/${sidShared}/checkpoint.md`, "ambiguous session");
  reconcile(db, { root });
  // Same sid attributed to BOTH projects (defensive guard territory).
  insertHistory(db, sidShared, pidA, 1, "row for A");
  insertHistory(db, sidShared, pidB, 2, "row for B");

  const plan = planClear(db, CWD_A, { root, currentSessionId: "sess-live" });
  assert.deepEqual(plan.skippedCrossProject, [sidShared]);
  assert.equal(plan.sessionDirs.length, 0); // not wiped
  assert.equal(plan.counts.memorySessionRows, 0);

  executeClear(db, plan, { root, currentSessionId: "sess-live", now: 1 });
  assert.ok(fs.existsSync(path.join(root, "sessions", sidShared, "checkpoint.md")), "shared session survives");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("planClear reports empty when the project has no memory", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  const plan = planClear(db, "/work/never-touched", { root, currentSessionId: "s" });
  assert.equal(plan.empty, true);
  assert.equal(plan.counts.history, 0);
  assert.ok(describeClearPlan(plan).includes("nothing has been removed yet"));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
