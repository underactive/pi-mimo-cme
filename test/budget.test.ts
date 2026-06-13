import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { budgetText, budgetedRead, estimateTokens } from "../src/budget.ts";

test("estimateTokens ~ chars/4", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("budgetText: under cap → unchanged", () => {
  assert.equal(budgetText("short text", 100, "/x.md"), "short text");
});

test("budgetText: over cap → line-aligned cut + truncation marker with offset", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"pad".repeat(10)}`);
  const text = lines.join("\n");
  const out = budgetText(text, 50, "/mem/checkpoint.md");
  assert.ok(out.length < text.length);
  const marker = out.split("\n").at(-1)!;
  assert.match(marker, /^⚠️ Truncated at ~50 tokens\. Read\("\/mem\/checkpoint\.md", offset=(\d+)\) for the rest\.$/);
  const offset = Number(marker.match(/offset=(\d+)/)![1]);
  // Offset points at the first missing line (1-based).
  const keptLines = out.split("\n").slice(0, -2); // drop blank + marker
  assert.equal(offset, keptLines.length + 1);
  assert.equal(lines[offset - 1]!.startsWith(`line ${offset - 1}`), true);
});

test("budgetedRead: missing file → undefined; existing file → content", () => {
  assert.equal(budgetedRead("/definitely/not/here.md", 100), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-budget-"));
  const file = path.join(dir, "f.md");
  fs.writeFileSync(file, "file body");
  assert.equal(budgetedRead(file, 100), "file body");
  fs.rmSync(dir, { recursive: true, force: true });
});
