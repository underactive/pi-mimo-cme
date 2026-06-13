import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import {
  applyScoreFloor,
  buildFtsQuery,
  buildHistoryFtsQuery,
  historyAround,
  historySearch,
  memorySearch,
} from "../src/fts.ts";

test("buildFtsQuery OR-joins phrase-quoted word runs", () => {
  assert.equal(buildFtsQuery("hello world"), '"hello" OR "world"');
});

test("buildFtsQuery survives punctuation-heavy input", () => {
  assert.equal(buildFtsQuery("foo.bar-baz! (qux)?"), '"foo" OR "bar" OR "baz" OR "qux"');
  assert.equal(buildFtsQuery('quote"injection" attempt'), '"quote" OR "injection" OR "attempt"');
});

test("buildFtsQuery handles CJK runs via \\p{L}", () => {
  const q = buildFtsQuery("中文测试 memory");
  assert.equal(q, '"中文测试" OR "memory"');
});

test("buildFtsQuery returns null for empty / punctuation-only input", () => {
  assert.equal(buildFtsQuery(""), null);
  assert.equal(buildFtsQuery("!!! ... ???"), null);
});

test("buildHistoryFtsQuery AND-joins", () => {
  assert.equal(buildHistoryFtsQuery("alpha beta"), '"alpha" AND "beta"');
  assert.equal(buildHistoryFtsQuery("---"), null);
});

test("applyScoreFloor keeps #1 always and drops below top*ratio", () => {
  const rows = [{ score: 10 }, { score: 5 }, { score: 1.6 }, { score: 1.4 }, { score: 0.1 }];
  const kept = applyScoreFloor(rows, 10, 0.15);
  assert.deepEqual(
    kept.map((r) => r.score),
    [10, 5, 1.6],
  );
});

test("applyScoreFloor: ratio 0 disables the floor; limit still applies", () => {
  const rows = [{ score: 10 }, { score: 0.01 }, { score: 0.001 }];
  assert.equal(applyScoreFloor(rows, 10, 0).length, 3);
  assert.equal(applyScoreFloor(rows, 2, 0).length, 2);
});

test("applyScoreFloor keeps top row even when all scores are tiny", () => {
  const rows = [{ score: 0.0001 }];
  assert.equal(applyScoreFloor(rows, 10, 0.15).length, 1);
});

test("memorySearch round-trip: snippet marks, scope filter, MATCH sanitization", () => {
  const db = openDb(":memory:");
  const insert = db.prepare(
    `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("/m/global/MEMORY.md", "global", "", "memory", "the user prefers tabs over spaces", "1-1", 1);
  insert.run("/m/projects/abc/MEMORY.md", "projects", "abc", "memory", "tabs are banned in this project", "1-1", 1);

  const hits = memorySearch(db, { query: "tabs!!!", limit: 10 });
  assert.equal(hits.length, 2);
  assert.ok(hits[0]!.snippet.includes("<<tabs>>"));

  const scoped = memorySearch(db, { query: "tabs", scope: "projects", scopeId: "abc" });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.path, "/m/projects/abc/MEMORY.md");

  // Punctuation-only query → no MATCH attempted, no throw.
  assert.deepEqual(memorySearch(db, { query: "?!" }), []);
  db.close();
});

test("historySearch ANDs tokens and respects filters + hard cap", () => {
  const db = openDb(":memory:");
  const insert = db.prepare(
    `INSERT INTO history_fts (session_id, project_id, seq, kind, tool_name, body, time_created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("s1", "p1", 1, "user_text", null, "deploy the staging cluster", 100);
  insert.run("s1", "p1", 2, "assistant_text", null, "deploying now", 200);
  insert.run("s2", "p2", 1, "user_text", null, "deploy the production cluster", 300);

  // AND semantics: both tokens required.
  const both = historySearch(db, { query: "deploy staging", projectId: "p1" });
  assert.equal(both.length, 1);
  assert.equal(both[0]!.message_id, "s1#1");

  // project scope (default) excludes p2.
  const proj = historySearch(db, { query: "deploy", projectId: "p1" });
  assert.deepEqual(proj.map((h) => h.session_id).sort(), ["s1"]);

  // global scope sees both projects.
  const glob = historySearch(db, { query: "deploy", projectId: "p1", scope: "global" });
  assert.equal(glob.length, 2);

  // kind filter.
  const kinds = historySearch(db, { query: "deploy", projectId: "p1", kinds: ["assistant_text"] });
  assert.equal(kinds.length, 0); // "deploying" != token "deploy"

  // limit is capped at 50.
  const capped = historySearch(db, { query: "deploy", projectId: "p1", scope: "global", limit: 999 });
  assert.ok(capped.length <= 50);
  db.close();
});

test("historyAround windows by seq within the anchor session", () => {
  const db = openDb(":memory:");
  const insert = db.prepare(
    `INSERT INTO history_fts (session_id, project_id, seq, kind, tool_name, body, time_created)
     VALUES (?, ?, ?, 'user_text', NULL, ?, ?)`,
  );
  for (let i = 1; i <= 20; i++) insert.run("s1", "p1", i, `row ${i}`, i);
  insert.run("s2", "p1", 10, "other session row", 999);

  const result = historyAround(db, "s1#10", 3, 3);
  assert.ok("rows" in result);
  assert.deepEqual(
    result.rows.map((r) => r.seq),
    [7, 8, 9, 10, 11, 12, 13],
  );
  assert.ok(result.rows.every((r) => r.session_id === "s1"));
  assert.equal(result.overflow, false);
  db.close();
});

test("historyAround caps output at 20KB with overflow flag", () => {
  const db = openDb(":memory:");
  const insert = db.prepare(
    `INSERT INTO history_fts (session_id, project_id, seq, kind, tool_name, body, time_created)
     VALUES (?, ?, ?, 'user_text', NULL, ?, ?)`,
  );
  for (let i = 1; i <= 10; i++) insert.run("s1", "p1", i, "x".repeat(6000), i);
  const result = historyAround(db, "s1#5", 4, 4);
  assert.ok("rows" in result);
  assert.equal(result.overflow, true);
  const total = result.rows.reduce((n, r) => n + r.body.length, 0);
  assert.ok(total <= 20_000);
  db.close();
});

test("historyAround rejects malformed message ids", () => {
  const db = openDb(":memory:");
  const result = historyAround(db, "not-a-message-id");
  assert.ok("error" in result);
  db.close();
});
