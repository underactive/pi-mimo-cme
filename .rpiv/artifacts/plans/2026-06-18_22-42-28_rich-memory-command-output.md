---
date: 2026-06-18T22:42:28-0700
author: Eric Sison
commit: 7c843e1
branch: main
repository: pi-mimo-cme
topic: "Rich /memory command output"
tags: [commands, formatting, memory, status, metrics, validations]
status: ready
parent: .rpiv/artifacts/research/2026-06-18_22-30-27_rich-memory-command-output.md
phase_count: 4
phases:
  - { n: 1, title: "Formatting utilities" }
  - { n: 2, title: "Status readout enhancement" }
  - { n: 3, title: "Metrics & validations readout enhancement" }
  - { n: 4, title: "Integration plumbing" }
unresolved_phase_count: 0
last_updated: 2026-06-18T22:42:28-0700
last_updated_by: Eric Sison
---

# Rich /memory Command Output — Implementation Plan

## Overview

Enhance all 4 display-only `/memory` readouts (status, metrics, validations, search) with section dividers (`── Section ──`), ASCII progress bars for budget visualization, an injection breakdown section in `/memory status`, and a unified footer line across readouts. Introduces a shared `src/formatting.ts` module for bar rendering, section headers, and compact token formatting — deduplicating the existing `fmtK()` scattered across `src/index.ts` and `src/injection-breakdown.ts`. No emoji/icons in readout bodies.

## Requirements

- Section dividers (`── Section Name ──`) for visual structure across all readouts
- ASCII progress bars for budget/token visualizations (auto-width: 20 chars ≤100K, 30 chars >100K context window)
- Injection breakdown section in `/memory status` (instructions, projectMem, globalMem, keys sizes from `getAppendixBreakdown()`)
- Rebuild breakdown section in `/memory status` when available (from `getRebuildBreakdown()`)
- Parent tokens count added to `/memory metrics` to expose AVG bias
- Deduplicated `fmtK()` in a shared formatting module
- Consistent visual style: plain text, `──` dividers, `≈` for estimates, fixed-width column alignment

## Current State Analysis

All 4 readouts are plain-text arrays joined with `\n`. No section headers, no visual structure beyond blank-line separation. Token formatting (`fmtK()`) is duplicated in `src/index.ts:304-305` and `src/injection-breakdown.ts:52-53`. The injection breakdown data (`getAppendixBreakdown()`) exists but only surfaces in the live footer — not in the explicit `/memory status` readout. The rebuild breakdown is surfaced in a post-resume toast but not in any `/memory` readout.

### Key Discoveries

- `src/commands.ts:74-121` — `statusText()`: 5 SQL queries, no section dividers, no injection data
- `src/commands.ts:142-175` — `metricsText()`: Phase 3 fork verdict, no parent_tokens count in the "all projects" line
- `src/commands.ts:188-224` — `validationText()`: histogram rendering, no progress bars for clean rate
- `src/commands.ts:263-268` — `showReadout()`: the only correct rendering path (`pi.sendMessage({ customType, content, display: true })`)
- `src/injection-breakdown.ts:57-64` — `getAppendixBreakdown()` / `getRebuildBreakdown()` — zero-cost in-memory reads
- `src/index.ts:304-305` — duplicate `fmtK()` function
- `src/config.ts:73-78` — `loadConfig()` and `DEFAULT_CONFIG` — no context window access here
- Command handlers receive `ExtensionCommandContext` which inherits `getContextUsage(): ContextUsage | undefined` — returns `{ tokens, contextWindow, percent }` at runtime (contextWindow is always a number when defined)
- `ctx.getContextUsage()` returns `undefined` before any LLM call — must guard with fallback to default bar width

## Desired End State

```
mimo-cme memory status

── Memory Index ──
  memory files:         [████████░░░░░░░░░░░░] 17 idx (global=12 projects=5)
  history rows:         [██░░░░░░░░░░░░░░░░░░] 342 total · 89 this project

── Injection Overhead ──
  instructions:         ~2.5K tok
  project MEMORY.md:    ~4.1K tok
  global MEMORY.md:     ~1.8K tok
  keys index:           ~0.3K tok
  total:                [████░░░░░░░░░░░░░░░░] ~8.7K tok / 200K (4.4%)
  cached:               yes (same as last turn)

── Rebuild Dump (last resume) ──
  checkpoint:           ~9.2K tok
  notes:                ~3.1K tok
  keys:                 5
  actors:               1
  total:                ~12.3K tok

── Session ──
  session:              019ede66-d154-7d19-9ab4-dee5273955ec
  checkpoint:           ~/.pi/cme/sessions/.../checkpoint.md
  notes:                ~/.pi/cme/sessions/.../notes.md
  subagents:            running=1 completed=3

── Project ──
  project:              b5a128abb81c
  memory:               ~/.pi/cme/projects/b5a128abb81c/MEMORY.md
  global:               ~/.pi/cme/global/MEMORY.md

── Meta ──
  db:                   ~/.pi/cme/memory.db (142.3 KB)
  last dream:           2026-06-18T19:30:00Z (auto=true, every 7d)
  last distill:         2026-06-15T08:00:00Z (auto=true, every 30d)
```

## What We're NOT Doing

- Filterable code histogram in `/memory validations` (out of scope — complex UI interaction)
- Unifying `/memory search` output with the memory tool format (changes agent-facing tool behavior)
- Schema changes or new database tables
- New `/memory` subcommands
- Emoji or Nerd Font icons in readout bodies (only in toasts, matching existing convention)
- Real-time updating readouts (they're snapshot-on-invocation, not live)

## Decisions

### D1: Section divider format — `── Name ──`
Em-dash centered section headers. Chosen over `--- Name ---` (ASCII-only) for visual weight, and over `▸ Name` for symmetry. No emoji (consistent with existing readout convention: emoji only in toasts).

### D2: Progress bar helper — new `src/formatting.ts` module
Shared `bar()` function returns a string like `[████████░░░░░░░░░░░░] 42%`. Auto-width based on context window (20 chars ≤100K, 30 chars >100K). Also houses `sectionHeader()`, `fmtK()`, and column-alignment helpers. Single source of truth — deduplicates `fmtK()` from `index.ts` and `injection-breakdown.ts`.

### D3: Injection breakdown placement — inside `/memory status`
Added as a new `── Injection Overhead ──` section in `statusText()`. Data from `getAppendixBreakdown()` (zero-cost in-memory read). Shows breakdown when populated, "(not yet computed this session)" when undefined. Keeps `/memory status` as the single "give me a picture" readout.

### D4: Context window access in command handler — `ctx.getContextUsage()`
`ExtensionCommandContext` inherits `getContextUsage()` from `ExtensionContext`. Returns `ContextUsage | undefined` — guard for undefined (pre-first-LLM-call), use `usage.contextWindow` (always a number) for bar width. Fallback: 200K default when undefined.

### D5: Parent tokens in metrics — add to "all projects" footer line
Add `parent≈N tok` to the `all projects:` summary line in `metricsText()` when `avgParentTokens` is not null. Simple addition, no structural change.

## Phase 1: Formatting utilities

### Overview

Foundation slice: create `src/formatting.ts` with shared helpers for section dividers, ASCII progress bars, compact token display (`fmtK`), and column-aligned labels. No dependencies on other slices. Can run in parallel with nothing (it's the foundation).

### Changes Required:

#### 1. src/formatting.ts

**File**: `src/formatting.ts`
**Changes**: NEW — shared formatting utilities for /memory readouts

```typescript
/**
 * Shared formatting utilities for /memory readouts.
 *
 * Visual conventions (consistent across status, metrics, validations, search):
 * - Section dividers: `── Name ──`
 * - Progress bars: auto-width based on context window (20 chars ≤100K, 30 chars >100K)
 * - Token display: `fmtK()` — ≥1000 → "1.2K", <1000 → "847"
 * - Estimates: `≈` prefix for approximate values
 * - Column alignment: fixed-width labels with trailing spaces
 */

/** Compact token display: ≥1000 → "1.2K", <1000 → raw number. */
export function fmtK(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(Math.round(tokens));
}

/**
 * Section divider: `── Name ──`, padded to a fixed width for visual consistency.
 * Width: 40 chars total (adjustable via `width` param).
 */
export function sectionHeader(name: string, width = 40): string {
  const inner = ` ${name} `;
  const dashCount = Math.max(2, width - inner.length);
  const left = Math.ceil(dashCount / 2);
  const right = dashCount - left;
  return `${"─".repeat(left)}${inner}${"─".repeat(right)}`;
}

/**
 * Auto-width ASCII progress bar. Returns a string like `[████████░░░░░░░░░░░░] 42%`.
 *
 * Bar width adapts to context window:
 * - ≤100K tokens → 20 chars
 * - >100K tokens → 30 chars
 *
 * @param current - current value (e.g. injection overhead tokens)
 * @param max - maximum value (e.g. context window size)
 * @param contextWindow - model's context window for width selection (default 200_000)
 */
export function bar(current: number, max: number, contextWindow = 200_000): string {
  const width = contextWindow <= 100_000 ? 20 : 30;
  const ratio = max > 0 ? Math.min(current / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);
  const filledChar = "█";
  const emptyChar = "░";
  return `[${filledChar.repeat(filled)}${emptyChar.repeat(empty)}] ${pct}%`;
}

/**
 * Column-aligned label: pads the label to `labelWidth` chars, then appends the value.
 * Example: `"  writer tokens/run:   input≈1,234  output≈567"`
 */
export function labelValue(label: string, value: string, labelWidth = 22): string {
  return `${label.padEnd(labelWidth)}${value}`;
}

/**
 * Compact token line: `"label:  [bar] ~X.YK tok / ZK (N.N%)"`
 * Used for injection breakdown total line.
 */
export function tokenBarLine(
  label: string,
  current: number,
  max: number,
  contextWindow = 200_000,
): string {
  const b = bar(current, max, contextWindow);
  const pctText = max > 0 ? ` (${(current / max * 100).toFixed(1)}%)` : "";
  return `${label.padEnd(22)}${b} ${fmtK(current)} / ${fmtK(max)}${pctText}`;
}

/**
 * Simple key=value pair with padding, for the injection breakdown detail lines.
 * Example: `"  instructions:         ~2.5K tok"`
 */
export function kvLine(key: string, value: string, keyWidth = 22): string {
  return `  ${key.padEnd(keyWidth - 2)}${value}`;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`
- [x] `grep -r "from.*formatting" src/ | wc -l` returns 0 (no imports yet — this is the foundation, wired in later slices)

#### Manual Verification:
- [ ] `bar(50, 200)` renders `[████████░░░░░░░░░░░░░░░░░░░░░░] 25%` (8 filled, 22 empty — 30-char bar for 200K default)
- [ ] `bar(50, 200, 80_000)` renders `[█████░░░░░░░░░░░░░░░] 25%` (5 filled, 15 empty — 20-char bar for ≤100K)
- [ ] `fmtK(1234)` returns "1.2K", `fmtK(500)` returns "500"
- [ ] `sectionHeader("Memory")` returns `"──────────────── Memory ────────────────"` (40 chars)

---

## Phase 2: Status readout enhancement

### Overview

Enhance `statusText()` with section dividers, injection breakdown section, rebuild breakdown section, and progress bars. Depends on Phase 1 (formatting utilities).

### Changes Required:

#### 2. src/commands.ts

**File**: `src/commands.ts`
**Changes**: MODIFY — add imports from formatting.ts and injection-breakdown.ts, rewrite `statusText()`

```typescript
// NEW IMPORTS (add to top of file):
import { fmtK, sectionHeader, kvLine, tokenBarLine } from "./formatting.ts";
import { getAppendixBreakdown, getRebuildBreakdown } from "./injection-breakdown.ts";
```

Replace `statusText()` (lines 74-121):

```typescript
function statusText(deps: CommandDeps, cwd: string, sid: string, contextWindow?: number): string {
  const { db, root } = deps;
  const pid = projectId(cwd);
  const cw = contextWindow ?? 200_000;
  const scopes = db
    .prepare("SELECT scope, COUNT(*) AS n FROM memory_fts GROUP BY scope ORDER BY scope")
    .all() as unknown as { scope: string; n: number }[];
  const totalIdx = scopes.reduce((s, r) => s + r.n, 0);
  const history = db.prepare("SELECT COUNT(*) AS n FROM history_fts").get() as { n: number };
  const projectHistory = db
    .prepare("SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ?")
    .get(pid) as { n: number };
  const actorRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM actor WHERE session_id = ? GROUP BY status ORDER BY status")
    .all(sid) as unknown as { status: string; n: number }[];
  let dbSize = 0;
  try {
    dbSize = fs.statSync(dbPath(root)).size;
  } catch {
    /* not created yet */
  }
  const fmtMeta = (key: string) => {
    const v = metaGet(db, key);
    return v ? new Date(Number(v)).toISOString() : "never";
  };

  // --- Injection breakdown (zero-cost in-memory read) ---
  const ab = getAppendixBreakdown();
  const injectionLines: string[] = [];
  injectionLines.push("", sectionHeader("Injection Overhead"));
  if (ab) {
    injectionLines.push(
      kvLine("instructions", `≈${fmtK(ab.instructions)} tok`),
      kvLine("project MEMORY.md", `≈${fmtK(ab.projectMem)} tok`),
      kvLine("global MEMORY.md", `≈${fmtK(ab.globalMem)} tok`),
      kvLine("keys index", `≈${fmtK(ab.keys)} tok`),
      tokenBarLine("total:", ab.instructions + ab.projectMem + ab.globalMem + ab.keys, cw, cw),
      kvLine("cached", ab.cached ? "yes (same as last turn)" : "no (just computed)"),
    );
  } else {
    injectionLines.push(kvLine("", "(not yet computed this session)"));
  }

  // --- Rebuild breakdown (populated on resume/fork/compaction, undefined otherwise) ---
  const rb = getRebuildBreakdown();
  const rebuildLines: string[] = [];
  rebuildLines.push("", sectionHeader("Rebuild Dump (last resume)"));
  if (rb && (rb.checkpoint > 0 || rb.notes > 0)) {
    rebuildLines.push(
      kvLine("checkpoint", `≈${fmtK(rb.checkpoint)} tok`),
      kvLine("notes", `≈${fmtK(rb.notes)} tok`),
      kvLine("keys", String(rb.keyCount)),
      kvLine("actors", String(rb.actorCount)),
      kvLine("total", `≈${fmtK(rb.checkpoint + rb.notes + rb.keysTokens)} tok`),
    );
  } else {
    rebuildLines.push(kvLine("", "(no rebuild yet this session)"));
  }

  const scopeText = scopes.length === 0 ? "0" : scopes.map((s) => `${s.scope}=${s.n}`).join(" ");
  const actorText = actorRows.length === 0 ? "none" : actorRows.map((a) => `${a.status}=${a.n}`).join(" ");

  const lines = [
    "mimo-cme memory status",
    "",
    sectionHeader("Memory Index"),
    tokenBarLine("memory files:", totalIdx, Math.max(totalIdx, 100), cw),
    kvLine("", scopeText),
    tokenBarLine("history rows:", history.n, Math.max(history.n, 1000), cw),
    kvLine("", `${history.n} total · ${projectHistory.n} this project`),
    ...injectionLines,
    ...rebuildLines,
    "",
    sectionHeader("Session"),
    kvLine("session", sid),
    kvLine("checkpoint", checkpointPath(sid, root)),
    kvLine("notes", notesPath(sid, root)),
    kvLine("subagents", actorText),
    "",
    sectionHeader("Project"),
    kvLine("project", pid),
    kvLine("memory", projectMemoryPath(pid, root)),
    kvLine("global", globalMemoryPath(root)),
    "",
    sectionHeader("Meta"),
    kvLine("db", `${dbPath(root)} (${(dbSize / 1024).toFixed(1)} KB)`),
    kvLine("last dream", `${fmtMeta(`last_dream_at:${pid}`)} (auto=${deps.config.dream.auto}, every ${deps.config.dream.intervalDays}d)`),
    kvLine("last distill", `${fmtMeta(`last_distill_at:${pid}`)} (auto=${deps.config.distill.auto}, every ${deps.config.distill.intervalDays}d)`),
  ];
  return lines.join("\n");
}
```

Update the call site in `registerCommands` (inside the `/memory` handler's default branch):

```typescript
// BEFORE (line ~319):
showReadout(ctx, "mimo-cme:status", statusText(deps, ctx.cwd, ctx.sessionManager.getSessionId()));

// AFTER:
const usage = ctx.getContextUsage();
showReadout(
  ctx,
  "mimo-cme:status",
  statusText(deps, ctx.cwd, ctx.sessionManager.getSessionId(), usage?.contextWindow),
);
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`

#### Manual Verification:
- [x] `/memory status` shows section dividers (`── Memory Index ──`, `── Session ──`, etc.)
- [ ] Injection breakdown section appears when at least one turn has run
- [ ] Rebuild breakdown section appears after a resume/fork/compaction
- [ ] Progress bars render correctly for memory files and history rows
- [ ] `kvLine()` alignment is consistent across all sections

---

## Phase 3: Metrics & validations readout enhancement

### Overview

Enhance `metricsText()` and `validationText()` with section dividers, progress bars for clean rate and cost visualization, and add parent_tokens count to the "all projects" footer line. Depends on Phase 1 (formatting utilities).

### Changes Required:

#### 3. src/commands.ts

**File**: `src/commands.ts`
**Changes**: MODIFY — add `bar` to formatting.ts import, rewrite `metricsText()` and `validationText()` with section dividers and bars

Update the formatting.ts import (Phase 2 added it without `bar`):
```typescript
// BEFORE (from Phase 2):
import { fmtK, sectionHeader, kvLine, tokenBarLine } from "./formatting.ts";

// AFTER:
import { bar, fmtK, sectionHeader, kvLine, tokenBarLine } from "./formatting.ts";
```

Replace `metricsText()` (lines 142-175):

```typescript
export function metricsText(deps: CommandDeps, cwd: string, contextWindow?: number): string {
  const pid = projectId(cwd);
  const cw = contextWindow ?? 200_000;
  const proj = writerMetricsSummary(deps.db, { projectId: pid });
  const all = writerMetricsSummary(deps.db);
  if (all.n === 0) {
    return [
      'mimo-cme writer metrics (Phase 3 "measure first")',
      "",
      "no checkpoint-writer runs recorded yet. Run a session past a context",
      "threshold (20/40/60/80%) so the in-process writer fires, then re-run",
      "/memory metrics to see its cost vs. what a fork=true writer would carry.",
    ].join("\n");
  }
  const fmt = (n: number) => Math.round(n).toLocaleString();
  const parent = proj.avgParentTokens;
  const forkBestCase = parent == null ? null : parent * 0.1;
  const verdict =
    parent == null
      ? "no parent-context sizes captured — cannot compare against a fork"
      : forkBestCase! > proj.avgInput
        ? `fork LOSES even best case: ~${fmt(forkBestCase!)} cache-read tok/run > ${fmt(proj.avgInput)} full-price input now → Phase 3 not worth building`
        : `fork MIGHT help: best case ~${fmt(forkBestCase!)} cache-read tok/run < ${fmt(proj.avgInput)} full-price input now → worth deeper measurement`;

  const okRate = proj.n > 0 ? Math.round((proj.okCount / proj.n) * 100) : 0;

  return [
    'mimo-cme writer metrics (Phase 3 "measure first")',
    "",
    sectionHeader("This Project"),
    kvLine("runs", `${proj.n} (${proj.okCount} ok, ${okRate}% success)`),
    kvLine("writer tokens/run", `input≈${fmt(proj.avgInput)}  output≈${fmt(proj.avgOutput)}  total≈${fmt(proj.avgTotal)}`),
    kvLine("cache tokens/run", `read≈${fmt(proj.avgCacheRead)}  write≈${fmt(proj.avgCacheWrite)}`),
    kvLine("cost/run", `$${proj.avgCostUsd.toFixed(4)}`),
    kvLine("delta fed/run", `≈${fmt(proj.avgDeltaTokensEst)} tok`),
    kvLine("parent ctx at fire", parent == null ? "n/a" : `≈${fmt(parent)} tok`),
    kvLine("wall-clock/run", `${fmt(proj.avgDurationMs)} ms`),
    "",
    sectionHeader("Fork Verdict"),
    kvLine("verdict", verdict),
    "",
    sectionHeader("All Projects"),
    kvLine("runs", `${all.n} (${all.okCount} ok)`),
    kvLine("writer input", `≈${fmt(all.avgInput)} tok`),
    kvLine("parent ctx", all.avgParentTokens == null ? "n/a" : `≈${fmt(all.avgParentTokens)} tok`),
  ].join("\n");
}
```

Replace `validationText()` (lines 188-224):

```typescript
export function validationText(deps: CommandDeps, cwd: string): string {
  const pid = projectId(cwd);
  const proj = validationSummary(deps.db, { projectId: pid });
  const all = validationSummary(deps.db);
  if (all.n === 0) {
    return [
      'mimo-cme checkpoint validations (Phase 1 "measure first")',
      "",
      "no checkpoints validated yet. Run a session past a context threshold",
      "(20/40/60/80%) so the in-process writer fires, then re-run",
      "/memory validations to see how the writer's output scores against the spec.",
    ].join("\n");
  }
  const pct = (part: number, whole: number) => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`);
  const hist = Object.entries(proj.codeHistogram).sort((a, b) => b[1] - a[1]);
  const histText = hist.length === 0 ? "    (none)" : hist.map(([c, n]) => `    ${c}: ${n}`).join("\n");

  return [
    'mimo-cme checkpoint validations (Phase 1 "measure first")',
    "",
    sectionHeader("This Project"),
    kvLine("checkpoints", `${proj.n} validated`),
    "",
    `  clean rate:  ${bar(proj.cleanCount, proj.n)}  ${proj.cleanCount} (${pct(proj.cleanCount, proj.n)})`,
    "",
    kvLine("with error", `${proj.withError} (${pct(proj.withError, proj.n)})`),
    kvLine("with extract-required", `${proj.withExtract} (${pct(proj.withExtract, proj.n)})`),
    kvLine("with warn", `${proj.withWarn} (${pct(proj.withWarn, proj.n)})`),
    kvLine("avg violations/run", `error≈${proj.avgError.toFixed(2)} extract≈${proj.avgExtract.toFixed(2)} warn≈${proj.avgWarn.toFixed(2)}`),
    kvLine("worst budget overrun", `${proj.maxOverrunPct}%`),
    "",
    sectionHeader("Code Histogram"),
    histText,
    "",
    sectionHeader("All Projects"),
    kvLine("validated", `${all.n}`),
    kvLine("clean", `${all.cleanCount} (${pct(all.cleanCount, all.n)})`),
    "",
    `Phase 2 (retry + revert) is gated on this data — see docs/FUTURE-IMPROVEMENTS.md.`,
  ].join("\n");
}
```

Update the `/memory metrics` call site in `registerCommands`:

```typescript
// BEFORE (line ~263):
showReadout(ctx, "mimo-cme:metrics", metricsText(deps, ctx.cwd));

// AFTER:
const usage = ctx.getContextUsage();
showReadout(ctx, "mimo-cme:metrics", metricsText(deps, ctx.cwd, usage?.contextWindow));
```

Note: `validationText()` does not need contextWindow — no progress bars based on context size (uses `bar(cleanCount, proj.n)` which is a fixed 20-char bar for the clean rate).

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`

#### Manual Verification:
- [x] `/memory metrics` shows section dividers (`── This Project ──`, `── Fork Verdict ──`, `── All Projects ──`)
- [x] `/memory metrics` includes parent ctx line in "All Projects" section
- [x] `/memory validations` shows section dividers and a progress bar for clean rate
- [x] Validation histogram rendering is unchanged (4-space indented `code: count` lines)
- [x] `bar(proj.cleanCount, proj.n)` renders a 30-char bar (default 200K context window)

---

## Phase 4: Integration plumbing

### Overview

Deduplicate `fmtK()` — replace the copies in `src/index.ts` and `src/injection-breakdown.ts` with imports from `src/formatting.ts`. Also update `injection-breakdown.ts`'s `formatAppendixFooterLabel()` to use the shared `fmtK`. Depends on Phase 1 (formatting utilities).

### Changes Required:

#### 4. src/index.ts

**File**: `src/index.ts`
**Changes**: MODIFY — remove local `fmtK()`, import from formatting.ts

Remove the `fmtK()` function definition (lines 304-305):

```typescript
// REMOVE:
/** Format a token count for display: ≥1000 → "1.2K", <1000 → "847". */
function fmtK(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(tokens);
}
```

Add import (merge with existing imports from formatting.ts if Phase 2 already added it):

```typescript
// ADD to imports:
import { fmtK } from "./formatting.ts";
```

Note: `src/index.ts` already imports from `./injection-breakdown.ts`. The `fmtK` usage in `src/index.ts` is in the post-resume toast builder (line ~590 in `inject_rebuild`) and the `reportPassResult` function. Verify all usages are covered.

#### 4b. src/injection-breakdown.ts

**File**: `src/injection-breakdown.ts`
**Changes**: MODIFY — remove local `fmtK()`, import from formatting.ts, update `formatAppendixFooterLabel()`

Remove the local `fmtK` function (lines 52-53):

```typescript
// REMOVE:
/** Compact token display: ≥1000 → "1.2K", <1000 → "847". */
const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));
```

Add import:

```typescript
// ADD at top:
import { fmtK } from "./formatting.ts";
```

The `formatAppendixFooterLabel()` function at lines 57-64 remains unchanged — it already calls `fmtK()` and the import provides it.

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`
- [x] `grep -n "function fmtK" src/index.ts src/injection-breakdown.ts` returns no matches (all local copies removed)
- [x] `grep -rn "from.*formatting" src/ | wc -l` returns ≥ 3 (index.ts, injection-breakdown.ts, commands.ts)

#### Manual Verification:
- [ ] Live footer still renders correctly (injection breakdown label in footer works)
- [ ] Post-resume toast still shows correct token counts
- [ ] No duplicate function definitions at compile time

---

## Ordering Constraints

- Phase 1 (formatting.ts) is the foundation — Phases 2, 3, 4 all depend on it
- Phases 2, 3, and 4 are independent of each other (different files/sections, no cross-dependencies) — they CAN run in parallel after Phase 1
- Phase 2 modifies `statusText()` and its call site in the command handler
- Phase 3 modifies `metricsText()` and `validationText()` and their call sites
- Phase 4 modifies `index.ts` and `injection-breakdown.ts` for deduplication

## Verification Notes

- `showReadout()` uses non-queued `sendMessage({ customType, content, display: true })` — this is the ONLY correct rendering path. Historical bug: `deliverAs:"nextTurn"` silently parked output. See precedent #1.
- All new formatting must be plain text — no markdown, no ANSI in readout bodies (ANSI only in footer via `setStatus`).
- `getContextUsage()` returns `undefined` before any LLM call — bar width must default to 200K.
- `getAppendixBreakdown()` returns `undefined` until `buildSystemPromptAppendix` runs at least once — status must show "(not yet computed)" gracefully.
- `getRebuildBreakdown()` returns `undefined` until a resume/fork/compaction — status must handle absence.
- `fmtK()` is used in both `index.ts` (post-resume toast) and `injection-breakdown.ts` (footer label) — both must be rewired to the shared import in Phase 4.

## Performance Considerations

- All formatting is pure string construction — zero SQL, zero I/O
- `getAppendixBreakdown()` and `getRebuildBreakdown()` are in-memory reads (module-level state)
- `bar()` is pure arithmetic + string repetition — negligible cost
- No new database queries added to any readout

## Migration Notes

N/A — no schema changes, no persisted data changes.

## Pattern References

- `src/commands.ts:74-121` — statusText() current implementation (baseline for Phase 2 rewrite)
- `src/commands.ts:142-175` — metricsText() current implementation (baseline for Phase 3 rewrite)
- `src/commands.ts:188-224` — validationText() current implementation (baseline for Phase 3 rewrite)
- `src/commands.ts:263-268` — showReadout() rendering gateway (must not be modified)
- `src/injection-breakdown.ts:52-64` — fmtK() and formatAppendixFooterLabel() (dedup target for Phase 4)
- `src/index.ts:304-305` — duplicate fmtK() (dedup target for Phase 4)
- `src/text-utils.ts` — existing text utilities (clip, oneLine, capLines) — not modified but same "utility module" pattern

## Developer Context

### D1: Section divider format
- Developer chose `── Name ──` over `--- Name ---` (ASCII-only) and `▸ Name`
- No emoji in readouts (only in toasts, matching existing convention)

### D2: Progress bar width
- Developer chose auto-width based on context window (20 chars ≤100K, 30 chars >100K)
- `ctx.getContextUsage()?.contextWindow` is the runtime source

### D3: Injection breakdown placement
- Developer chose inside `/memory status` rather than separate `/memory injection` subcommand

### D4: Context window access
- `ExtensionCommandContext` inherits `getContextUsage()` from `ExtensionContext`
- `usage.contextWindow` is always a `number` when `usage` is defined
- Must guard: `getContextUsage()` returns `undefined` before first LLM call

### D5: Parent tokens in metrics
- Developer chose to add `parent≈N tok` to "All Projects" footer line

## Plan History

- Phase 1: Formatting utilities — approved as generated
- Phase 2: Status readout enhancement — approved as generated
- Phase 3: Metrics & validations readout enhancement — approved as generated
- Phase 4: Integration plumbing — approved as generated

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution         |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | ------------------ |
| code     | Phase 3 § metricsText | src/commands.ts:132 | concern | code-quality | `okRate` guard uses `all.n > 0` but divides `proj.okCount / proj.n` — when this project has 0 writer runs but other projects have runs, division by zero produces `NaN` | Change guard to `proj.n > 0` (matching the adjacent `validationText` pattern) | applied: changed guard to `proj.n > 0` |
| code     | Phase 3 § validationText | src/commands.ts:178 | suggestion | code-quality | `const cleanRate` is computed but never referenced in any template line — dead variable | Remove the `cleanRate` assignment; the clean rate percentage is already rendered via `pct()` | applied: removed dead variable |
| code     | Phase 3 § verification | <n/a> | suggestion | actionability | Verification note says "fixed 20-char bar" but `bar()` defaults to 200K context window → 30-char bar | Update the note to say "30-char bar (default 200K context window)" | applied: updated verification note |

## References

- `.rpiv/artifacts/research/2026-06-18_22-30-27_rich-memory-command-output.md` — upstream research
- `.rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md` — injection telemetry patterns
- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md` — memory system architecture
