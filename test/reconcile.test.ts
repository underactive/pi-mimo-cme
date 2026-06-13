import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { ccTypeFromFrontmatter, reconcile } from "../src/reconcile.ts";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-rec-"));
}

function write(root: string, rel: string, body: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

test("reconcile indexes the tree with scope/scope_id/type and skips delta files", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  write(root, "global/MEMORY.md", "global rules body");
  write(root, "projects/abc123/MEMORY.md", "project body");
  write(root, "sessions/s1/checkpoint.md", "checkpoint body");
  write(root, "sessions/s1/notes.md", "notes body");
  write(root, "sessions/s1/delta-1.md", "raw conversation, must not be indexed");
  write(root, "sessions/s1/checkpoint-topic.md", "spillover body");

  const stats = reconcile(db, { root });
  assert.equal(stats.indexed, 5);
  // globalIndexed is the "promoted to global" count for the dream toast: of the
  // five files, only global/MEMORY.md lives in the global scope.
  assert.equal(stats.globalIndexed, 1);
  const rows = db
    .prepare("SELECT path, scope, scope_id, type FROM memory_fts ORDER BY path")
    .all() as unknown as { path: string; scope: string; scope_id: string; type: string }[];
  assert.equal(rows.length, 5);
  assert.ok(!rows.some((r) => r.path.endsWith("delta-1.md")));
  const byEnd = (suffix: string) => rows.find((r) => r.path.endsWith(suffix))!;
  assert.deepEqual(
    [byEnd("global/MEMORY.md").scope, byEnd("global/MEMORY.md").type],
    ["global", "memory"],
  );
  assert.deepEqual(
    [byEnd("projects/abc123/MEMORY.md").scope, byEnd("projects/abc123/MEMORY.md").scope_id],
    ["projects", "abc123"],
  );
  assert.equal(byEnd("sessions/s1/checkpoint.md").type, "checkpoint");
  assert.equal(byEnd("sessions/s1/checkpoint-topic.md").type, "checkpoint");
  assert.equal(byEnd("sessions/s1/notes.md").type, "notes");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("reconcile walks nested tasks/<id>/progress.md and types it 'progress'", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  write(root, "sessions/s1/tasks/a1/progress.md", "# Subagent progress — a1\n\nfound the zebra bug");

  const stats = reconcile(db, { root });
  assert.equal(stats.indexed, 1);
  const row = db
    .prepare("SELECT scope, scope_id, type FROM memory_fts WHERE path LIKE '%tasks/a1/progress.md'")
    .get() as { scope: string; scope_id: string; type: string };
  assert.deepEqual([row.scope, row.scope_id, row.type], ["sessions", "s1", "progress"]);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("reconcile re-indexes on fingerprint change and prunes vanished files", () => {
  const root = tempRoot();
  const db = openDb(":memory:");
  const file = write(root, "global/MEMORY.md", "original body");
  reconcile(db, { root });

  // Unchanged file → no reindex.
  assert.equal(reconcile(db, { root }).indexed, 0);

  // Changed file (size differs ⇒ fingerprint differs) → reindexed, FTS sees new body.
  fs.writeFileSync(file, "completely different searchable zebra content");
  const stats = reconcile(db, { root });
  assert.equal(stats.indexed, 1);
  const hit = db
    .prepare(
      `SELECT memory_fts.path FROM memory_fts_idx JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
       WHERE memory_fts_idx MATCH '"zebra"'`,
    )
    .all() as unknown as { path: string }[];
  assert.equal(hit.length, 1);
  const stale = db
    .prepare(
      `SELECT memory_fts.path FROM memory_fts_idx JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
       WHERE memory_fts_idx MATCH '"original"'`,
    )
    .all();
  assert.equal(stale.length, 0, "old tokens must be removed via the 'delete' trigger command");

  // Deleted file → row pruned, FTS empty.
  fs.rmSync(file);
  const pruned = reconcile(db, { root });
  assert.equal(pruned.removed, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n, 0);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("reconcile indexes cc scope with frontmatter type when enabled", () => {
  const root = tempRoot();
  const ccRoot = tempRoot();
  const db = openDb(":memory:");
  write(
    ccRoot,
    "my-project/memory/feedback-notes.md",
    "---\nmetadata:\n  type: feedback\n---\nuser said the api is slow",
  );
  reconcile(db, { root, ccIndex: true, ccRoot });
  const row = db.prepare("SELECT scope, scope_id, type FROM memory_fts").get() as {
    scope: string;
    scope_id: string;
    type: string;
  };
  // Spread: node:sqlite rows have a null prototype, which trips deepEqual.
  assert.deepEqual({ ...row }, { scope: "cc", scope_id: "my-project", type: "feedback" });

  // Disabled → not indexed.
  const db2 = openDb(":memory:");
  reconcile(db2, { root, ccIndex: false, ccRoot });
  assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n, 0);
  db.close();
  db2.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ccRoot, { recursive: true, force: true });
});

test("ccTypeFromFrontmatter reads the type across all frontmatter shapes", () => {
  // Block-nested metadata.type (the current cc convention) and top-level type.
  assert.equal(ccTypeFromFrontmatter("---\nmetadata:\n  type: reference\n---\nbody"), "reference");
  assert.equal(ccTypeFromFrontmatter("---\nname: x\ntype: project\n---\nbody"), "project");
  // Quoted value, with node_type + a trailing key (real files carry originSessionId).
  assert.equal(
    ccTypeFromFrontmatter('---\nmetadata:\n  node_type: memory\n  type: "user"\n  originSessionId: abc\n---\n'),
    "user",
  );
  // Inline-flow metadata — previously fell through to "free".
  assert.equal(ccTypeFromFrontmatter("---\nmetadata: { node_type: memory, type: feedback }\n---\n"), "feedback");
  // An earlier unrelated/invalid `type:` must NOT mask a valid metadata.type below it.
  assert.equal(
    ccTypeFromFrontmatter("---\nschema:\n  type: object\nmetadata:\n  type: project\n---\n"),
    "project",
  );
  // node_type alone is not a memory type — no false match.
  assert.equal(ccTypeFromFrontmatter("---\nmetadata:\n  node_type: memory\n---\n"), "free");
});

test("ccTypeFromFrontmatter falls back to free", () => {
  assert.equal(ccTypeFromFrontmatter("---\ntitle: x\n---\nbody"), "free");
  assert.equal(ccTypeFromFrontmatter("no frontmatter at all"), "free");
  assert.equal(ccTypeFromFrontmatter("---\nmetadata:\n  type: exotic\n---\n"), "free");
});
