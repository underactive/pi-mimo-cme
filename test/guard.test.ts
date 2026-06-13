import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { checkMemoryWrite } from "../src/guard.ts";

const ROOT = "/tmp/mem-root";
const SID = "ses_current";
const PID = "abc123def456";

function verdict(target: string) {
  return checkMemoryWrite(ROOT, SID, PID, target, "/work/project");
}

test("guard allows the only two legal targets", () => {
  assert.equal(verdict(path.join(ROOT, "sessions", SID, "notes.md")).allowed, true);
  assert.equal(verdict(path.join(ROOT, "projects", PID, "MEMORY.md")).allowed, true);
});

test("guard blocks checkpoint.md and spillovers (writer's domain)", () => {
  const cp = verdict(path.join(ROOT, "sessions", SID, "checkpoint.md"));
  assert.equal(cp.allowed, false);
  assert.match(cp.reason!, /checkpoint writer's domain/);
  const spill = verdict(path.join(ROOT, "sessions", SID, "checkpoint-topic.md"));
  assert.equal(spill.allowed, false);
});

test("guard blocks global memory", () => {
  const v = verdict(path.join(ROOT, "global", "MEMORY.md"));
  assert.equal(v.allowed, false);
  assert.match(v.reason!, /read-only|dream/);
});

test("guard blocks other sessions and other projects", () => {
  assert.equal(verdict(path.join(ROOT, "sessions", "ses_other", "notes.md")).allowed, false);
  assert.equal(verdict(path.join(ROOT, "projects", "fff000fff000", "MEMORY.md")).allowed, false);
});

test("guard blocks ad-hoc memory files with the notes.md rule", () => {
  for (const bad of ["learning.md", "scratch.md", "extra-notes.md"]) {
    const v = verdict(path.join(ROOT, "sessions", SID, bad));
    assert.equal(v.allowed, false, bad);
    assert.match(v.reason!, /notes\.md/);
  }
  assert.equal(verdict(path.join(ROOT, "random.md")).allowed, false);
});

test("guard allows anything outside the memory root", () => {
  assert.equal(verdict("/work/project/src/app.ts").allowed, true);
  assert.equal(verdict("/tmp/mem-root-sibling/file.md").allowed, true);
  // Relative paths resolve against cwd, landing outside the root.
  assert.equal(verdict("src/index.ts").allowed, true);
});

test("guard resolves traversal attempts", () => {
  const sneaky = path.join(ROOT, "sessions", SID, "..", "..", "global", "MEMORY.md");
  assert.equal(verdict(sneaky).allowed, false);
});
