---
date: 2026-06-18T21:20:04-0700
author: Eric Sison
commit: 7c843e1
branch: main
repository: pi-mimo-cme
topic: "Per-turn memory injection telemetry"
tags: [research, codebase, inject, injection-breakdown, footer, commands, telemetry]
status: ready
last_updated: 2026-06-18T21:20:04-0700
last_updated_by: Eric Sison
---

# Research: Per-turn memory injection telemetry

## Research Question

How does the existing `AppendixBreakdown` data flow (or fail to flow) from `buildSystemPromptAppendix` to user-facing surfaces — the persistent footer (`refreshStatus`) and `/memory status` command — and what exact wiring changes are needed to surface injection token telemetry to users?

## Summary

The `AppendixBreakdown` interface at `src/injection-breakdown.ts:13-20` is populated every turn by `buildSystemPromptAppendix` via `setAppendixBreakdown()` — both the cache-hit path (zero counts, `cached: true`) and cache-miss path (real `estimateTokens()` values, `cached: false`). However, `getAppendixBreakdown()` has **zero consumers**: `refreshStatus()` at `src/index.ts:289` reads only `FooterCounts.snapshot()`, and `statusText()` at `src/commands.ts:82` queries the DB directly. The gap is a pure wiring omission — the data exists, is correct, and is one import + a few lines of code from being visible. The main challenge is `refreshStatus()` staleness: it fires from 6 call sites, most unrelated to injection, so the footer counter must distinguish "just injected" from "showing last turn's data."

## Detailed Findings

### AppendixBreakdown data flow (injection-breakdown.ts)

- `AppendixBreakdown` interface: `instructions`, `projectMem`, `globalMem`, `keys`, `cached` — `src/injection-breakdown.ts:13-20`
- Module-level `let lastAppendix: AppendixBreakdown | undefined` — `src/injection-breakdown.ts:39`
- `setAppendixBreakdown(b)` stores to `lastAppendix` — `src/injection-breakdown.ts:42-44`
- `getAppendixBreakdown()` returns `lastAppendix` — `src/injection-breakdown.ts:53-55`
- `resetBreakdowns()` clears both `lastAppendix` and `lastRebuild` — `src/injection-breakdown.ts:63-66`
- No file imports `getAppendixBreakdown` — confirmed by grep; only `getRebuildBreakdown` and `resetBreakdowns` are imported at `src/index.ts:48`

### Appendix builder dual path (inject.ts)

- Cache-key computation uses `statSync` (mtimeNs/size) on both MEMORY.md files + `memory_fts` COUNT/MAX — `src/inject.ts:183-194`
- **Cache-hit path** (`src/inject.ts:208-215`): sets all four token fields to `0`, `cached: true`, returns cached string directly
- **Cache-miss path** (`src/inject.ts:217-255`): builds sections from `buildMemoryInstructions(ctx)` (line 226), `budgetedRead(projectPath, ctx.caps.memory)` (line 229), `budgetedRead(globalPath, ctx.caps.global)` (line 234), `memoryKeysIndex(db, ctx, dumped)` (line 239); calls `setAppendixBreakdown` with `estimateTokens()` per section (lines 247-252)
- `cached` boolean is set: `true` on cache-hit, `false` on cache-miss — the primary consumer gate for footer display

### Token estimate undercount

- `instructions` field estimates `sections[0]!` (includes heading) — accurate
- `projectMem`, `globalMem`, `keys` fields estimate raw content variables *before* their `## heading` prefix is prepended — undercount by ~5-6 tokens per section (~22 tokens total, ~0.09% error at 24K) — `src/inject.ts:247-251` vs `src/inject.ts:228-240`
- `estimateTokens` at `src/budget.ts:7` is `Math.ceil(text.length / 4)`

### Footer integration (index.ts)

- `refreshStatus()` at `src/index.ts:289-298`: reads `counts.snapshot()`, builds SGR-colored `󰍛 <idx> idx · <hist> hist` string
- `fmtK()` at `src/index.ts:301-303`: existing formatter — `≥1000` → `"1.2K"`, `<1000` → `"847"`
- `getAppendixBreakdown()` is NOT imported — only `getRebuildBreakdown` and `resetBreakdowns` at `src/index.ts:48`
- **Proposed change**: add `getAppendixBreakdown` import, conditionally append `· ↻ ${fmtK(total)} injected` when `ab && !ab.cached`
- **Staleness concern**: `refreshStatus()` fires from 6 sites (`src/index.ts:364, 474, 491, 577, 595, 642`), most unrelated to injection — the `!ab.cached` flag indicates "last turn was a cache miss," not "injection just happened"

### /memory status integration (commands.ts)

- `statusText()` at `src/commands.ts:82-125`: builds `lines` array with memory index, history counts, actors, DB size, dream/distill timestamps, session/project paths
- Renders via `showReadout()` → `pi.sendMessage({ customType: "mimo-cme:status", content, display: true })` at `src/commands.ts:378`
- `getAppendixBreakdown` is NOT imported in `commands.ts`
- **Proposed insertion**: between `global ${globalMemoryPath(root)}` (line 118) and the `return`, add a 7-line injection subsection reading from `getAppendixBreakdown()`
- Push caps available via `deps.config.checkpoint.pushCaps` — can show "X tokens (of Y cap)" format

### Caps-to-breakdown mapping

- Default caps: `memory: 10_000`, `global: 6_000`, `memoryKeys: 500` — `src/config.ts:67-70`
- Caps flow through `InjectContext.caps` → `buildSystemPromptAppendix` → `budgetedRead(path, cap)` — caps determine truncation, not token estimates directly
- `AppendixBreakdown` stores actual estimated tokens, NOT caps — to show "X of Y cap" the consumer must access `deps.config.checkpoint.pushCaps` separately

### undefined handling

- `resetBreakdowns()` at `src/index.ts:673` (inside `session_shutdown` handler at `src/index.ts:664`) clears `lastAppendix`
- Between `session_start` and the first `before_agent_start`, `getAppendixBreakdown()` returns `undefined` — both consumers must guard
- After the first `before_agent_start` fires `buildSystemPromptAppendix` at `src/index.ts:517`, `lastAppendix` is populated for the remainder of the session

### One-shot toast approach (simpler alternative)

- The rebuild summary toast at `src/index.ts:540-553` is the proven pattern: read `getRebuildBreakdown()`, gate on `ctx.hasUI`, build parts array, call `notify()`
- A one-shot injection toast could fire after `buildSystemPromptAppendix` at `src/index.ts:517`, gating on `!ab.cached` — fires once per appendix change (typically once per session)
- No `refreshStatus` integration needed, no staleness management, no new failure surface
- The heartbeat toast at `src/index.ts:493-501` uses `setTimeout(2000)` deferral (unique to `session_start`); the injection toast would NOT need `setTimeout` since it fires in `before_agent_start`

### Test gap

- `test/inject.test.ts:27-70`: tests caching semantics but does NOT assert `setAppendixBreakdown` was called with expected values
- No `test/injection-breakdown.test.ts` file exists
- Proposed assertions: after each `buildSystemPromptAppendix` call, `getAppendixBreakdown()` should verify `cached` flag and token field values (zeroed on hit, real on miss)

## Code References

- `src/injection-breakdown.ts:13-20` — `AppendixBreakdown` interface definition
- `src/injection-breakdown.ts:39-44` — `lastAppendix` state + `setAppendixBreakdown`
- `src/injection-breakdown.ts:53-55` — `getAppendixBreakdown` getter (zero consumers today)
- `src/injection-breakdown.ts:63-66` — `resetBreakdowns` clears state
- `src/inject.ts:183-194` — `appendixCacheKey` computation (statSync + memory_fts agg)
- `src/inject.ts:208-215` — cache-hit path: zero counts, `cached: true`
- `src/inject.ts:217-255` — cache-miss path: section assembly + `setAppendixBreakdown`
- `src/inject.ts:228-240` — section building: raw content variables (project/global/keys) without headings
- `src/inject.ts:247-252` — `setAppendixBreakdown` call with `estimateTokens` per section
- `src/index.ts:48` — current imports from `injection-breakdown.ts` (missing `getAppendixBreakdown`)
- `src/index.ts:289-298` — `refreshStatus()` footer builder
- `src/index.ts:301-303` — `fmtK()` token formatter
- `src/index.ts:540-553` — rebuild breakdown toast (proven pattern for injection toast)
- `src/index.ts:514-519` — `inject_system_prompt` handler where injection toast would fire
- `src/index.ts:664-673` — `session_shutdown` handler calling `resetBreakdowns`
- `src/commands.ts:82-125` — `statusText()` `/memory status` builder
- `src/commands.ts:378` — `showReadout` rendering path
- `src/budget.ts:7-9` — `estimateTokens` definition
- `src/config.ts:65-72` — default push caps (`memory:10K, global:6K, memoryKeys:500`)
- `test/inject.test.ts:27-70` — existing test (no breakdown assertions)

## Integration Points

### Inbound References
- `src/inject.ts:215` — `setAppendixBreakdown` called on cache-hit path
- `src/inject.ts:251` — `setAppendixBreakdown` called on cache-miss path
- `src/injection-breakdown.ts:42` — `setAppendixBreakdown` stores to module-level `lastAppendix`

### Outbound Dependencies
- `src/budget.ts:7` — `estimateTokens` used to compute section token counts
- `src/config.ts:65-72` — `DEFAULT_CONFIG.checkpoint.pushCaps` determines truncation caps
- `src/inject.ts:183-194` — `appendixCacheKey` determines cache-hit vs cache-miss

### Infrastructure Wiring
- `src/index.ts:48` — import site (needs `getAppendixBreakdown` added)
- `src/index.ts:289-298` — `refreshStatus()` (footer rendering, needs injection segment)
- `src/index.ts:514-519` — `inject_system_prompt` handler (toast firing point)
- `src/commands.ts:82-125` — `statusText()` (needs injection subsection)
- `src/index.ts:664-673` — `session_shutdown` (calls `resetBreakdowns`)

## Architecture Insights

- **FooterCounts pattern for lightweight shared state**: module-level state with exported get/set/reset functions, no pi import — `injection-breakdown.ts` already follows this exact pattern
- **Dual consumer, single data source**: `getAppendixBreakdown()` serves both footer and `/memory status` from the same module-level `lastAppendix`; no per-turn SQL needed
- **`cached` boolean as display gate**: on cache-hit, all four token fields are zero AND `cached: true` — consumers can gate on `!ab.cached` to suppress display on unchanged turns
- **Heading undercount is negligible**: ~22 tokens (~0.09%) stripped from estimates because content variables don't include their `## heading` prefix — acceptable for display purposes
- **Staleness is the main footer challenge**: `refreshStatus()` fires from 6 sites, only one of which (`inject_system_prompt`) follows an injection event — the `!ab.cached` flag indicates "last turn was a cache miss," not "injection just happened"

## Precedents & Lessons

4 similar past changes analyzed.

### Precedent: Instrument checkpoint-writer token cost (Phase 3 "measure first")
**Commit(s)**: `bab0a37` — "Instrument checkpoint-writer token cost" (2026-06-13)
**Blast radius**: 9 files across 4 layers (db, checkpoint, index, commands)

**Follow-up fixes**:
- `f1898a5` — fix(footer): drop redundant actor count from status line (2026-06-13) — removed a footer segment duplicated by another extension's rendering
- `24e0ce5` — Fix /memory readout delivery (2026-06-13) — `/memory` output silently parked because `sendUserMessage` was queued; gated display behind `isIdle()` check

**Lessons from docs**:
- `.rpiv/artifacts/plans/2026-06-18_20-18-18_memory-alive-heartbeat-short-sessions.md:63` — per-turn footer injection telemetry explicitly deferred as gap #3

**Takeaway**: Any new `/memory` readout must use the non-queued `sendMessage` path; any new footer segment must be checked for overlap with other extensions' output.

### Precedent: Cache footer counters to drop per-turn COUNT(*) queries
**Commit(s)**: `901c954` — "Cache footer counters to drop per-turn COUNT(*) queries" (2026-06-13)
**Blast radius**: 6 files across 2 layers (footer-counts, index, commands)

**Follow-up fixes**:
- `09547cc` — style(footer): swap brain emoji for nerdfont glyph, render status line gray (2026-06-15) — cosmetic follow-up

**Takeaway**: New injection telemetry must use in-memory state (like `getAppendixBreakdown()`), never per-turn SQL — matching the `FooterCounts` pattern.

### Precedent: Show live memory state in the persistent footer
**Commit(s)**: `4093c1d` — "Show live memory state in the persistent footer" (2026-06-12)
**Blast radius**: 1 file, 1 layer

**Follow-up fixes**:
- `901c954` — replaced raw COUNT(*) with cached counters (perf fix, 1 day later)
- `f1898a5` — removed redundant actor count (1 day later)
- `09547cc` — cosmetic polish (2 days later)

**Takeaway**: Footer changes get rapid iteration — expect 2-3 follow-up commits for perf/correctness/cosmetic polish.

### Precedent: Add subagent/actor ledger (Phase 2)
**Commit(s)**: `72f95f3` — "Add subagent/actor ledger" (2026-06-13)
**Blast radius**: 22 files across 7 layers

**Follow-up fixes**:
- `0691e69` — Scope actor ledger to background subagents; fix token-object parsing (2026-06-13) — `tokens` arrived as `{input,output,total}` not a scalar; pi-subagents only fires lifecycle events for BACKGROUND agents

**Takeaway**: Real-runtime smoke tests catch contract mismatches that unit tests never will — especially when consuming another extension's event bus.

### Composite Lessons
- **`/memory` readout output requires the non-queued `sendMessage` path** — the `24e0ce5` fix shows queued `sendUserMessage` silently parks output
- **Footer segments must be checked for overlap with other extensions** — `f1898a5` removed a redundant actor count the same day it was added
- **Per-turn injection telemetry should use in-memory state, not SQL** — `901c954` established the `FooterCounts` pattern; `getAppendixBreakdown()` already provides it
- **Footer formatting details see rapid iterative polish** — plan for iteration; make the injection segment cheap to change
- **Real-event-bus smoke tests catch what unit tests miss** — `0691e69` found payload shape mismatches invisible to unit tests

## Historical Context (from `.rpiv/artifacts/`)

- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md` — prior research that originally scoped injection telemetry; recommended `{ appendix, breakdown }` return (plan chose module-level state instead)
- `.rpiv/artifacts/plans/2026-06-18_20-18-18_memory-alive-heartbeat-short-sessions.md` — plan for gaps 1-2 that created the `injection-breakdown.ts` foundation; gap #3 (this research) explicitly deferred

## Developer Context

## Related Research

- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md` — original research that scoped the memory-alive heartbeat and injection telemetry features

## Open Questions

- **Staleness mitigation**: Should the footer counter use a `injectionJustHappened` flag (set by `inject_system_prompt`, cleared after first `refreshStatus` read) to avoid showing stale injection data on unrelated footer updates? Or should the counter always display the last-known appendix size regardless of when it was computed?
- **One-shot toast vs. footer**: Should implementation start with the simpler one-shot toast (proven pattern, ~10 lines, no `refreshStatus` changes) and iterate to the footer counter, or go straight to the footer counter as the VISIBILITY-PLAN.md primary mechanism?
- **Cap display**: Should `/memory status` show "X tokens (of Y cap)" using `deps.config.checkpoint.pushCaps`, or just raw token counts? The breakdown doesn't store caps — the consumer must access config separately.
