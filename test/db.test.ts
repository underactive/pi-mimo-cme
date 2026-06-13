import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openDb,
  recordWriterMetrics,
  writerMetricsSummary,
  type WriterMetricsRow,
} from "../src/db.ts";

const baseRow = (over: Partial<WriterMetricsRow>): WriterMetricsRow => ({
  sessionId: "s1",
  projectId: "p1",
  ts: 1000,
  ok: true,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  costUsd: 0,
  deltaChars: 0,
  deltaTokensEst: 0,
  parentTokens: null,
  parentContextWindow: 0,
  messageCount: 0,
  durationMs: 0,
  ...over,
});

test("openDb migrates to schema v3 with the writer_metrics table", () => {
  const db = openDb(":memory:");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, 3, "all migrations applied");
  const cols = (db.prepare("PRAGMA table_info(writer_metrics)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(cols.includes("writer_input"));
  assert.ok(cols.includes("cache_read"));
  assert.ok(cols.includes("parent_tokens"));
  db.close();
});

test("recordWriterMetrics + writerMetricsSummary average runs and ignore NULL parent_tokens", () => {
  const db = openDb(":memory:");
  recordWriterMetrics(db, baseRow({ input: 1000, total: 1500, parentTokens: 100_000, ok: true }));
  recordWriterMetrics(db, baseRow({ input: 3000, total: 4000, parentTokens: null, ok: false }));
  const sum = writerMetricsSummary(db);
  assert.equal(sum.n, 2);
  assert.equal(sum.okCount, 1);
  assert.equal(sum.avgInput, 2000); // (1000 + 3000) / 2
  assert.equal(sum.avgTotal, 2750);
  // AVG() skips the NULL parent row, so the average is over the single row that had one.
  assert.equal(sum.avgParentTokens, 100_000);
  db.close();
});

test("writerMetricsSummary scopes by project; empty scope yields zeros and null parent", () => {
  const db = openDb(":memory:");
  recordWriterMetrics(db, baseRow({ projectId: "pA", input: 500, parentTokens: 50_000 }));
  recordWriterMetrics(db, baseRow({ projectId: "pB", input: 9000, parentTokens: 90_000 }));
  const a = writerMetricsSummary(db, { projectId: "pA" });
  assert.equal(a.n, 1);
  assert.equal(a.avgInput, 500);
  assert.equal(a.avgParentTokens, 50_000);
  const none = writerMetricsSummary(db, { projectId: "nope" });
  assert.equal(none.n, 0);
  assert.equal(none.avgInput, 0);
  assert.equal(none.avgParentTokens, null);
  db.close();
});
