import assert from "node:assert/strict";
import { test } from "node:test";
import {
  summarizeViolations,
  validateCheckpoint,
  type Violation,
} from "../src/checkpoint-validator.ts";
import { CHECKPOINT_TEMPLATE } from "../src/templates.ts";

/**
 * Replace a checkpoint section's body (everything below its "_instruction_"
 * line, up to the next "## " header). Keeps the canonical header + instruction
 * intact, so a single call mutates exactly one section's content.
 */
function setSection(cp: string, num: number, body: string): string {
  const re = new RegExp(`(## §${num} [^\\n]*\\n_[^\\n]*_\\n)[\\s\\S]*?(?=\\n## |$)`);
  return cp.replace(re, (_m, head: string) => `${head}${body}`);
}

/** A fully in-spec checkpoint: the template with §1 carrying a block-quoted request. */
const baseValid = () => setSection(CHECKPOINT_TEMPLATE, 1, '> "fix the parser"');

/** MEMORY.md with optional Rules / Discovered bodies. */
function memory(over: { rules?: string; discovered?: string } = {}): string {
  return [
    "# Project memory",
    "",
    "## Project context",
    "(none yet)",
    "",
    "## Rules",
    over.rules ?? "(none yet)",
    "",
    "## Architecture decisions",
    "(none yet)",
    "",
    "## Discovered durable knowledge",
    over.discovered ?? "(none yet)",
    "",
  ].join("\n");
}

const NO_SOURCE = { taskGraphBlock: "", subagentBlock: "" };
const codesOf = (v: Violation[]) => v.map((x) => x.code);

test("clean checkpoint yields no violations", () => {
  const v = validateCheckpoint({ checkpointText: baseValid(), memoryText: memory(), ...NO_SOURCE });
  assert.deepEqual(v, [], `expected clean, got ${JSON.stringify(v)}`);
});

test("intent-no-verbatim fires when §1 has no block-quoted request", () => {
  // The raw template still has "(none yet)" in §1.
  const v = validateCheckpoint({ checkpointText: CHECKPOINT_TEMPLATE, memoryText: "", ...NO_SOURCE });
  const hit = v.find((x) => x.code === "intent-no-verbatim");
  assert.ok(hit, "intent-no-verbatim should fire");
  assert.equal(hit!.severity, "error");
});

test("missing-section fires when a required section is absent", () => {
  const re = /## §6 [\s\S]*?(?=\n## )/; // drop the whole §6 block
  const cp = baseValid().replace(re, "");
  const v = validateCheckpoint({ checkpointText: cp, memoryText: "", ...NO_SOURCE });
  const hit = v.find((x) => x.code === "missing-section");
  assert.ok(hit, "missing-section should fire");
  assert.equal(hit!.section, "§6 Files and code sections");
  assert.equal(hit!.severity, "error");
});

test("sections-out-of-order fires when §-numbers are not ascending", () => {
  const cp = [
    "# Session checkpoint",
    "",
    "## §2 Next concrete action",
    "_x_",
    "(none)",
    "",
    "## §1 Active intent",
    "_x_",
    '> "hi"',
    "",
  ].join("\n");
  const codes = codesOf(validateCheckpoint({ checkpointText: cp, memoryText: "", ...NO_SOURCE }));
  assert.ok(codes.includes("sections-out-of-order"));
});

test("missing-file-heading fires when the file doesn't start with the title", () => {
  const cp = baseValid().replace("# Session checkpoint", "# Wrong");
  const v = validateCheckpoint({ checkpointText: cp, memoryText: "", ...NO_SOURCE });
  assert.ok(v.some((x) => x.code === "missing-file-heading" && x.severity === "error"));
});

test("header-modified fires when a section title is changed", () => {
  const cp = baseValid().replace("## §6 Files and code sections", "## §6 Files");
  const v = validateCheckpoint({ checkpointText: cp, memoryText: "", ...NO_SOURCE });
  const hit = v.find((x) => x.code === "header-modified");
  assert.ok(hit, "header-modified should fire");
  assert.equal(hit!.severity, "error");
});

test("instruction-modified fires when an italic instruction line is changed", () => {
  const cp = baseValid().replace(
    "_Files actively read/edited, each with a one-line purpose._",
    "_changed instruction._",
  );
  const v = validateCheckpoint({ checkpointText: cp, memoryText: "", ...NO_SOURCE });
  assert.ok(v.some((x) => x.code === "instruction-modified" && x.severity === "error"));
});

test("section-budget-exceeded fires (extract-required) when a section blows its budget", () => {
  // §1 budget is 500 tokens; ~4,200 chars ≈ 1,050 tokens, well over budget×1.15.
  const big = setSection(CHECKPOINT_TEMPLATE, 1, `> "${"alpha ".repeat(700)}"`);
  const v = validateCheckpoint({ checkpointText: big, memoryText: "", ...NO_SOURCE });
  const hit = v.find((x) => x.code === "section-budget-exceeded");
  assert.ok(hit, "section-budget-exceeded should fire");
  assert.equal(hit!.severity, "extract-required");
  assert.ok((hit!.detail!["overrunPct"] as number) > 0);
  // The big §1 still has a block quote, so intent-no-verbatim must NOT fire.
  assert.ok(!v.some((x) => x.code === "intent-no-verbatim"));
});

test("task-id-invented fires for §4 task/actor IDs absent from the source blocks", () => {
  const cp = setSection(baseValid(), 4, "- [open] #99 ghost task\n- ghostactor · explore · done — x");
  const v = validateCheckpoint({
    checkpointText: cp,
    memoryText: "",
    taskGraphBlock: "- [in_progress] #1 real task",
    subagentBlock: "- realactor · explore · completed — ok",
  });
  const hits = v.filter((x) => x.code === "task-id-invented");
  assert.equal(hits.length, 2, "both the invented task and actor should fire");
  assert.ok(hits.every((x) => x.severity === "error"));
});

test("task-id-invented does NOT fire when §4 IDs match the source blocks", () => {
  const cp = setSection(baseValid(), 4, "- [open] #1 real task\n- realactor · explore · done — x");
  const v = validateCheckpoint({
    checkpointText: cp,
    memoryText: "",
    taskGraphBlock: "- [in_progress] #1 real task",
    subagentBlock: "- realactor · explore · completed — ok",
  });
  assert.ok(!v.some((x) => x.code === "task-id-invented"));
});

test("open-notes-nonempty is a warning when §11 has content", () => {
  const cp = setSection(baseValid(), 11, "some leftover note");
  const v = validateCheckpoint({ checkpointText: cp, memoryText: memory(), ...NO_SOURCE });
  const hit = v.find((x) => x.code === "open-notes-nonempty");
  assert.ok(hit, "open-notes-nonempty should fire");
  assert.equal(hit!.severity, "warn");
});

test("directive-dup-memory is a warning when a §3 line duplicates MEMORY ## Rules", () => {
  const cp = setSection(baseValid(), 3, "D1: use snake_case for fields");
  const v = validateCheckpoint({
    checkpointText: cp,
    memoryText: memory({ rules: "D1: use snake_case for fields" }),
    ...NO_SOURCE,
  });
  const hit = v.find((x) => x.code === "directive-dup-memory");
  assert.ok(hit, "directive-dup-memory should fire");
  assert.equal(hit!.severity, "warn");
});

test("discovered-dup-title is a warning for duplicate Discovered entries", () => {
  const v = validateCheckpoint({
    checkpointText: baseValid(),
    memoryText: memory({ discovered: "- left-recursion needs Pratt parsing\n- left-recursion needs Pratt parsing" }),
    ...NO_SOURCE,
  });
  const hit = v.find((x) => x.code === "discovered-dup-title");
  assert.ok(hit, "discovered-dup-title should fire");
  assert.equal(hit!.severity, "warn");
});

test("memory-budget-exceeded is a warning when a MEMORY section blows its budget", () => {
  // ## Rules budget is 2000 tokens; ~12,000 chars ≈ 3,000 tokens.
  const v = validateCheckpoint({
    checkpointText: baseValid(),
    memoryText: memory({ rules: "- rule ".repeat(2000) }),
    ...NO_SOURCE,
  });
  const hit = v.find((x) => x.code === "memory-budget-exceeded");
  assert.ok(hit, "memory-budget-exceeded should fire");
  assert.equal(hit!.severity, "warn");
});

test("summarizeViolations tallies severities, distinct sorted codes, and max overrun", () => {
  const counts = summarizeViolations([
    { severity: "error", section: null, code: "missing-section", message: "" },
    { severity: "error", section: null, code: "missing-section", message: "" },
    { severity: "extract-required", section: "§6", code: "section-budget-exceeded", message: "", detail: { overrunPct: 40 } },
    { severity: "warn", section: null, code: "open-notes-nonempty", message: "" },
  ]);
  assert.equal(counts.nError, 2);
  assert.equal(counts.nExtract, 1);
  assert.equal(counts.nWarn, 1);
  assert.deepEqual(counts.codes, ["missing-section", "open-notes-nonempty", "section-budget-exceeded"]);
  assert.equal(counts.maxOverrunPct, 40);
});
