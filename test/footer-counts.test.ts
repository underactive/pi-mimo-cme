import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { FooterCounts } from "../src/footer-counts.ts";
import { HistoryIndexer } from "../src/history.ts";
import { reconcile } from "../src/reconcile.ts";

const DEFAULT_KINDS = ["user_text", "assistant_text", "tool_input", "tool_error"];

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-fc-"));
}

function write(root: string, rel: string, body: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const countHist = (db: ReturnType<typeof openDb>, pid: string): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ?").get(pid) as { n: number }).n;
const countMem = (db: ReturnType<typeof openDb>): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n;

test("projHist tracks indexMessage deltas and stays project-scoped", () => {
  const db = openDb(":memory:");
  const indexer = new HistoryIndexer(db, DEFAULT_KINDS);
  const counts = new FooterCounts();
  counts.seed(db, "p1"); // empty table → 0/0

  // Exactly the per-turn path: take indexMessage's return and addHistory it.
  for (const m of [
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "an answer" }] },
    { role: "user", content: "second question" },
  ]) {
    counts.addHistory(indexer.indexMessage("s1", "p1", m));
  }
  // Another project's rows must NOT move this session's cached count.
  indexer.indexMessage("s2", "p2", { role: "user", content: "other project" });

  assert.equal(counts.snapshot().projHist, countHist(db, "p1"));
  // Scoping proof: the cached count is p1's, strictly below the table total.
  assert.ok(
    (db.prepare("SELECT COUNT(*) AS n FROM history_fts").get() as { n: number }).n >
      counts.snapshot().projHist,
  );
  db.close();
});

test("reseedMemory matches COUNT(*) FROM memory_fts after reconcile adds and prunes", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  const counts = new FooterCounts();
  counts.seed(db, "p1"); // memIdx 0

  write(root, "global/MEMORY.md", "global body");
  write(root, "projects/abc/MEMORY.md", "project body");
  const sessionFile = write(root, "sessions/s1/checkpoint.md", "checkpoint body");

  reconcile(db, { root });
  counts.reseedMemory(db);
  assert.equal(counts.snapshot().memIdx, countMem(db));
  assert.equal(counts.snapshot().memIdx, 3);

  // Prune: vanished file → reconcile removes its row → reseed reflects it exactly.
  fs.rmSync(sessionFile);
  reconcile(db, { root });
  counts.reseedMemory(db);
  assert.equal(counts.snapshot().memIdx, countMem(db));
  assert.equal(counts.snapshot().memIdx, 2);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("seed → increments → reseed round-trips with no drift", () => {
  const db = openDb(":memory:");
  const indexer = new HistoryIndexer(db, DEFAULT_KINDS);
  const counts = new FooterCounts();
  counts.seed(db, "p1");

  let added = 0;
  added += indexer.indexMessage("s1", "p1", { role: "user", content: "one" });
  added += indexer.indexMessage("s1", "p1", {
    role: "assistant",
    content: [
      { type: "text", text: "two" },
      { type: "toolCall", id: "c", name: "read", arguments: { path: "/x" } },
    ],
  });
  counts.addHistory(added);

  // The running arithmetic must equal the authoritative reseed — this is the
  // guarantee that the hot-path increments never drift from the source of truth.
  const incremental = counts.snapshot().projHist;
  counts.reseedHistory(db, "p1");
  assert.equal(counts.snapshot().projHist, incremental);
  assert.equal(incremental, countHist(db, "p1"));
  // History ops never touch memIdx.
  assert.equal(counts.snapshot().memIdx, 0);

  db.close();
});
