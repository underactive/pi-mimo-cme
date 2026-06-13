import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildSystemPromptAppendix, type InjectContext } from "../src/inject.ts";
import { reconcile } from "../src/reconcile.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-inj-"));
}

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

test("buildSystemPromptAppendix caches but never serves a stale prompt", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  const pid = "abc123";
  write(root, `projects/${pid}/MEMORY.md`, "alpha rule");
  write(root, "global/MEMORY.md", "global pref");
  reconcile(db, { root });
  const ctx: InjectContext = { root, sid: "s1", pid, caps: DEFAULT_CONFIG.checkpoint.pushCaps };

  const a1 = buildSystemPromptAppendix(db, ctx);
  assert.match(a1, /alpha rule/);
  // Cache hit on unchanged inputs returns an identical appendix.
  assert.equal(buildSystemPromptAppendix(db, ctx), a1);

  // Editing project memory changes its stat → key changes → must NOT serve stale.
  write(root, `projects/${pid}/MEMORY.md`, "omega rule replaces alpha entirely now");
  const a2 = buildSystemPromptAppendix(db, ctx);
  assert.match(a2, /omega rule/);
  assert.doesNotMatch(a2, /alpha rule/, "stale project memory must not survive an edit");

  // Indexing a new file changes memory_fts (count, max) → keys index grows.
  write(root, "sessions/s1/notes.md", "note body");
  reconcile(db, { root });
  const a3 = buildSystemPromptAppendix(db, ctx);
  assert.match(a3, /notes\.md/, "keys index must reflect a newly indexed file");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
