import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  CheckpointManager,
  DELTA_CAP,
  defaultThresholdsFor,
  newlyCrossed,
  serializeDelta,
  type WriterRequest,
  type WriterResult,
} from "../src/checkpoint.ts";
import { openDb } from "../src/db.ts";
import { checkpointPath } from "../src/paths.ts";
import { CHECKPOINT_TEMPLATE } from "../src/templates.ts";

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

test("defaultThresholdsFor scales density with the window (MiMoCode tiers)", () => {
  // ≤200K: every 20% — identical to the old flat default.
  assert.deepEqual(defaultThresholdsFor(200_000), [20, 40, 60, 80]);
  assert.deepEqual(defaultThresholdsFor(128_000), [20, 40, 60, 80]);
  // 200K–500K: every 10% (9 fires).
  assert.deepEqual(defaultThresholdsFor(400_000), [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  // >500K: every 5% (19 fires) — e.g. a 1M-window model.
  const fine = defaultThresholdsFor(1_000_000);
  assert.equal(fine.length, 19);
  assert.deepEqual(fine.slice(0, 3), [5, 10, 15]);
  assert.equal(fine.at(-1), 95);
  // Unknown window (no contextUsage) falls back to the 20% schedule.
  assert.deepEqual(defaultThresholdsFor(undefined), [20, 40, 60, 80]);
  assert.deepEqual(defaultThresholdsFor(0), [20, 40, 60, 80]);
});

test("CheckpointManager with thresholds:'auto' fires at 5% steps on a 1M window", () => {
  const db = openDb(":memory:");
  const manager = new CheckpointManager({
    db,
    root: fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-auto-")),
    thresholds: "auto",
    maxWriterFailures: 3,
    log: () => {},
    // Resolve immediately so we don't block; we only assert firing decisions.
    runWriter: async () => ({ ok: true }) satisfies WriterResult,
  });
  const messages = [{ role: "user", content: "x" }];
  const big = { tokens: 70_000, contextWindow: 1_000_000 };
  // 6% crosses the 5% tick on a 1M window — a flat [20,40,60,80] would NOT fire here.
  assert.equal(
    manager.maybeCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", percent: 6, messages, parentContext: big }),
    true,
  );
  // Same tick again → no refire.
  assert.equal(
    manager.maybeCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", percent: 7, messages, parentContext: big }),
    false,
  );
  // A small window in the SAME run resolves to the 20% schedule: 6% no longer fires.
  const small = { tokens: 6_000, contextWindow: 100_000 };
  assert.equal(
    manager.maybeCheckpoint({ sid: "s2", pid: "p1", cwd: "/w", percent: 6, messages, parentContext: small }),
    false,
  );
});

test("CheckpointManager: fires once per threshold, inlines delta in prompt, advances seq on success", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cp-"));
  const root = path.join(agent, "cme");
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

test("CheckpointManager: inlines the SUBAGENT PROGRESS block from the injected builder", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpsa-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  const calls: WriterRequest[] = [];
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    buildSubagentProgress: (sid) => `- ag1 · explore · completed — found it (sid=${sid})`,
    runWriter: async (req) => {
      calls.push(req);
      return { ok: true } satisfies WriterResult;
    },
  });
  manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages: [{ role: "user", content: "go" }] });
  await manager.waitForIdle(1000);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.prompt.includes("BEGIN SUBAGENT PROGRESS"));
  assert.ok(calls[0]!.prompt.includes("ag1 · explore · completed — found it (sid=s1)"));
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: omits subagent progress when no builder is wired (renders placeholder)", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpsa0-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  const calls: WriterRequest[] = [];
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async (req) => {
      calls.push(req);
      return { ok: true } satisfies WriterResult;
    },
  });
  manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages: [{ role: "user", content: "go" }] });
  await manager.waitForIdle(1000);
  assert.ok(calls[0]!.prompt.includes("(no subagents this session)"));
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: inlines the TASK GRAPH block from the full branch", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cptg-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  const calls: WriterRequest[] = [];
  let sawMessages = 0;
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    // The task source receives the FULL branch (not just the delta slice).
    buildTaskTree: (messages) => {
      sawMessages = messages.length;
      return "- [in_progress] #1 wire the task tree";
    },
    runWriter: async (req) => {
      calls.push(req);
      return { ok: true } satisfies WriterResult;
    },
  });
  manager.fireCheckpoint({
    sid: "s1",
    pid: "p1",
    cwd: "/w",
    messages: [{ role: "user", content: "go" }, { role: "assistant", content: [] }],
  });
  await manager.waitForIdle(1000);
  assert.equal(sawMessages, 2, "buildTaskTree sees the whole branch");
  assert.ok(calls[0]!.prompt.includes("BEGIN TASK GRAPH"));
  assert.ok(calls[0]!.prompt.includes("- [in_progress] #1 wire the task tree"));
  // No task builder elsewhere → subagents still render their own placeholder.
  assert.ok(calls[0]!.prompt.includes("(no subagents this session)"));
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: renders the no-tasks placeholder when no task builder is wired", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cptg0-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  const calls: WriterRequest[] = [];
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async (req) => {
      calls.push(req);
      return { ok: true } satisfies WriterResult;
    },
  });
  manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages: [{ role: "user", content: "go" }] });
  await manager.waitForIdle(1000);
  assert.ok(calls[0]!.prompt.includes("(no tasks this session)"));
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: records writer token usage + parent context per run", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpm-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async () =>
      ({
        ok: true,
        metrics: {
          input: 1200,
          output: 300,
          cacheRead: 0,
          cacheWrite: 1200,
          total: 2700,
          costUsd: 0.012,
          durationMs: 1500,
        },
      }) satisfies WriterResult,
  });
  manager.fireCheckpoint({
    sid: "s1",
    pid: "p1",
    cwd: "/w",
    messages: [{ role: "user", content: "hello world" }],
    parentContext: { tokens: 84_000, contextWindow: 200_000 },
  });
  await manager.waitForIdle(1000);

  const row = db.prepare("SELECT * FROM writer_metrics WHERE session_id = 's1'").get() as Record<
    string,
    number
  >;
  assert.equal(row["ok"], 1);
  assert.equal(row["writer_input"], 1200);
  assert.equal(row["cache_read"], 0); // no prefix reuse today — the Phase 3 acceptance signal
  assert.equal(row["cache_write"], 1200);
  assert.equal(row["writer_total"], 2700);
  assert.equal(row["parent_tokens"], 84_000); // what a fork=true writer would have carried
  assert.equal(row["parent_context_window"], 200_000);
  assert.equal(row["message_count"], 1);
  assert.equal(row["duration_ms"], 1500);
  assert.ok(row["delta_chars"]! > 0, "delta was serialized + measured");
  assert.equal(row["delta_tokens_est"], Math.ceil(row["delta_chars"]! / 4));
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: records a metrics row even when the writer reports failure", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpmf-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async () => ({ ok: false, error: "boom" }),
  });
  manager.fireCheckpoint({
    sid: "s1",
    pid: "p1",
    cwd: "/w",
    messages: [{ role: "user", content: "x" }],
    parentContext: { tokens: 50_000, contextWindow: 200_000 },
  });
  await manager.waitForIdle(1000);

  const row = db
    .prepare("SELECT ok, writer_input, parent_tokens FROM writer_metrics")
    .get() as Record<string, number>;
  assert.equal(row["ok"], 0);
  assert.equal(row["writer_input"], 0); // no usage reported on failure
  assert.equal(row["parent_tokens"], 50_000); // parent size is still captured
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: gives up after max consecutive writer failures", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpf-"));
  const root = path.join(agent, "cme");
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

test("CheckpointManager: records one checkpoint_validations row per successful run (Phase 1)", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpv-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  // The writer "produces" an in-spec checkpoint: the template with §1 filled in.
  const validCp = CHECKPOINT_TEMPLATE.replace(
    "## §1 Active intent\n_Verbatim user request, block-quoted. This is ground truth — do not paraphrase._\n(none yet)",
    '## §1 Active intent\n_Verbatim user request, block-quoted. This is ground truth — do not paraphrase._\n> "do the thing"',
  );
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async () => {
      fs.writeFileSync(checkpointPath("s1", root), validCp);
      return { ok: true } satisfies WriterResult;
    },
  });
  manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages: [{ role: "user", content: "do the thing" }] });
  await manager.waitForIdle(1000);

  const rows = db
    .prepare("SELECT n_error, n_extract, ended_valid FROM checkpoint_validations WHERE session_id = 's1'")
    .all() as { n_error: number; n_extract: number; ended_valid: number }[];
  assert.equal(rows.length, 1, "exactly one validation row per run");
  assert.equal(rows[0]!.n_error, 0, "an in-spec checkpoint has no errors");
  assert.equal(rows[0]!.n_extract, 0);
  assert.equal(rows[0]!.ended_valid, 1);
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});

test("CheckpointManager: validation row flags an out-of-spec write but never blocks the checkpoint", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-cpv0-"));
  const root = path.join(agent, "cme");
  const db = openDb(":memory:");
  // The writer leaves the bare template (§1 still "(none yet)" → out of spec).
  const manager = new CheckpointManager({
    db,
    root,
    thresholds: [20],
    maxWriterFailures: 3,
    log: () => {},
    runWriter: async () => ({ ok: true }) satisfies WriterResult,
  });
  manager.fireCheckpoint({ sid: "s1", pid: "p1", cwd: "/w", messages: [{ role: "user", content: "go" }] });
  await manager.waitForIdle(1000);

  const row = db
    .prepare("SELECT n_error, codes, ended_valid FROM checkpoint_validations WHERE session_id = 's1'")
    .get() as { n_error: number; codes: string; ended_valid: number };
  assert.ok(row.n_error >= 1, "the bare template is out of spec");
  assert.ok(row.codes.includes("intent-no-verbatim"));
  assert.equal(row.ended_valid, 0);
  // Phase 1 is observe-only: the write still succeeded, so seq advanced.
  const seq = db.prepare("SELECT value FROM meta WHERE key = 'last_checkpoint_seq:s1'").get() as { value: string };
  assert.equal(seq.value, "1");
  db.close();
  fs.rmSync(agent, { recursive: true, force: true });
});
