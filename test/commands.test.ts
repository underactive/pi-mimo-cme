import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { metricsText, reconcileAndNotify, type CommandDeps } from "../src/commands.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { openDb, recordWriterMetrics, type WriterMetricsRow } from "../src/db.ts";
import { projectId } from "../src/paths.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cmd-"));
}

function metricsRow(pid: string, over: Partial<WriterMetricsRow>): WriterMetricsRow {
  return {
    sessionId: "s",
    projectId: pid,
    ts: 1,
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
  };
}

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

test("reconcileAndNotify debounces the tree walk within a session", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  write(root, "global/MEMORY.md", "first body");
  const config = structuredClone(DEFAULT_CONFIG);
  config.checkpoint.reconcileDebounceMs = 10_000;
  const deps: CommandDeps = { db, root, config };
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n;

  // First search of the session always reconciles, regardless of the window.
  reconcileAndNotify(deps);
  assert.equal(count(), 1);

  // A new file appears; a second search fires immediately → debounced, walk skipped.
  write(root, "global/OTHER.md", "second body");
  reconcileAndNotify(deps);
  assert.equal(count(), 1, "second search within the window must skip the tree walk");

  // window=0 disables debouncing → the pending file is picked up.
  config.checkpoint.reconcileDebounceMs = 0;
  reconcileAndNotify(deps);
  assert.equal(count(), 2, "window=0 disables debounce → new file indexed");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("metricsText: empty readout, then the fork-LOSES verdict when parent ctx dwarfs writer input", () => {
  const root = tempRoot();
  const cwd = "/some/project/dir";
  const pid = projectId(cwd);
  const db = openDb(":memory:");
  const deps: CommandDeps = { db, root, config: structuredClone(DEFAULT_CONFIG) };

  assert.match(metricsText(deps, cwd), /no checkpoint-writer runs recorded yet/);

  // parent*0.1 (=10,000) > full-price writer input (1,000) → fork loses even best case.
  recordWriterMetrics(db, metricsRow(pid, { input: 1000, parentTokens: 100_000 }));
  const loses = metricsText(deps, cwd);
  assert.match(loses, /fork LOSES even best case/);
  assert.match(loses, /not worth building/);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("metricsText: fork-MIGHT-help verdict when the parent context is small", () => {
  const root = tempRoot();
  const cwd = "/tiny/ctx/project";
  const pid = projectId(cwd);
  const db = openDb(":memory:");
  const deps: CommandDeps = { db, root, config: structuredClone(DEFAULT_CONFIG) };

  // parent*0.1 (=5,000) < full-price writer input (10,000) → worth deeper measurement.
  recordWriterMetrics(db, metricsRow(pid, { input: 10_000, parentTokens: 50_000 }));
  assert.match(metricsText(deps, cwd), /fork MIGHT help/);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("reconcileAndNotify fires the notify toast only when rows changed", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  write(root, "global/MEMORY.md", "body");
  const config = structuredClone(DEFAULT_CONFIG);
  config.checkpoint.reconcileDebounceMs = 0; // exercise the reconcile every call
  const toasts: string[] = [];
  const deps: CommandDeps = { db, root, config, notify: (m) => toasts.push(m) };

  reconcileAndNotify(deps); // indexes 1 → toast
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /1 indexed/);

  reconcileAndNotify(deps); // nothing changed on disk → no toast
  assert.equal(toasts.length, 1, "unchanged tree must stay quiet");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
