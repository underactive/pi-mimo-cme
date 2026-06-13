import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { ALL_HISTORY_KINDS, backfillProject, extractRows, HistoryIndexer } from "../src/history.ts";

const DEFAULT_KINDS = ["user_text", "assistant_text", "tool_input", "tool_error"];

test("extractRows: user message, string and parts content", () => {
  const str = extractRows({ role: "user", content: "hello there", timestamp: 5 }, DEFAULT_KINDS);
  assert.equal(str.length, 1);
  assert.deepEqual([str[0]!.kind, str[0]!.body, str[0]!.timestamp], ["user_text", "hello there", 5]);

  const parts = extractRows(
    { role: "user", content: [{ type: "text", text: "part one" }, { type: "image" }] },
    DEFAULT_KINDS,
  );
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.body, "part one");
});

test("extractRows: assistant text + toolCall parts; reasoning only when opted in", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "I'll read the file" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "/tmp/x" } },
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
    ],
    timestamp: 9,
  };
  const rows = extractRows(message, DEFAULT_KINDS);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["assistant_text", "tool_input", "tool_input"],
  );
  assert.equal(rows[1]!.toolName, "read");
  assert.ok(rows[1]!.body.startsWith('read {"path":"/tmp/x"}'));

  const withReasoning = extractRows(message, ALL_HISTORY_KINDS);
  assert.ok(withReasoning.some((r) => r.kind === "reasoning" && r.body === "let me think"));
});

test("extractRows: tool_input preview is capped at 2KB", () => {
  const rows = extractRows(
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c", name: "write", arguments: { content: "y".repeat(10_000) } }],
    },
    DEFAULT_KINDS,
  );
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.body.length <= 2048);
});

test("extractRows: toolResult error → tool_error; success only with tool_output opt-in", () => {
  const errorMsg = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: "command not found" }],
    isError: true,
  };
  const okMsg = { ...errorMsg, isError: false, content: [{ type: "text", text: "ok output" }] };

  const errRows = extractRows(errorMsg, DEFAULT_KINDS);
  assert.equal(errRows.length, 1);
  assert.deepEqual([errRows[0]!.kind, errRows[0]!.toolName], ["tool_error", "bash"]);

  assert.equal(extractRows(okMsg, DEFAULT_KINDS).length, 0);
  const optIn = extractRows(okMsg, [...DEFAULT_KINDS, "tool_output"]);
  assert.equal(optIn.length, 1);
  assert.equal(optIn[0]!.kind, "tool_output");
});

test("extractRows skips custom / bash / branch-summary roles", () => {
  for (const role of ["custom", "bashExecution", "branchSummary", "compactionSummary"]) {
    assert.equal(extractRows({ role, content: "whatever" }, ALL_HISTORY_KINDS).length, 0);
  }
});

test("HistoryIndexer maintains per-session seq and resumes from MAX(seq)", () => {
  const db = openDb(":memory:");
  const indexer = new HistoryIndexer(db, DEFAULT_KINDS);
  indexer.indexMessage("s1", "p1", { role: "user", content: "one" });
  indexer.indexMessage("s1", "p1", { role: "user", content: "two" });
  indexer.indexMessage("s2", "p1", { role: "user", content: "other session" });

  const fresh = new HistoryIndexer(db, DEFAULT_KINDS); // simulates reload
  fresh.indexMessage("s1", "p1", { role: "user", content: "three" });
  const seqs = db
    .prepare("SELECT seq FROM history_fts WHERE session_id = 's1' ORDER BY seq")
    .all() as unknown as { seq: number }[];
  assert.deepEqual(
    seqs.map((r) => r.seq),
    [1, 2, 3],
  );
  db.close();
});

test("backfillProject parses JSONL, is fingerprint-idempotent, skips live session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-jsonl-"));
  const db = openDb(":memory:");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "old-session", cwd: "/p" }),
    JSON.stringify({ type: "model_change", id: "x" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: "find the bug", timestamp: 111 },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "toolCall", id: "c", name: "grep", arguments: { pattern: "bug" } },
        ],
        timestamp: 222,
      },
    }),
    "not json at all",
  ];
  fs.writeFileSync(path.join(dir, "a.jsonl"), lines.join("\n"));
  fs.writeFileSync(
    path.join(dir, "live.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "live-session", cwd: "/p" }),
      JSON.stringify({ type: "message", id: "m", message: { role: "user", content: "live!" } }),
    ].join("\n"),
  );

  const stats = backfillProject(db, dir, "p1", DEFAULT_KINDS, "live-session");
  assert.equal(stats.files, 1);
  assert.equal(stats.rows, 3); // user_text + assistant_text + tool_input
  const rows = db
    .prepare("SELECT session_id, seq, kind FROM history_fts ORDER BY seq")
    .all() as unknown as { session_id: string; seq: number; kind: string }[];
  assert.ok(rows.every((r) => r.session_id === "old-session"));
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["user_text", "assistant_text", "tool_input"],
  );

  // Second run: fingerprints unchanged → nothing happens.
  const again = backfillProject(db, dir, "p1", DEFAULT_KINDS, "live-session");
  assert.deepEqual(again, { files: 0, rows: 0 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history_fts").get() as { n: number }).n, 3);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
