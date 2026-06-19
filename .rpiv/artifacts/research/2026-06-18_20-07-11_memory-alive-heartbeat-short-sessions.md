---
date: 2026-06-18T20:07:11-0700
author: Eric Sison
commit: 7c843e1
branch: main
repository: pi-mimo-cme
topic: "Memory is alive heartbeat for short sessions"
tags: [research, codebase, memory-visibility, session-start, footer, injection-telemetry]
status: ready
last_updated: 2026-06-18T20:07:11-0700
last_updated_by: Eric Sison
---

# Research: Memory is alive heartbeat for short sessions

## Research Question
How do session-start heartbeats, rebuild-dump visibility, per-turn injection telemetry, and richer `/memory` output surface memory-pipeline liveness in short sessions, and what code seams support each addition?

## Summary
Short sessions miss the checkpoint-saved toast because thresholds aren’t crossed. The fix is a one-shot session-start heartbeat, plus optional post-resume confirmation, footer injection telemetry, and clearer command output. The codebase already has the seams for all four: the `notify()` shim (`src/index.ts:89`), the session_start/footer wiring (`src/index.ts:441`, `src/footer-counts.ts:78`), the appendix cache (`src/inject.ts:114`), and the command readout path (`src/commands.ts:104`, `src/commands.ts:259`).

## Detailed Findings

### Session-start heartbeat
- Insert after `counts.seed()` + `refreshStatus()` in the `session_start` handler (`src/index.ts:441-486`).
- Use `notify()` (`src/index.ts:89`), not raw `ctx.ui.notify`, because async UI may outlive the captured `ctx`.
- Prefer the VISIBILITY-PLAN’s `setTimeout(..., 2000)` pattern (`docs/VISIBILITY-PLAN.md:20-32`) and read counts from `counts.snapshot()` (`src/footer-counts.ts:78`).
- Precedent: footer/toast work in `4093c1d`, `901c23c`, `901c954` all use the same notify/footer seam.
- Risk: capturing `ctx` across setTimeout; the `latestCtx` shim avoids the same invalidation pattern already fixed in `1ef809b`.

### Rebuild-dump visibility
- `inject_rebuild` at `src/index.ts:508-523` returns `{ message: { ... } }` after `buildRebuildDump()` (`src/inject.ts:265`).
- It can still call `notify()` as a synchronous side-effect before returning; the message return contract is unchanged.
- A post-resume toast can read token estimate from `estimateTokens(dump)` (`src/budget.ts:5`) to report restored context size.

### Per-turn injection telemetry
- `buildSystemPromptAppendix()` (`src/inject.ts:211`) currently returns a `string`.
- Returning `{ appendix, breakdown }` (with token counts per section + cache-hit boolean) lets the footer and `/memory status` show injection cost without new I/O.
- `refreshStatus()` (`src/index.ts:288`) would append `↻ <N>K` on cache-miss turns only, using `estimateTokens()` (`src/budget.ts:5`).
- The appendix cache at `src/inject.ts:114` already tracks change state; exposing it avoids the debounce concern seen in reconcile (`src/commands.ts:62-75`).

### Richer `/memory` output
- Current `/memory status` is plain text built in `statusText()` (`src/commands.ts:104-141`).
- Add `formatMemoryStatus()` in the same file (per developer decision) and reuse it for structured sections/bars/icons.
- Apply the same treatment to `/memory metrics` (`src/commands.ts:142`) and `/memory validations` (`src/commands.ts:163`) for visual consistency.

## Code References
- `src/index.ts:89` — `notify()` shim for UI toasts
- `src/index.ts:288` — `refreshStatus()` footer rendering
- `src/index.ts:441-486` — `session_start` handler (heartbeat insertion point)
- `src/index.ts:508-523` — `inject_rebuild` handler (post-resume toast insertion point)
- `src/inject.ts:110-115` — `InjectState` / appendix cache
- `src/inject.ts:182-198` — `appendixCacheKey()`
- `src/inject.ts:211-244` — `buildSystemPromptAppendix()`
- `src/inject.ts:265-293` — `buildRebuildDump()`
- `src/commands.ts:62-75` — `reconcileAndNotify()` debounce/reseed/toast pattern
- `src/commands.ts:104-141` — `statusText()` for `/memory status`
- `src/commands.ts:142-188` — `metricsText()`
- `src/commands.ts:163-195` — `validationText()`
- `src/commands.ts:259-264` — `showReadout()` message delivery
- `src/footer-counts.ts:78` — `snapshot()` for footer values
- `src/budget.ts:5` — `estimateTokens()` for token estimates
- `src/config.ts:69-77` — `pushCaps` / defaults

## Integration Points

### Inbound References
- `src/index.ts:485` — session_start footer render
- `src/index.ts:543` — message_end footer refresh
- `src/index.ts:561` — turn_end footer backstop
- `src/index.ts:602` — actor-bus footer refresh
- `src/index.ts:358` — dream-pass footer refresh
- `src/commands.ts:352` — search-triggered reconcile path
- `src/tools.ts:77` — memory-tool reconcile path

### Outbound Dependencies
- `src/inject.ts` — appendix assembly + rebuild dump
- `src/footer-counts.ts` — cached idx/hist counts
- `src/budget.ts` — token estimation
- `src/db.ts` / `src/config.ts` — status/config data sources

### Infrastructure Wiring
- `src/index.ts:499` — `inject_system_prompt` wiring
- `src/index.ts:508` — `inject_rebuild` wiring
- `src/commands.ts:323` — `/memory` command registration

## Architecture Insights
- Short-session liveness is best solved by a one-shot toast using the same `notify()` shim as other transformation events.
- Footer and command output should share a single injection-stats source; no per-turn SQL is needed.
- Post-resume confirmation can be emitted synchronously before the message return, preserving the `before_agent_start` contract.
- Visual consistency matters: `/memory status`, `/memory metrics`, and `/memory validations` should follow the same formatting approach.

## Precedents & Lessons
### Precedent: Session-start lifecycle hooks + notify shim pattern
**Commit(s)**: `4093c1d` — "Show live memory state in the persistent footer" (2026-06-12)
**Blast radius**: 1 file across 1 layer
  src/index.ts — added `refreshStatus()` + `counts.seed()` + `session_start` wiring

**Follow-up fixes**:
- `901c954` — footer counter cache (perf)
- `f1898a5` — remove redundant actor count
- `09547cc` — cosmetic footer polish

**Lessons from docs**:
- docs/VISIBILITY-PLAN.md §1 documents the exact short-session gap this heartbeat solves.

**Takeaway**: the `session_start` + notify seam is the proven insertion point.

### Precedent: Transformation-event toasts (notify shim)
**Commit(s)**: `9e3b23c` — "Surface memory transformation events as TUI toasts" (2026-06-12)
**Blast radius**: 6 files across 3 layers
  src/index.ts — latestCtx shim + reportPassResult + notify helper
  src/commands.ts — reconcileAndNotify gating
  src/checkpoint.ts — checkpoint-saved toast
  src/reconcile.ts — globalIndexed stats
  src/tools.ts — notify in CommandDeps

**Follow-up fixes**:
- `1ef809b` — harden hot paths; fix post-await ctx invalidation
- `24e0ce5` — fix /memory readout delivery

**Takeaway**: use the `latestCtx` shim for any delayed toast; never rely on captured ctx after awaits/timeouts.

### Composite Lessons
- Post-await ctx invalidation keeps recurring (`1ef809b`, `9e3b23c`).
- The same counts shown in footer and toast must agree and be seeded once per session.
- A dedicated `formatMemoryStatus()` in `commands.ts` is acceptable for now; reuse it for metrics/validations.
- Footer injection badge should use `↻ <N>K` on changed turns only.

## Historical Context (from `.rpiv/artifacts/`)
- `docs/VISIBILITY-PLAN.md` — authoritative visibility gap list and proposed signals
- `docs/plans/SCALING-RETENTION-PLAN.md` — footer counter cache and invariant discipline

## Developer Context
**Q (`src/commands.ts:104`): For `/memory status`, should the new formatting live in `src/commands.ts` or a new `src/formatting.ts`, and which outputs should adopt the same style?**
A: Keep in `src/commands.ts`.

**Q (telemetry scope): Should per-turn injection telemetry appear only in `/memory status`, or also in the footer?**
A: Both, with different detail levels.

**Q (footer icon): Which icon/format should the footer injection badge use?**
A: Use `↻ <N>K`.

## Related Research
- Prior footer/perf work captured in scaling/retention plans and audit artifacts

## Open Questions
- Should the post-resume toast include per-section breakdown (checkpoint vs notes vs keys) or only total tokens?
- Should injection telemetry omit the badge entirely on fully cached turns, or dim it instead?
