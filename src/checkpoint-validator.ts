/**
 * Checkpoint-output validator — Phase 1 of CHECKPOINT-VALIDATOR-PLAN (log-only).
 *
 * A PURE function over text: given the on-disk checkpoint.md / MEMORY.md content
 * plus the two §4 source-of-truth blocks (the TASK GRAPH and SUBAGENT PROGRESS
 * the writer was handed), it returns the ways the checkpoint is out of spec. It
 * reads nothing, writes nothing, and does not depend on pi or SQLite, so the
 * whole rule set is unit-testable under plain `node --test`. The effectful parts
 * (reading files back, recording a row, logging) live in checkpoint.ts.
 *
 * Severity ladder (the pinned decision in the plan, §0):
 *   - error           structural breakage (would force a redo in Phase 2)
 *   - extract-required a section over its token budget (would force spillover)
 *   - warn            advisory; logged, never forces a redo
 *
 * The CHECKPOINT_TEMPLATE / MEMORY_TEMPLATE are the structural oracle (plan
 * invariant 3): canonical headers and instruction lines are parsed from the
 * templates, never from a hand-maintained copy, so the validator follows the
 * template automatically when it changes.
 */
import { estimateTokens } from "./budget.ts";
import {
  CHECKPOINT_SECTION_BUDGETS,
  CHECKPOINT_TEMPLATE,
  MEMORY_SECTION_BUDGETS,
  MEMORY_TEMPLATE,
} from "./templates.ts";

export type Severity = "warn" | "error" | "extract-required";

export interface Violation {
  severity: Severity;
  /** Section the violation is about ("§6 Files and code sections"), or null for whole-file. */
  section: string | null;
  /** Stable machine code for histogramming (e.g. "section-budget-exceeded"). */
  code: string;
  /** Human-readable; in Phase 2 this becomes reflection-message material. */
  message: string;
  detail?: Record<string, unknown>;
}

export interface ValidatorInput {
  /** On-disk checkpoint.md, read back after the writer ran. */
  checkpointText: string;
  /** On-disk MEMORY.md (project memory). */
  memoryText: string;
  /** The §4 TASK GRAPH source block the writer received (job.taskTree). */
  taskGraphBlock: string;
  /** The §4 SUBAGENT PROGRESS source block the writer received. */
  subagentBlock: string;
}

/**
 * Budget overruns are flagged only above budget × (1 + tolerance). The token
 * count is the codebase's `chars/4` estimate (see estimateTokens), which is
 * imprecise, so a margin keeps a borderline section from flapping. The plan
 * (§3.3) starts this at 15%; Phase 1's logs justify any retune before Phase 2
 * makes it actionable.
 */
export const BUDGET_TOLERANCE = 0.15;



interface Section {
  /** Full header line, trimmed (e.g. "## §6 Files and code sections"). */
  headerLine: string;
  /** Header text after "## " (e.g. "§6 Files and code sections" — also the budget key). */
  headerText: string;
  /** The "_..._" italic instruction line (trimmed), or null when absent. */
  instruction: string | null;
  /** Everything below the instruction up to the next "## " header, trimmed. */
  body: string;
}

/**
 * Splits markdown into "## "-delimited sections. The "_instruction_" line, when
 * present as the first non-empty line of a section, is captured separately so
 * the body excludes it. Level-1 ("# ") and level-3 ("### ") headings are NOT
 * section boundaries — so the checkpoint's "# Session checkpoint" heading is
 * preamble and §4's "### Subagents" sub-block stays inside §4's body.
 */
function splitSections(text: string): Section[] {
  const out: Section[] = [];
  let cur: { headerLine: string; headerText: string; instruction: string | null; body: string[] } | null = null;
  const flush = () => {
    if (cur) out.push({ ...cur, body: cur.body.join("\n").trim() });
  };
  for (const line of text.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      cur = { headerLine: line.trim(), headerText: h[1]!, instruction: null, body: [] };
      continue;
    }
    if (!cur) continue; // preamble before the first section
    if (cur.instruction === null && cur.body.length === 0 && /^_.*_\s*$/.test(line)) {
      cur.instruction = line.trim();
      continue;
    }
    cur.body.push(line);
  }
  flush();
  return out;
}

/** Section number from a checkpoint header text ("§6 Files…" → 6), or null. */
function sectionNum(headerText: string): number | null {
  const m = /^§(\d+)\b/.exec(headerText);
  return m ? Number(m[1]) : null;
}

const EMPTY_BODIES = new Set(["", "(none)", "(none yet)", "(no tasks or subagents this session)"]);
function isEmptyBody(body: string): boolean {
  return EMPTY_BODIES.has(body.trim());
}

/** Non-empty, non-placeholder content lines, trimmed. */
function contentLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !EMPTY_BODIES.has(l));
}

// Canonical structure, parsed once from the templates (the structural oracle).
const CANON_CHECKPOINT = new Map<number, Section>();
for (const s of splitSections(CHECKPOINT_TEMPLATE)) {
  const n = sectionNum(s.headerText);
  if (n !== null) CANON_CHECKPOINT.set(n, s);
}
const CHECKPOINT_FIRST_HEADING = "# Session checkpoint";

/** Task IDs that appear in leading position "- [status] #<id> …", as a Set. */
function taskIds(body: string): Set<string> {
  const ids = new Set<string>();
  for (const m of body.matchAll(/^[ \t]*-\s+\[[^\]]*\]\s+#(\S+)/gm)) ids.add(m[1]!);
  return ids;
}

/** Actor IDs that appear in leading position "- <id> · <type> · …", as a Set. */
function actorIds(body: string): Set<string> {
  const ids = new Set<string>();
  for (const m of body.matchAll(/^[ \t]*-\s+(\S+)\s+·/gm)) ids.add(m[1]!);
  return ids;
}

/**
 * Validate a just-written checkpoint against the spec. Returns every way it is
 * out of spec, tagged by severity. An empty array means in-spec.
 */
export function validateCheckpoint(input: ValidatorInput): Violation[] {
  const v: Violation[] = [];
  const live = splitSections(input.checkpointText);
  const liveByNum = new Map<number, Section>();
  const liveNumsInOrder: number[] = [];
  for (const s of live) {
    const n = sectionNum(s.headerText);
    if (n === null) continue;
    liveNumsInOrder.push(n);
    if (!liveByNum.has(n)) liveByNum.set(n, s);
  }

  // Whole-file: the heading anchors type detection (typeFromKey) and parsing.
  const firstHeading = input.checkpointText.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstHeading !== CHECKPOINT_FIRST_HEADING) {
    v.push({
      severity: "error",
      section: null,
      code: "missing-file-heading",
      message: `Checkpoint must start with "${CHECKPOINT_FIRST_HEADING}".`,
    });
  }

  // Sections present, in numerical order.
  for (const [n, canon] of CANON_CHECKPOINT) {
    if (!liveByNum.has(n)) {
      v.push({
        severity: "error",
        section: canon.headerText,
        code: "missing-section",
        message: `Required section "${canon.headerText}" is missing.`,
      });
    }
  }
  const recognized = liveNumsInOrder.filter((n) => CANON_CHECKPOINT.has(n));
  const ascending = recognized.every((n, i) => i === 0 || n > recognized[i - 1]!);
  if (!ascending) {
    v.push({
      severity: "error",
      section: null,
      code: "sections-out-of-order",
      message: `Sections must appear in ascending §-order; saw ${recognized.join(",")}.`,
    });
  }

  // Per-section structural + budget checks.
  for (const [n, canon] of CANON_CHECKPOINT) {
    const s = liveByNum.get(n);
    if (!s) continue; // missing already reported
    if (s.headerLine !== canon.headerLine) {
      v.push({
        severity: "error",
        section: canon.headerText,
        code: "header-modified",
        message: `Header for §${n} was modified. Restore it to "${canon.headerLine}".`,
      });
    }
    if (s.instruction !== canon.instruction) {
      v.push({
        severity: "error",
        section: canon.headerText,
        code: "instruction-modified",
        message: `The italic instruction line under §${n} was modified; it must be left verbatim.`,
      });
    }
    const budget = CHECKPOINT_SECTION_BUDGETS[canon.headerText];
    if (budget !== undefined) {
      const tokens = estimateTokens(s.body);
      if (tokens > budget * (1 + BUDGET_TOLERANCE)) {
        v.push({
          severity: "extract-required",
          section: canon.headerText,
          code: "section-budget-exceeded",
          message: `§${n} is ≈${tokens} tokens, budget ${budget}. Extract a coherent topic to checkpoint-<topic>.md and leave an index line.`,
          detail: { tokens, budget, overrunPct: Math.round((tokens / budget - 1) * 100) },
        });
      }
    }
  }

  // §1 Active intent must carry a block-quoted verbatim user request (the anchor).
  const s1 = liveByNum.get(1);
  if (s1 && !/^[ \t]*>.*["“”]/m.test(s1.body)) {
    v.push({
      severity: "error",
      section: CANON_CHECKPOINT.get(1)!.headerText,
      code: "intent-no-verbatim",
      message: `§1 has no block-quoted user request. Add the user's words as \`> "<exact words>"\`.`,
    });
  }

  // §4 Task tree must not invent task/actor IDs absent from the source blocks.
  const s4 = liveByNum.get(4);
  if (s4) {
    const srcTasks = taskIds(input.taskGraphBlock);
    const srcActors = actorIds(input.subagentBlock);
    for (const id of taskIds(s4.body)) {
      if (!srcTasks.has(id)) {
        v.push({
          severity: "error",
          section: CANON_CHECKPOINT.get(4)!.headerText,
          code: "task-id-invented",
          message: `§4 references task #${id}, which is not in the TASK GRAPH source. Never invent task IDs.`,
          detail: { id, kind: "task" },
        });
      }
    }
    for (const id of actorIds(s4.body)) {
      if (!srcActors.has(id)) {
        v.push({
          severity: "error",
          section: CANON_CHECKPOINT.get(4)!.headerText,
          code: "task-id-invented",
          message: `§4 references actor "${id}", which is not in the SUBAGENT PROGRESS source. Never invent actor IDs.`,
          detail: { id, kind: "actor" },
        });
      }
    }
  }

  // §11 Open notes — prefer empty (advisory only).
  const s11 = liveByNum.get(11);
  if (s11 && !isEmptyBody(s11.body)) {
    v.push({
      severity: "warn",
      section: CANON_CHECKPOINT.get(11)!.headerText,
      code: "open-notes-nonempty",
      message: `§11 Open notes is non-empty; prefer empty when in doubt.`,
    });
  }

  // MEMORY.md advisory checks (warn only — pruning MEMORY is the dream pass's job).
  validateMemory(input, liveByNum, v);

  return v;
}

function validateMemory(input: ValidatorInput, liveByNum: Map<number, Section>, v: Violation[]): void {
  const mem = splitSections(input.memoryText);
  const memByTitle = new Map<string, Section>();
  for (const s of mem) if (!memByTitle.has(s.headerText)) memByTitle.set(s.headerText, s);

  // Per-section budget (warn).
  for (const [title, budget] of Object.entries(MEMORY_SECTION_BUDGETS)) {
    const s = memByTitle.get(title);
    if (!s) continue;
    const tokens = estimateTokens(s.body);
    if (tokens > budget * (1 + BUDGET_TOLERANCE)) {
      v.push({
        severity: "warn",
        section: `MEMORY.md ## ${title}`,
        code: "memory-budget-exceeded",
        message: `MEMORY.md ## ${title} is ≈${tokens} tokens, budget ${budget}.`,
        detail: { tokens, budget, overrunPct: Math.round((tokens / budget - 1) * 100) },
      });
    }
  }

  // §3 directive duplicated in MEMORY.md ## Rules (should have been de-duped).
  const rules = memByTitle.get("Rules");
  const s3 = liveByNum.get(3);
  if (rules && s3) {
    const ruleSet = new Set(contentLines(rules.body));
    const dups = contentLines(s3.body).filter((l) => ruleSet.has(l));
    if (dups.length > 0) {
      v.push({
        severity: "warn",
        section: "§3 Directives (this session)",
        code: "directive-dup-memory",
        message: `${dups.length} §3 directive line(s) duplicate MEMORY.md ## Rules; MEMORY.md is canonical.`,
        detail: { lines: dups },
      });
    }
  }

  // Duplicate entries under MEMORY.md ## Discovered durable knowledge.
  const disc = memByTitle.get("Discovered durable knowledge");
  if (disc) {
    const keys = contentLines(disc.body).map((l) => l.replace(/^(#{1,6}\s+|-\s+)/, "").trim());
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) dupes.add(k);
      else seen.add(k);
    }
    if (dupes.size > 0) {
      v.push({
        severity: "warn",
        section: "MEMORY.md ## Discovered durable knowledge",
        code: "discovered-dup-title",
        message: `${dupes.size} duplicate entr(y/ies) under ## Discovered durable knowledge.`,
        detail: { titles: [...dupes] },
      });
    }
  }
}

export interface ViolationCounts {
  nError: number;
  nExtract: number;
  nWarn: number;
  /** Distinct codes present, sorted — stored comma-joined for histogramming. */
  codes: string[];
  /** Largest budget overrun (%) across any budget violation, 0 when none. */
  maxOverrunPct: number;
}

/** Roll a violation list into the counts recorded per checkpoint run. */
export function summarizeViolations(violations: Violation[]): ViolationCounts {
  let nError = 0;
  let nExtract = 0;
  let nWarn = 0;
  let maxOverrunPct = 0;
  const codes = new Set<string>();
  for (const x of violations) {
    if (x.severity === "error") nError += 1;
    else if (x.severity === "extract-required") nExtract += 1;
    else nWarn += 1;
    codes.add(x.code);
    const pct = x.detail?.["overrunPct"];
    if (typeof pct === "number" && pct > maxOverrunPct) maxOverrunPct = pct;
  }
  return { nError, nExtract, nWarn, codes: [...codes].sort(), maxOverrunPct };
}
