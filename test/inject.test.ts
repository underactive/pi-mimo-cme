import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ActorLedger } from "../src/actors.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import {
  buildRebuildDump,
  buildSystemPromptAppendix,
  isCheckpointEmpty,
  type InjectContext,
} from "../src/inject.ts";
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

test("buildRebuildDump surfaces in-flight actors under ## Active actors", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  const pid = "abc123";
  // A real checkpoint, so the dump isn't skipped as empty.
  write(root, "sessions/s1/checkpoint.md", '# Session checkpoint\n\n## §1 Active intent\n> "do the thing"\n');
  const ledger = new ActorLedger({ db, root });
  ledger.record("started", "s1", pid, { id: "live1", type: "explore", description: "scanning the tree" });
  ledger.record("completed", "s1", pid, { id: "done1", result: "finished" });

  const ctx: InjectContext = { root, sid: "s1", pid, caps: DEFAULT_CONFIG.checkpoint.pushCaps };
  const dump = buildRebuildDump(db, ctx)!;
  assert.match(dump, /## Active actors/);
  assert.match(dump, /live1 · explore · running — scanning the tree/);
  assert.doesNotMatch(dump, /done1/, "completed actors are not in-flight");

  // With no in-flight actors the section is omitted entirely.
  ledger.record("completed", "s1", pid, { id: "live1", result: "done now" });
  assert.doesNotMatch(buildRebuildDump(db, ctx)!, /## Active actors/);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("isCheckpointEmpty treats the §4 subagents placeholder as empty", () => {
  assert.equal(isCheckpointEmpty(undefined), true);
  assert.equal(
    isCheckpointEmpty("# Session checkpoint\n\n## §4 Subagents\n(no subagents this session)\n"),
    true,
  );
  assert.equal(
    isCheckpointEmpty('## §1 Active intent\n> "real intent"\n'),
    false,
  );
});
