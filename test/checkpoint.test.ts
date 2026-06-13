import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  CheckpointManager,
  DELTA_CAP,
  newlyCrossed,
  serializeDelta,
  type WriterRequest,
  type WriterResult,
} from "../src/checkpoint.ts";
import { openDb } from "../src/db.ts";

test("serializeDelta: role labels, condensed tool calls/results", () => {
  const out = serializeDelta([
    { role: "user", content: "fix the parser" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "On it." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/src/parser.ts" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "parser source here" }],
    },
    { role: "custom", customType: "x", content: "skip me" },
  ]);
  assert.ok(out.includes("### user\n\nfix the parser"));
  assert.ok(out.includes('tool(read): {"path":"/src/parser.ts"}'));
  assert.ok(out.includes("### tool result: read\n\nparser source here"));
  assert.ok(!out.includes("skip me"));
});

test("serializeDelta: tool inputs and results capped at 500 chars", () => {
  const out = serializeDelta([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c", name: "write", arguments: { content: "z".repeat(5000) } }],
    },
    {
      role: "toolResult",
      toolCallId: "c",
      toolName: "write",
      isError: true,
      content: [{ type: "text", text: "e".repeat(5000) }],
    },
  ]);
  const toolLine = out.split("\n").find((l) => l.startsWith("tool(write):"))!;
  assert.ok(toolLine.length <= "tool(write): ".length + 501);
  const errBlock = out.split("### tool result (error): write\n\n")[1]!;
  assert.ok(errBlock.split("\n")[0]!.length <= 501);
});

test("serializeDelta: whole file capped at ~100KB, head dropped, tail kept", () => {
  const messages = Array.from({ length: 600 }, (_, i) => ({
    role: "user",
    content: `message number ${i} ` + "filler ".repeat(60),
  }));
  const out = serializeDelta(messages);
  assert.ok(out.length <= DELTA_CAP + 200, `length was ${out.length}`);
  assert.ok(out.startsWith("[delta truncated:"));
  assert.ok(out.includes("message number 599"), "tail must be kept");
  assert.ok(!out.includes("message number 0 "), "head must be dropped");
});

test("newlyCrossed returns ascending uncrossed thresholds", () => {
  assert.deepEqual(newlyCrossed(45, [20, 40, 60, 80], new Set()), [20, 40]);
  assert.deepEqual(newlyCrossed(45, [20, 40, 60, 80], new Set([20])), [40]);
  assert.deepEqual(newlyCrossed(10, [20, 40, 60, 80], new Set()), []);
  assert.deepEqual(newlyCrossed(100, [80, 20], new Set()), [20, 80]);
});

test("CheckpointManager: fires once per threshold, inlines delta in prompt, advances seq on success", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cp-"));
  const root = path.join(agent, "pi-mimo-cme");
  const db = openDb(":memory:");
  const writerCalls: WriterRequest[] = [];
  let releaseWriter: (() => void) | undefined;
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20, 40],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async (req) => {
      writerCalls.push(req);
      await new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      return { ok: true } satisfies WriterResult;
    },
  });

  const messages = [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const fired = manager.maybeCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", percent: 25, messages });
  assert.equal(fired, true);

  // Same threshold again → no refire.
  assert.equal(
    manager.maybeCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", percent: 26, messages }),
    false,
  );

  // Templates exist while the writer runs; the delta is inlined, NOT written to a file.
  assert.ok(fs.existsSync(path.join(root, "sessions", "s1", "checkpoint.md")));
  assert.ok(fs.existsSync(path.join(root, "sessions", "s1", "notes.md")));
  assert.ok(fs.existsSync(path.join(root, "projects", "p1", "MEMORY.md")));
  assert.ok(!fs.existsSync(path.join(root, "sessions", "s1", "delta-1.md")), "no delta file written");

  // The writer ran once, with the project cwd and the serialized delta inlined in the prompt.
  assert.equal(writerCalls.length, 1);
  assert.equal(writerCalls[0]!.cwd, "/w");
  assert.ok(writerCalls[0]!.prompt.includes("BEGIN CONVERSATION DELTA"));
  assert.ok(writerCalls[0]!.prompt.includes("do the thing"));

  releaseWriter!();
  await manager.waitForIdle(1000);
  // Success: last_checkpoint_seq advanced to the branch message count.
  const seq = db.prepare("SELECT value FROM meta WHERE key = 'last_checkpoint_seq:s1'").get() as {
    value: string;
  };
  assert.equal(seq.value, "2");
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: gives up after max consecutive writer failures", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpf-"));
  const root = path.join(agent, "pi-mimo-cme");
  const db = openDb(":memory:");
  let calls = 0;
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 2,
    log: () => {},
    runWriter: async () => {
      calls += 1;
      return { ok: false, error: "boom" };
    },
  });
  const messages = [{ role: "user", content: "x" }];
  manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages });
  await manager.waitForIdle(1000);
  assert.equal(calls, 1);

  manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages });
  await manager.waitForIdle(1000);
  assert.equal(calls, 2);

  // Failure cap reached → no further writer runs.
  const fired = manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages });
  assert.equal(fired, false);
  assert.equal(calls, 2);

  // seq never advanced — no successful writer run.
  const seq = db.prepare("SELECT value FROM meta WHERE key = 'last_checkpoint_seq:s1'").get();
  assert.equal(seq, undefined);
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: nudges fire once per level, 85% covers 70%", () => {
  const db = openDb(":memory:");
  const manager = new CheckpointManager({
    db,
    root: "/unused",
    thresholds: [],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async () => ({ ok: true }),
  });
  assert.equal(manager.nudgeFor("s1", 50), undefined);
  const first = manager.nudgeFor("s1", 72);
  assert.match(first!, /Context is filling up/);
  assert.equal(manager.nudgeFor("s1", 75), undefined);
  const second = manager.nudgeFor("s1", 90);
  assert.match(second!, /Context is filling up/);
  assert.equal(manager.nudgeFor("s1", 95), undefined);
  // Jumping straight past 85 marks 70 too.
  assert.match(manager.nudgeFor("s2", 90)!, /filling up/);
  assert.equal(manager.nudgeFor("s2", 91), undefined);
  db.close();
});
