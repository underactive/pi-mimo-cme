import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTaskTree, readTaskSnapshot, type TodoTask } from "../src/tasks.ts";

/** A branch `todo` tool-result message carrying a task snapshot in `details`. */
function todoResult(tasks: unknown[], nextId: number): unknown {
  return {
    role: "toolResult",
    toolName: "todo",
    content: [{ type: "text", text: "ok" }],
    details: { action: "update", params: {}, tasks, nextId },
  };
}

test("readTaskSnapshot: last-write-wins over the branch, coerces, skips non-todo", () => {
  const messages = [
    { role: "user", content: "go" },
    todoResult([{ id: 1, subject: "alpha", status: "pending" }], 2),
    { role: "assistant", content: [{ type: "text", text: "working" }] },
    { role: "toolResult", toolName: "read", details: { tasks: [], nextId: 9 } }, // not todo → ignored
    todoResult(
      [
        { id: 1, subject: "alpha", status: "in_progress", activeForm: "doing alpha" },
        { id: 2, subject: "beta", status: "pending", blockedBy: [1] },
      ],
      3,
    ),
  ];
  const snap = readTaskSnapshot(messages);
  assert.equal(snap.length, 2, "the LAST todo snapshot wins");
  assert.deepEqual(snap[0], {
    id: 1,
    subject: "alpha",
    status: "in_progress",
    activeForm: "doing alpha",
  } satisfies TodoTask);
  assert.deepEqual(snap[1]!.blockedBy, [1]);
});

test("readTaskSnapshot: empty when no todo results, robust to garbage details", () => {
  assert.deepEqual(readTaskSnapshot([]), []);
  assert.deepEqual(readTaskSnapshot([{ role: "user", content: "hi" }]), []);
  // Malformed details (no nextId / tasks not an array) are skipped silently.
  assert.deepEqual(
    readTaskSnapshot([{ role: "toolResult", toolName: "todo", details: { tasks: "nope" } }]),
    [],
  );
  // A bad task object inside an otherwise-valid snapshot is dropped, not fatal.
  assert.deepEqual(
    readTaskSnapshot([todoResult([{ id: "x", subject: "bad" }, { id: 5, subject: "good", status: "pending" }], 6)]),
    [{ id: 5, subject: "good", status: "pending" }],
  );
});

test("buildTaskTree: orders in_progress→pending→completed, renders deps/activeForm", () => {
  const tasks: TodoTask[] = [
    { id: 3, subject: "ship", status: "completed" },
    { id: 1, subject: "design", status: "pending", blockedBy: [3] },
    { id: 2, subject: "build", status: "in_progress", activeForm: "building it", owner: "me" },
    { id: 4, subject: "gone", status: "deleted" },
  ];
  const out = buildTaskTree(tasks, 2000);
  const lines = out.split("\n");
  assert.equal(lines.length, 3, "deleted task excluded");
  assert.match(lines[0]!, /^- \[in_progress\] #2 build \(building it\) @me$/);
  assert.match(lines[1]!, /^- \[pending\] #1 design ⛓ #3$/);
  assert.match(lines[2]!, /^- \[completed\] #3 ship$/);
});

test("buildTaskTree: openOnly drops completed/deleted; empty → empty string", () => {
  const tasks: TodoTask[] = [
    { id: 1, subject: "a", status: "completed" },
    { id: 2, subject: "b", status: "in_progress" },
    { id: 3, subject: "c", status: "deleted" },
  ];
  const open = buildTaskTree(tasks, 2000, { openOnly: true });
  assert.equal(open, "- [in_progress] #2 b");
  assert.equal(buildTaskTree([], 2000), "", "no tasks → empty");
  assert.equal(
    buildTaskTree([{ id: 1, subject: "done", status: "completed" }], 2000, { openOnly: true }),
    "",
    "only-completed with openOnly → empty",
  );
});

test("buildTaskTree: caps the tail with a todo-tool hint", () => {
  const many: TodoTask[] = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    subject: `task number ${i + 1}`,
    status: "pending" as const,
  }));
  const capped = buildTaskTree(many, 5); // tiny budget forces a drop
  assert.match(capped, /…and \d+ more \(use the todo tool to list\)/);
});
