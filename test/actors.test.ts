import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  ActorLedger,
  buildActiveActorsSection,
  buildSubagentProgress,
  renderProgressJournal,
} from "../src/actors.ts";
import { openDb } from "../src/db.ts";
import { progressPath } from "../src/paths.ts";

function setup(): { root: string; db: ReturnType<typeof openDb>; clock: () => number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-actors-"));
  const db = openDb(":memory:");
  let t = 1000;
  return { root, db, clock: () => t++ };
}

function actorRow(db: ReturnType<typeof openDb>, sid: string, id: string) {
  return db.prepare("SELECT * FROM actor WHERE session_id = ? AND id = ?").get(sid, id) as
    | Record<string, unknown>
    | undefined;
}

test("ActorLedger: created→running→completed lifecycle updates status, active count, journal", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });

  ledger.record("created", "s1", "p1", { id: "a1", type: "general-purpose", description: "find bugs" });
  assert.equal(ledger.activeCount("s1"), 1);
  assert.equal(actorRow(db, "s1", "a1")!.status, "created");

  ledger.record("started", "s1", "p1", { id: "a1", type: "general-purpose", description: "find bugs" });
  assert.equal(ledger.activeCount("s1"), 1, "same actor started → still one active");
  assert.equal(actorRow(db, "s1", "a1")!.status, "running");

  const file = ledger.record("completed", "s1", "p1", {
    id: "a1",
    result: "found 3 bugs",
    tokens: 1234,
    toolUses: 5,
    durationMs: 9000,
  });
  assert.equal(ledger.activeCount("s1"), 0, "completed → no longer active");
  const row = actorRow(db, "s1", "a1")!;
  assert.equal(row.status, "completed");
  assert.equal(row.tokens, 1234);
  assert.equal(row.tool_uses, 5);
  assert.equal(row.result_summary, "found 3 bugs");
  assert.ok(typeof row.completed_at === "number");

  // The journal was written under tasks/<id>/progress.md and carries the payload.
  assert.equal(file, progressPath("s1", "a1", root));
  const journal = fs.readFileSync(file!, "utf8");
  assert.match(journal, /# Subagent progress — a1/);
  assert.match(journal, /general-purpose/);
  assert.match(journal, /find bugs/);
  assert.match(journal, /found 3 bugs/);
  assert.match(journal, /completed/);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("ActorLedger: failed records error status and an error journal", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });
  ledger.record("created", "s1", "p1", { id: "a2", type: "explore" });
  const file = ledger.record("failed", "s1", "p1", { id: "a2", error: "boom out of memory" });
  const row = actorRow(db, "s1", "a2")!;
  assert.equal(row.status, "error");
  assert.equal(row.error, "boom out of memory");
  assert.equal(ledger.activeCount("s1"), 0);
  assert.match(fs.readFileSync(file!, "utf8"), /boom out of memory/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("ActorLedger: compacted bumps counters without changing status or active count", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });
  ledger.record("created", "s1", "p1", { id: "a3" });
  const ret = ledger.record("compacted", "s1", "p1", { id: "a3", tokensBefore: 500, compactionCount: 2 });
  assert.equal(ret, undefined, "compacted writes no journal");
  const row = actorRow(db, "s1", "a3")!;
  assert.equal(row.status, "created", "compaction does not end the run");
  assert.equal(row.compaction_count, 2);
  assert.equal(row.tokens, 500);
  assert.equal(ledger.activeCount("s1"), 1);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("ActorLedger: blank or missing actor id is ignored", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });
  assert.equal(ledger.record("completed", "s1", "p1", { id: "" }), undefined);
  assert.equal(ledger.record("created", "s1", "p1", {}), undefined);
  const n = db.prepare("SELECT COUNT(*) AS n FROM actor").get() as { n: number };
  assert.equal(n.n, 0);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("ActorLedger: reapStale marks non-terminal actors stopped and clears the live count", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });
  ledger.record("created", "s1", "p1", { id: "a4" });
  ledger.record("started", "s1", "p1", { id: "a5" });
  ledger.record("completed", "s1", "p1", { id: "a6", result: "ok" });
  assert.equal(ledger.activeCount("s1"), 2);

  const reaped = ledger.reapStale("s1");
  assert.equal(reaped, 2, "only the two non-terminal actors are reaped");
  assert.equal(ledger.activeCount("s1"), 0);
  assert.equal(actorRow(db, "s1", "a4")!.status, "stopped");
  assert.equal(actorRow(db, "s1", "a5")!.status, "stopped");
  assert.equal(actorRow(db, "s1", "a6")!.status, "completed", "terminal actor untouched");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("buildSubagentProgress: newest-first lines, empty string when none, caps the tail", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });
  assert.equal(buildSubagentProgress(db, "s1", 2000), "", "no actors → empty block");

  ledger.record("completed", "s1", "p1", { id: "first", type: "explore", result: "did A", tokens: 10, toolUses: 1 });
  ledger.record("completed", "s1", "p1", { id: "second", type: "general-purpose", result: "did B" });
  const block = buildSubagentProgress(db, "s1", 2000);
  const lines = block.split("\n");
  assert.match(lines[0]!, /^- second · general-purpose · completed — did B/, "newest first");
  assert.match(block, /- first · explore · completed — did A.*tokens: 10, tools: 1/s);

  // A tiny cap drops the tail with a marker rather than overflowing.
  const capped = buildSubagentProgress(db, "s1", 5);
  assert.match(capped, /…and \d+ more/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("buildActiveActorsSection: only non-terminal actors, undefined when none", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });
  ledger.record("started", "s1", "p1", { id: "live", type: "explore", description: "still working" });
  ledger.record("completed", "s1", "p1", { id: "done", result: "finished" });

  const section = buildActiveActorsSection(db, "s1", 2000);
  assert.ok(section !== undefined);
  assert.match(section!, /- live · explore · running — still working/);
  assert.doesNotMatch(section!, /done/, "completed actors are not 'active'");

  // Once the live one finishes, the section disappears entirely.
  ledger.record("completed", "s1", "p1", { id: "live", result: "wrapped up" });
  assert.equal(buildActiveActorsSection(db, "s1", 2000), undefined);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("renderProgressJournal: defensive against non-string payload fields", () => {
  // Numbers/objects where strings are expected must not throw and must degrade
  // to placeholders — the payload crosses an extension boundary.
  const journal = renderProgressJournal(
    "weird",
    { id: "weird", result: 123 as unknown, type: {} as unknown, toolUses: "x" as unknown },
    "completed",
    "2026-06-13T00:00:00.000Z",
  );
  assert.match(journal, /# Subagent progress — weird/);
  assert.match(journal, /\(no result text\)/);
  assert.match(journal, /Tool uses:\*\* 0/);
});

test("ActorLedger: actor ledger is isolated per session id", () => {
  const { root, db, clock } = setup();
  const ledger = new ActorLedger({ db, root, now: clock });
  ledger.record("started", "sA", "p1", { id: "x" });
  ledger.record("started", "sB", "p1", { id: "x" }); // same actor id, different session
  assert.equal(ledger.activeCount("sA"), 1);
  assert.equal(ledger.activeCount("sB"), 1);
  assert.match(buildSubagentProgress(db, "sA", 2000), /- x ·/);
  assert.equal(buildSubagentProgress(db, "sC", 2000), "");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
