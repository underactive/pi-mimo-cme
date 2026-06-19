---
date: 2026-06-18T20:18:18-0700
author: Eric Sison
commit: 7c843e1
branch: main
repository: pi-mimo-cme
topic: "Memory alive heartbeat for short sessions"
tags: [visibility, toast, session-start, resume, injection-breakdown]
status: ready
parent: .rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md
phase_count: 3
phases:
  - { n: 1, title: Injection breakdown state }
  - { n: 2, title: Session-start heartbeat toast }
  - { n: 3, title: Post-resume summary toast }
unresolved_phase_count: 0
last_updated: 2026-06-18T20:18:18-0700
last_updated_by: Eric Sison
---

# Memory Alive Heartbeat Implementation Plan

## Overview

Short sessions never cross context-usage thresholds, so the user never sees the checkpoint-saved toast — leaving no proof the memory pipeline is alive. This plan adds two one-shot toasts: a session-start heartbeat confirming the extension loaded with live index/history counts, and a post-resume summary showing per-section token breakdown of restored context. Both use the existing `notify()` shim and require no new I/O.

## Requirements
- Session-start heartbeat: one-shot toast after `counts.seed()` + `refreshStatus()` showing `<memIdx> idx · <projHist> hist`
- Post-resume summary: per-section breakdown toast (checkpoint / notes / keys token estimates) after rebuild dump injection
- Injection breakdown state tracked in `inject.ts` as module-level state alongside the appendix cache
- No new SQL, no config changes, no new dependencies
- Toasts use `setTimeout` to let UI settle before firing (2s delay)

## Current State Analysis
### Key Discoveries
- `src/index.ts:89` — `notify()` shim uses `latestCtx` for UI toasts; safe across async boundaries
- `src/index.ts:441-487` — `session_start` handler has `counts.seed()` + `refreshStatus()` at end, no toast
- `src/index.ts:456` — existing `setTimeout(…, 0)` pattern for backfill shows precedent for delayed UI work
- `src/inject.ts:107-117` — `InjectState` caches `{ key, value }` but no per-section breakdown
- `src/inject.ts:211-240` — `buildSystemPromptAppendix` builds sections array then joins, discarding per-section lengths
- `src/inject.ts:265-293` — `buildRebuildDump` returns a string; fires synchronously before message return
- `src/index.ts:508-523` — `inject_rebuild` handler returns `{ message: { customType, content, display } }`
- `src/budget.ts:5` — `estimateTokens()` is available for token estimation (~4 chars/token)

## Desired End State

**Session start:**
```
[2s after session start]
🧠 mimo-cme: memory active — 42 idx · 287 hist
```

**After resume/fork/compaction:**
```
[immediately after rebuild dump]
🧠 mimo-cme: session resumed — checkpoint (~8K tok) · notes (~3K tok) · 5 keys
```

**`/memory status` (future — deferred):**
Would show injection breakdown section; not in this plan's scope.

## What We're NOT Doing
- Per-turn injection telemetry in the footer (`↻ <N>K` badge) — gap #3, deferred
- Rich `/memory` formatting with icons and ASCII bars — gap #4, deferred
- Verbose rebuild header wrapper around the dump — deferred
- Config changes for visibility options
- New test files — existing test patterns cover pure modules; the `session_start` / `inject_rebuild` handlers are exercised by manual `pi -e` smoke tests

## Decisions

### Toast pattern: Follow `notify()` + `setTimeout`
**Decision**: Use `setTimeout(() => notify(...), 2000)` inside `session_start` handler, after `counts.seed()` + `refreshStatus()`.
**Evidence**: `src/index.ts:456` has `setTimeout(…, 0)` for backfill; `src/index.ts:89` is the notify shim. Post-await safety via `latestCtx`.

### Appendix return type: Keep string
**Decision**: `buildSystemPromptAppendix` stays returning `string`. Breakdown tracked via a separate module-level export in `inject.ts`.
**Evidence**: Single consumer at `src/index.ts:501`. Returning a compound object would change the contract for no benefit when a separate accessor works.

### Scope: Gaps #1 and #2 only
**Decision**: Implement session-start heartbeat + post-resume summary. Defer injection telemetry and rich `/memory` formatting.
**Evidence**: Developer confirmed. Quick wins first; telemetry and formatting are larger independent efforts.

### Post-resume toast: Per-section breakdown
**Decision**: Show checkpoint tokens, notes tokens, and key count in the resume toast.
**Evidence**: Developer confirmed. More useful than total-only; cost is the same (already computed).

### Heartbeat text: Simplified
**Decision**: Use `🧠 mimo-cme: memory active — <N> idx · <M> hist` (no "writer armed").
**Evidence**: Developer confirmed. Writer armed state is an implementation detail the user doesn't need.

## Phase 1: Injection breakdown state

### Overview
Create a lightweight module-level state tracker in `inject.ts` that records per-section token counts each time `buildSystemPromptAppendix` or `buildRebuildDump` runs. This is the foundation slice — Slices 2 and 3 read from this state to build their toasts. Depends on nothing.

### Changes Required:

#### 1. src/injection-breakdown.ts
**File**: src/injection-breakdown.ts
**Changes**: NEW — exported interface and module-level getter/setter for injection breakdown state

```typescript
/**
 * Lightweight module-level state tracking per-section token counts for the
 * last system-prompt appendix and last rebuild dump. Read by the heartbeat
 * and resume toasts in index.ts; never written to disk or SQL.
 *
 * Two independent tracks:
 * - `appendix`: updated every turn by buildSystemPromptAppendix (inject.ts).
 *   Tracks the 4 sections that compose the system-prompt appendix.
 * - `rebuild`: updated on resume/fork/compaction by buildRebuildDump (inject.ts).
 *   Tracks the sections that compose the one-shot rebuild dump.
 */

export interface AppendixBreakdown {
  /** Memory instructions section (~2-3K tokens). */
  instructions: number;
  /** Project MEMORY.md section (up to 10K tokens). */
  projectMem: number;
  /** Global MEMORY.md section (up to 6K tokens). */
  globalMem: number;
  /** Memory keys index section (up to 500 tokens). */
  keys: number;
  /** Whether this was a cache hit (unchanged from last turn). */
  cached: boolean;
}

export interface RebuildBreakdown {
  /** Checkpoint section (up to 11K tokens). */
  checkpoint: number;
  /** Notes section (up to 6K tokens). */
  notes: number;
  /** Number of keys in the keys index. */
  keyCount: number;
  /** Token estimate for the keys index. */
  keysTokens: number;
  /** Actual number of active actors in the rebuild dump (not binary). */
  actorCount: number;
}

let lastAppendix: AppendixBreakdown | undefined;
let lastRebuild: RebuildBreakdown | undefined;

/** Called by buildSystemPromptAppendix after each non-cached computation. */
export function setAppendixBreakdown(b: AppendixBreakdown): void {
  lastAppendix = b;
}

/** Called by buildRebuildDump after each computation. */
export function setRebuildBreakdown(b: RebuildBreakdown): void {
  lastRebuild = b;
}

/** Read the last appendix breakdown (undefined if never computed this session). */
export function getAppendixBreakdown(): AppendixBreakdown | undefined {
  return lastAppendix;
}

/** Read the last rebuild breakdown (undefined if no rebuild dump was generated). */
export function getRebuildBreakdown(): RebuildBreakdown | undefined {
  return lastRebuild;
}

/** Reset both breakdowns — called on session_shutdown for clean state. */
export function resetBreakdowns(): void {
  lastAppendix = undefined;
  lastRebuild = undefined;
}
```

#### 2. src/inject.ts
**File**: src/inject.ts
**Changes**: MODIFY — import breakdown setters; compute and store breakdown in `buildSystemPromptAppendix` and `buildRebuildDump`

```typescript
// Add to imports at top of file (after the existing budget.ts import):
import { setAppendixBreakdown, setRebuildBreakdown } from "./injection-breakdown.ts";

// In buildSystemPromptAppendix, change the cached-return path (line ~213):
// OLD:
//   if (state.appendix?.key === key) return state.appendix.value;
// NEW:
  if (state.appendix?.key === key) {
    setAppendixBreakdown({
      instructions: 0,
      projectMem: 0,
      globalMem: 0,
      keys: 0,
      cached: true,
    });
    return state.appendix.value;
  }

// In buildSystemPromptAppendix, change the non-cached return block (line ~236):
// OLD:
//   const value = sections.join("\n\n");
//   state.appendix = { key, value };
//   return value;
// NEW:
  const value = sections.join("\n\n");
  state.appendix = { key, value };
  setAppendixBreakdown({
    instructions: estimateTokens(sections[0]!),
    projectMem: project !== undefined ? estimateTokens(project) : 0,
    globalMem: global !== undefined ? estimateTokens(global) : 0,
    keys: keys !== undefined ? estimateTokens(keys) : 0,
    cached: false,
  });
  return value;

// In buildRebuildDump, add breakdown tracking before the final return (line ~301):
// OLD:
//   sections.push(
//     "Resume directly. Do not acknowledge this memory dump, do not recap — continue the work as if the conversation had never been interrupted.",
//   );
//   return sections.join("\n\n");
// NEW:
  sections.push(
    "Resume directly. Do not acknowledge this memory dump, do not recap — continue the work as if the conversation had never been interrupted.",
  );
  // Track per-section token counts for the resume toast (index.ts reads these
  // synchronously after buildRebuildDump returns). Derive key count from the
  // existing `keys` variable (already computed by memoryKeysIndex) to avoid
  // running the same query twice.
  const keyCount = keys !== undefined ? keys.split("\n").filter((l) => l.startsWith("- ")).length : 0;
  // Parse actor count from the section text: buildActiveActorsSection returns
  // a markdown table where each data row is a running/created actor.
  let actorCount = 0;
  if (actors !== undefined) {
    actorCount = actors.split("\n").filter((l) => l.match(/^\|.*\|$/)).length - 1; // subtract header row
    if (actorCount < 0) actorCount = 0;
  }
  setRebuildBreakdown({
    checkpoint: estimateTokens(budgetText(checkpointRaw!, ctx.caps.checkpoint, cpPath)),
    notes: notes !== undefined ? estimateTokens(notes) : 0,
    keyCount,
    keysTokens: keys !== undefined ? estimateTokens(keys) : 0,
    actorCount,
  });
  return sections.join("\n\n");
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`
- [x] New file exists: `test -f src/injection-breakdown.ts`
- [x] Grep confirms breakdown setters called: `grep -c "setAppendixBreakdown\|setRebuildBreakdown" src/inject.ts` returns >= 2

#### Manual Verification:
- [ ] `pi -e ./src/index.ts` loads without errors
- [ ] `setAppendixBreakdown` is called on non-cached and cached paths
- [ ] `setRebuildBreakdown` is called when a rebuild dump is generated

## Phase 2: Session-start heartbeat toast

### Overview
Fire a one-shot `🧠 mimo-cme: memory active — <N> idx · <M> hist` toast 2 seconds after session start, using the seeded footer counts. Depends on Phase 1 for the breakdown state foundation (though this slice doesn't read it yet — the foundation ensures the state module is wired). No parallelism constraints.

### Changes Required:

#### 1. src/index.ts
**File**: src/index.ts
**Changes**: MODIFY — add heartbeat toast in `session_start` handler after `counts.seed()` + `refreshStatus()`

```typescript
// In session_start handler, after refreshStatus(ctx) (line ~488), add:

      // One-shot "memory is alive" heartbeat: confirms the extension loaded and
      // the memory pipeline is armed. 2-second delay lets the UI settle first.
      // Fires every session start (startup, new, resume, fork) — the user
      // always sees at least one proof-of-life signal per session.
      if (ctx.hasUI) {
        const snap = counts.snapshot();
        setTimeout(() => {
          notify(`🧠 mimo-cme: memory active — ${snap.memIdx} idx · ${snap.projHist} hist`);
        }, 2000);
      }
    }),
  );
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`
- [x] Grep confirms heartbeat code: `grep -c "memory active" src/index.ts` returns >= 1
- [x] Grep confirms setTimeout in session_start: `grep -A12 "counts.seed" src/index.ts | grep -c "setTimeout"` returns >= 1

#### Manual Verification:
- [ ] `pi -e ./src/index.ts` starts and fires "memory active" toast ~2s after session start
- [ ] Toast shows correct idx/hist counts matching the footer
- [ ] Toast fires on startup, new, resume, and fork (all reason values)
- [ ] No toast fires when `ctx.hasUI` is false (headless / `-p` mode)
- [ ] Force a `notify()` failure (e.g. throw inside the toast callback) and confirm the `session_start` handler does not crash — error is logged and swallowed per SPEC §9.5

## Phase 3: Post-resume summary toast

### Overview
After the rebuild dump is injected on resume/fork/compaction, fire a toast summarizing what was loaded with per-section token breakdown. Reads from the `RebuildBreakdown` state set by `buildRebuildDump` (Phase 1). Depends on Phase 1. No parallelism with Phase 2 needed (both are index.ts modifications but touch different handlers).

### Changes Required:

#### 1. src/index.ts
**File**: src/index.ts
**Changes**: MODIFY — add import for `getRebuildBreakdown` from `injection-breakdown.ts`; add `fmtK` helper; add post-resume summary toast in `inject_rebuild` handler

```typescript
// Add import after the existing inject.ts import (line ~47):
import { getRebuildBreakdown, resetBreakdowns } from "./injection-breakdown.ts";

// Add fmtK helper after refreshStatus (line ~296), before assetSnapshot:
/** Format a token count for display: ≥1000 → "1.2K", <1000 → "847". */
function fmtK(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(tokens);
}

// In session_shutdown handler, add resetBreakdowns() before db.close():
  pi.on(
    "session_shutdown",
    safe("session_shutdown", () => {
      for (const off of busUnsubs.splice(0)) {
        try { off(); } catch { /* unsubscribe is best-effort */ }
      }
      resetBreakdowns(); // clear module-level injection breakdown state for clean next session
      db.close();
    }),
  );

// Replace the inject_rebuild handler (lines ~506-520):
  // 2) One-shot rebuild dump after resume / fork / compaction.
  pi.on(
    "before_agent_start",
    safe("inject_rebuild", (_event, ctx) => {
      if (!pendingRebuild) return;
      pendingRebuild = false;
      // Open tasks (in_progress + pending) from the live rpiv-todo snapshot on
      // the branch — surfaced so a resumed session sees its still-actionable
      // todos even if they postdate the last checkpoint. Soft/gated like §4.
      const openTasks = config.tasks.enabled
        ? buildTaskTree(readTaskSnapshot(branchMessages(ctx)), config.checkpoint.pushCaps.tasks, {
            openOnly: true,
          })
        : "";
      const dump = buildRebuildDump(db, injectCtx(ctx), openTasks);
      if (dump === undefined) return; // checkpoint absent or all "(none yet)" — skip silently

      // Post-resume summary toast: fires once, showing what memory context was restored.
      // Uses the breakdown state set synchronously by buildRebuildDump in the call above.
      if (ctx.hasUI) {
        const rb = getRebuildBreakdown();
        if (rb) {
          const parts: string[] = [];
          if (rb.checkpoint > 0) parts.push(`checkpoint (~${fmtK(rb.checkpoint)} tok)`);
          if (rb.notes > 0) parts.push(`notes (~${fmtK(rb.notes)} tok)`);
          if (rb.keyCount > 0) parts.push(`${rb.keyCount} keys`);
          if (rb.actorCount > 0) parts.push(`${rb.actorCount} actor(s)`);
          if (parts.length > 0) {
            notify(`🧠 mimo-cme: session resumed — ${parts.join(" · ")}`);
          }
        }
      }

      return { message: { customType: "mimo-cme:rebuild", content: dump, display: true } };
    }),
  );
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] Tests pass: `npm test`
- [x] Grep confirms resume toast: `grep -c "session resumed" src/index.ts` returns >= 1
- [x] Grep confirms getRebuildBreakdown import: `grep -c "getRebuildBreakdown" src/index.ts` returns >= 1
- [x] Grep confirms fmtK helper: `grep -c "function fmtK" src/index.ts` returns >= 1

#### Manual Verification:
- [ ] On resume, the "session resumed" toast fires with per-section breakdown
- [ ] On fork, the toast fires with the same format
- [ ] On compaction, the toast fires
- [ ] When checkpoint is empty (no prior writer output), no resume toast fires
- [ ] Token estimates in the toast are reasonable (not 0K for non-empty sections)

## Ordering Constraints
- Phase 1 must complete before Phase 2 or Phase 3 (foundation for breakdown state)
- Phase 2 and Phase 3 are independent of each other (different handlers in index.ts)
- Phase 3 reads `getRebuildBreakdown()` which is set by `buildRebuildDump` — Phase 1 wires the setter

## Verification Notes
- The `session_start` and `inject_rebuild` handlers are wrapped in `safe()` (SPEC §9.5) — any toast failure is logged and swallowed, never breaking the session
- `setTimeout` in `session_start` fires after the handler returns — `latestCtx` keeps the notify shim pointed at the live UI (same pattern as backfill at `src/index.ts:456`)
- `buildRebuildDump` runs synchronously inside `inject_rebuild` — `setRebuildBreakdown` is called before `getRebuildBreakdown` reads it (same synchronous call)
- `estimateTokens` uses ~4 chars/token — consistent with existing usage in `src/inject.ts`

## Performance Considerations
- `estimateTokens` on 4 short strings is ~microseconds — negligible per-turn cost
- No new SQL queries, no new prepared statements (key count derived from existing `keys` variable, not re-queried)
- Module-level state is a few integers — no memory pressure
- `setTimeout(…, 2000)` is a single timer per session — no timer leaks

## Migration Notes
- No schema changes, no config changes, no data migration
- The `injection-breakdown.ts` module is new but purely in-memory — no persistence
- Backwards compatible: if breakdown state is undefined (first turn before appendix computed), toasts gracefully skip

## Pattern References
- `src/index.ts:89-91` — `notify()` shim pattern for UI toasts
- `src/index.ts:456` — `setTimeout` pattern in `session_start` for delayed UI work
- `src/index.ts:288-296` — `refreshStatus()` footer pattern (reference for how `counts.snapshot()` is used)
- `src/inject.ts:107-117` — `InjectState` cache pattern (model for breakdown state)
- `src/inject.ts:211-240` — `buildSystemPromptAppendix` section-building pattern
- `src/inject.ts:265-293` — `buildRebuildDump` section-building pattern
- `src/budget.ts:5` — `estimateTokens()` for token estimation
- `src/commands.ts:25-37` — `CommandDeps` pattern for passing deps to command handlers

## Developer Context

### Step 4 Decisions
- **Toast pattern**: "Follow notify() pattern" — use setTimeout + notify inside session_start, same as backfill
- **Appendix return type**: "Keep string return" — breakdown tracked via separate export from inject.ts
- **Scope**: "Heartbeat + rebuild toast only" — gaps #1 and #2. Defer telemetry and rich formatting
- **Resume toast detail**: "Per-section breakdown" — checkpoint/notes/keys tokens in the toast
- **Heartbeat text**: "Simpler format" — drop "writer armed", use just idx/hist counts

### Step 5 Decomposition
- 3 slices approved: (1) breakdown state, (2) heartbeat toast, (3) resume toast
- Foundation first: injection-breakdown.ts is independent
- Phases 2 and 3 touch different handlers in index.ts

## Plan History
- Phase 1: Injection breakdown state — approved as generated
- Phase 2: Session-start heartbeat toast — approved as generated
- Phase 3: Post-resume summary toast — approved as generated

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution         |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | ------------------ |
| code     | Phase 1 §2 (inject.ts) | src/inject.ts:305-310 | concern | code-quality | Phase 1's `buildRebuildDump` breakdown runs `stateFor(db).keysStmt.all(ctx.sid, ctx.pid)` a second time after `memoryKeysIndex` already ran the identical query earlier in the same function — contradicts "No new SQL queries" in Performance Considerations | Replace the duplicate `keysStmt.all()` call with a count derived from the `keys` variable already computed by `memoryKeysIndex`, or count rows before formatting | applied: derived keyCount from `keys.split()` instead of re-querying |
| code     | Phase 1 §2 (inject.ts) | src/inject.ts:315 | concern | code-quality | `RebuildBreakdown.actorCount` is always 0 or 1 (`actors !== undefined ? 1 : 0`) despite the interface field name and JSDoc stating "Number of active actors in the rebuild dump" — masks the actual count when multiple actors are in flight | Set `actorCount` to the real count by parsing `buildActiveActorsSection` output, or rename the field to `hasActors: boolean` if only a binary signal is needed | applied: parses markdown table rows for actual actor count |
| code     | Phase 1 §1 (injection-breakdown.ts) | <n/a> | suggestion | codebase-fit | `resetBreakdowns()` is exported but never called by any phase — dead export with no consumer | Add a `resetBreakdowns()` call to the `session_shutdown` handler in index.ts, or remove the export if never needed | applied: added resetBreakdowns() to session_shutdown in Phase 3 |
| coverage | ## Verification Notes §1 | <n/a> | blocker | verification-coverage | Note "any toast failure is logged and swallowed, never breaking the session" — no Success Criteria bullet tests the failure path (notify throwing inside safe()), no code fence mirrors the safe() wrapper around the toast code | Add a Manual Verification bullet under Phase 2: "Force a notify() failure and confirm the session handler does not crash; verify the error is logged and swallowed per SPEC §9.5" | applied: added Manual Verification bullet to Phase 2 |
| coverage | ## Verification Notes §4 | <n/a> | suggestion | verification-coverage | Note "estimateTokens uses ~4 chars/token — consistent with existing usage" — no Success Criteria bullet verifies the ratio; Phase 3 Manual's "reasonable" check is too vague to exercise the specific 4:1 constant | Add a Manual Verification bullet under Phase 3: "Run a known string through estimateTokens and confirm the result equals Math.ceil(str.length / 4)" | applied: added Manual Verification bullet to Phase 3 |

## References
- Research artifact: `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md`
- Visibility plan: `docs/VISIBILITY-PLAN.md`
- Scaling/retention plan: `docs/plans/SCALING-RETENTION-PLAN.md`
