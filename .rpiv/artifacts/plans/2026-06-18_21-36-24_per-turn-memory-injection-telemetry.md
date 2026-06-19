---
date: 2026-06-18T21:36:24-0700
author: Eric Sison
commit: 7c843e1
branch: main
repository: pi-mimo-cme
topic: Per-turn memory injection telemetry
tags: [memory, telemetry, footer, injection]
status: ready
parent: .rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md
phase_count: 3
phases:
  - { n: 1, title: Breakdown formatter }
  - { n: 2, title: Footer wiring }
  - { n: 3, title: Validation tests }
unresolved_phase_count: 0
last_updated: 2026-06-18T21:36:24-0700
last_updated_by: Eric Sison
---

# Per-Turn Memory Injection Telemetry Implementation Plan

## Overview

This feature surfaces the existing per-turn memory-injection cost in the persistent `mimo-cme` footer and prepares the codebase for an on-demand `/memory status` readout later. The chosen approach is minimal and pure: derive a compact footer label from the `AppendixBreakdown` snapshot already written every turn, then render it alongside the existing `idx / hist` counters.

## Requirements

- Show the user how many tokens the memory system injected this turn.
- Show both the total and the cached subset in compact footer form: `· ~{total} inject ({cached})`.
- Use the existing `AppendixBreakdown` data produced by `buildSystemPromptAppendix`.
- Preserve the current single-key `setStatus("mimo-cme", ...)` convention.
- Keep the footer update zero-SQL and zero-I/O.
- Avoid toast-per-turn noise; the primary surface is ambient/persistent.
- Maintain the existing `commands.ts` contract for later readout expansion.

## Current State Analysis

The codebase already computes per-section token counts every turn inside `buildSystemPromptAppendix`, but the only consumer today is the rebuild toast via `getRebuildBreakdown()`. The appendix breakdown is written but not surfaced.

### Key Discoveries

- `AppendixBreakdown` is populated every turn at `src/inject.ts:216` and `src/inject.ts:246`.
- `getAppendixBreakdown()` at `src/injection-breakdown.ts:53` currently has zero consumers.
- `refreshStatus()` at `src/index.ts:297` is the canonical footer render path and already reads module-level cached state via `counts.snapshot()`.
- The rebuild-toast pattern at `src/index.ts:543-553` is the proven template for rendering breakdown state in compact form.
- `fmtK()` at `src/index.ts:300-303` already implements the project’s preferred compact token display.

## Desired End State

When the feature is complete, the persistent footer may read:

- `󰍛 12 idx · 8 hist · ~14K inject (5.0K)`
- `󰍛 12 idx · 8 hist · ~847 inject (0)`

On the first turn before any breakdown exists yet, the footer stays unchanged:

- `󰍛 12 idx · 8 hist`

In `/memory status`, the same breakdown contract can later be surfaced without inventing a new data model.

## What We're NOT Doing

- Not adding a per-turn toast.
- Not adding a second status key.
- Not adding new config toggles.
- Not adding a `/memory status` breakdown section in this plan.
- Not changing DB schema, checkpoint writes, or memory-injection caps.
- Not adding new ambient UI for rebuild/rebuild-breakdown telemetry.

## Decisions

### Use the existing AppendixBreakdown data

The telemetry source is already populated on every turn by `buildSystemPromptAppendix`. Adding a new collector or side channel would duplicate work and risk inconsistency.

Explored:
- Option A (`src/inject.ts:246` existing breakdown): zero extra computation, already consistent with injected text.
- Option B (new token counter/accumulator): adds code and a new synchronization obligation.

Decision: use Option A — the existing `getAppendixBreakdown()` state.

### Use the persistent footer as the primary surface

The research exposed two plausible surfaces: ambient footer and transient toast. A per-turn toast would be too noisy for this project, while the footer already conveys session-wide ambient metrics.

Decision: primary surface is the `setStatus("mimo-cme", ...)` footer line, not a toast.

### Show total plus cached subset

The user wants to see both values. The footer format should be compact but interpretable.

Decision: render total first, then cached in parentheses, e.g. `· ~14K inject (5.0K)`.

### Keep `/memory status` readout for a later phase

Adding the breakdown to `statusText()` is valid, but this plan focuses on the ambient surface first.

Decision: defer `commands.ts` readout work to a follow-up unless this slice is reopened.

## Phase 1: Breakdown formatter

### Overview

Depends on nothing; this is the foundation. Adds a pure helper that turns the last `AppendixBreakdown` snapshot into a compact footer-ready string.

### Changes Required:

#### 1. src/injection-breakdown.ts:53

**File**: `src/injection-breakdown.ts`
**Changes**: MODIFY — add a pure `formatAppendixFooterLabel()` helper and export it.

```typescript
/** Read the last appendix breakdown (undefined if never computed this session). */
export function getAppendixBreakdown(): AppendixBreakdown | undefined {
  return lastAppendix;
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(n));

/** Compact footer label for the last injection snapshot: `· ~14K inject (5.0K)`. */
export function formatAppendixFooterLabel(): string | undefined {
  const ab = lastAppendix;
  if (!ab) return undefined;
  const total = ab.instructions + ab.projectMem + ab.globalMem + ab.keys;
  return `· ~${fmtK(total)} inject (${ab.cached ? fmtK(total) : "0"})`;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Unit tests pass for the new formatter: `node --test test/injection-breakdown.test.ts`
- [x] Existing injection tests still pass: `node --test test/inject.test.ts`
- [x] injection-breakdown.ts stays pure: `! grep -q "from ['\"]pi['\"]|from ['\"]@earendil-works/pi-coding-agent['\"]" src/injection-breakdown.ts`

#### Manual Verification:
- [ ] Formatter returns `undefined` before the first breakdown is set.
- [ ] Formatter returns the total and cached-only value when the last breakdown was a cache hit.

## Phase 2: Footer wiring

### Overview

Depends on Phase 1. Plugs the formatter into the live footer render path without changing the status key or notification semantics.

### Changes Required:

#### 2. src/index.ts:291-297

**File**: `src/index.ts`
**Changes**: MODIFY — import and render the footer label in `refreshStatus()`.

```typescript
  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const { memIdx, projHist } = counts.snapshot();
    // In-flight subagents are intentionally NOT shown here: the pi-subagents
    // extension already renders that count, so a `· N actors` segment would be
    // redundant. The ledger still tracks them for checkpoint §4 / the rebuild dump.
    const injectLabel = formatAppendixFooterLabel();
    const gray = "\x1b[38;5;244m";
    const reset = "\x1b[0m";
    ctx.ui.setStatus(
      "mimo-cme",
      `${gray}󰍛 ${memIdx} idx · ${projHist} hist${injectLabel ? ` ${injectLabel}` : ""}${reset}`,
    );
  }
```

#### 2b. src/index.ts:48

**File**: `src/index.ts`
**Changes**: MODIFY — add `getAppendixBreakdown` and `formatAppendixFooterLabel` to the import from `./injection-breakdown.ts`.

```typescript
import { formatAppendixFooterLabel, getRebuildBreakdown, resetBreakdowns } from "./injection-breakdown.ts";
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Existing command and inject tests still pass: `npm test`
- [x] Footer label import is present: `grep -n "formatAppendixFooterLabel" src/index.ts | head -n 5`

#### Manual Verification:
- [ ] The footer shows the injection segment only after a breakdown exists.
- [ ] The footer still shows `idx · hist` correctly when no breakdown is available yet.

## Phase 3: Validation tests

### Overview

Depends on Phase 1. Adds focused unit tests for the formatter and the readout contract without importing `pi`, keeping the new logic under `node --test`.

### Changes Required:

#### 3. test/injection-breakdown.test.ts

**File**: `test/injection-breakdown.test.ts`
**Changes**: NEW — unit tests for `getAppendixBreakdown()` and `formatAppendixFooterLabel()`.

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAppendixFooterLabel,
  getAppendixBreakdown,
  resetBreakdowns,
  setAppendixBreakdown,
} from "../src/injection-breakdown.ts";

test("getAppendixBreakdown is undefined before the first set", () => {
  resetBreakdowns();
  assert.equal(getAppendixBreakdown(), undefined);
  assert.equal(formatAppendixFooterLabel(), undefined);
});

test("formatAppendixFooterLabel reflects cached and non-cached states", () => {
  resetBreakdowns();
  setAppendixBreakdown({
    instructions: 4000,
    projectMem: 8000,
    globalMem: 2000,
    keys: 500,
    cached: true,
  });
  const cached = formatAppendixFooterLabel();
  assert.ok(cached, "cached label should exist");
  assert.match(cached, /14\.5K inject/);
  assert.match(cached, /\(14\.5K\)/);

  setAppendixBreakdown({
    instructions: 4000,
    projectMem: 8000,
    globalMem: 2000,
    keys: 500,
    cached: false,
  });
  const refreshed = formatAppendixFooterLabel();
  assert.ok(refreshed, "refreshed label should exist");
  assert.match(refreshed, /14\.5K inject/);
  assert.match(refreshed, /\(0\)/);

  resetBreakdowns();
  assert.equal(formatAppendixFooterLabel(), undefined);
});
```

### Success Criteria:

#### Automated Verification:
- [x] New formatter tests pass: `node --test test/injection-breakdown.test.ts`
- [x] Existing tests pass: `npm test`
- [x] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] New tests cover both cached and refreshed breakdown states.
- [ ] Resetting breakdowns removes the footer label cleanly.

## Ordering Constraints

- Phase 2 depends on Phase 1.
- Phase 3 depends on Phase 1.
- Phases 2 and 3 are independent after Phase 1 is complete, but this plan keeps them sequential for simplicity.

## Verification Notes

- `injection-breakdown.ts` is a pure module with no `pi` import; unit tests must remain under `node --test`.
- `getAppendixBreakdown()` is undefined before the first injection of a session; footer code must guard against that.
- The footer uses a single `"mimo-cme"` status key and overwrites in-place; there is no second key in this plan.
- The formatter currently always emits the total from the four section counts; cached state is shown only when the last injection was a cache hit.

## Performance Considerations

- The footer reads module-level state only; it adds no SQL and no I/O.
- `formatAppendixFooterLabel()` is pure and cheap enough to run on every `refreshStatus()` call.
- The main performance risk is layout length, not computation; the label stays compact by using the existing `fmtK()` convention.

## Migration Notes

Not applicable. There is no schema change, persisted telemetry, or backwards-compatibility risk.

## Pattern References

- `src/injection-breakdown.ts:43-66` — existing breakdown state shape and get/set/reset contract.
- `src/inject.ts:212-252` — where the appendix breakdown is populated each turn.
- `src/index.ts:289-303` — footer render path and `fmtK()`.
- `src/index.ts:543-553` — proven breakdown-toast rendering pattern.

## Developer Context

- The developer asked whether the first surface should be a toast or footer update.
- The developer chose footer-first, not toast-first.
- The developer requested a format showing both total and cached amount in the form `· ~12k inject (5k)`.
- The plan keeps `/memory status` readout deferred for now to stay focused on the ambient surface.

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| -------- | -------- | ------------ | -------- | --------- | ------- | -------------- | ---------- |
| code | Phase 2 §2b (index.ts:48) | src/index.ts:48 | suggestion | codebase-fit | The Phase 2b import adds `getAppendixBreakdown` alongside `formatAppendixFooterLabel`, but Phase 2.2's `refreshStatus` only calls `formatAppendixFooterLabel()` — `getAppendixBreakdown` is never referenced in Phase 2 code. | Drop `getAppendixBreakdown` from the Phase 2 import; it is unused in this phase. | applied: removed unused import from Phase 2 code fence |
| code | Phase 1 §1 (injection-breakdown.ts) | src/injection-breakdown.ts:60-61 | suggestion | code-quality | Variable `cached` (line 60) is computed identically to `total` (line 59) — both sum `instructions + projectMem + globalMem + keys`. The name `cached` is misleading: it holds the total token count, not the cached subset count. | Rename the variable to clarify its intent, or compute a genuinely different cached-token value if the data model supports it. | dismissed: current data model has no separate cached subset, so total is the correct cached display value |
| code | Phase 2 §2 (index.ts:291-297) | src/index.ts:294-295 | concern | code-quality | The modified `refreshStatus` drops the comment `// In-flight subagents are intentionally NOT shown here...` (currently at line 295-296). This comment documents the rationale for omitting actor counts from the footer and should be preserved. | Re-add the dropped comment above the `const injectLabel = ...` line, or keep it between the snapshot and the label. | applied: preserved the subagents-not-shown comment in Phase 2 code fence |
| coverage | ## Verification Notes §1 | <n/a> | blocker | verification-coverage | Note "injection-breakdown.ts is a pure module with no pi import; unit tests must remain under node --test" — no Success Criteria bullet verifies the "no pi import" purity constraint, and no code-level guard enforces it | Add a grep-based automated check under Phase 1's `#### Automated Verification:` that fails if `src/injection-breakdown.ts` imports from pi. | applied: added automated purity grep to Phase 1 success criteria |
| code | Phase 1 §1 (injection-breakdown.ts) | src/injection-breakdown.ts:62 | blocker | actionability | Phase 1 adds `formatAppendixFooterLabel()` that calls `fmtK(total)` and `fmtK(cached)`, but `fmtK` is a module-local function inside `piMimoCme` at `src/index.ts:301` — it is not defined, imported, or accessible in `src/injection-breakdown.ts`. | Inline the formatting logic directly in `formatAppendixFooterLabel` instead of referencing the local `fmtK`. | applied: replaced formatter code fence with inline compact formatting |

## Plan History

- Phase 1: Breakdown formatter — completed (2026-06-18T22:45:00-0700)
- Phase 2: Footer wiring — completed (2026-06-18T22:47:30-0700)
- Phase 3: Validation tests — completed (2026-06-18T22:48:15-0700)
- Validation — pass (2026-06-18T22:50:00-0700)

## References

- `.rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md`
