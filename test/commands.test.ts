import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { reconcileAndNotify, type CommandDeps } from "../src/commands.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { openDb } from "../src/db.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cmd-"));
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
