# Memory System Visibility Plan

Four gaps where pi-mimo-cme is working but the user has no proof it's working.

---

## 1. "Memory is alive" heartbeat for short sessions ✅ DONE

### The problem

The checkpoint writer only fires when context usage crosses a threshold (auto-scaled: every 20%/10%/5%). In a short session — say 5–10 turns — the user may never see the `💾 checkpoint saved` toast. The footer shows `󰍛 42 idx · 287 hist`, which is proof of *indexing*, but nothing confirms the checkpoint/memory pipeline actually ran. A new user installs the extension, uses it for 10 minutes, and has no signal that anything happened beyond the footer counter appearing.

### Implementation summary

**Files changed:** `src/injection-breakdown.ts` (new — shared foundation with gap #2), `src/index.ts`

- **`src/injection-breakdown.ts`** — New module with `AppendixBreakdown` and `RebuildBreakdown` interfaces, module-level `let` state, and exported get/set/reset functions. Follows the `FooterCounts` no-pi-import pattern. This is the shared foundation for both the heartbeat and resume toasts.
- **`src/index.ts`** — Heartbeat toast in `session_start` handler: captures `counts.snapshot()` synchronously, then fires `setTimeout(() => notify(…), 2000)` — the 2-second delay lets the UI settle. Gated on `ctx.hasUI` so headless/pipeline modes are unaffected. Fires every session start (startup, new, resume, fork).

**Result:** On every session start, the user sees:
```
🧠 mimo-cme: memory active — 42 idx · 287 hist
```

The toast uses seeded footer counts (real numbers, not placeholders) and fires after `refreshStatus()` so the footer is already populated. `notify()` failures inside the `setTimeout` are swallowed by the notify shim's `latestCtx?.hasUI` guard — the session handler is never disrupted.

**Deferred:** The "writer armed" field from the original proposal was dropped — it's an implementation detail the user doesn't need. The `/memory status` "last heartbeat" timestamp was also deferred (gap #3's `/memory status` expansion is the right place for it).

---

## 2. Invisible rebuild dump — make it visible ✅ DONE

### The problem

After a resume, fork, or compaction, a persistent message (`mimo-cme:rebuild`) is injected into the conversation containing the checkpoint dump, notes, tasks, and memory keys. The LLM is instructed: *"Resume directly. Do not acknowledge this memory dump, do not recap."* This means the model silently absorbs it and moves on. The user sees... nothing. They don't know that 11K+ tokens of memory context was just loaded.

### Implementation summary

**Files changed:** `src/injection-breakdown.ts` (shared with gap #1), `src/inject.ts`, `src/index.ts`

- **`src/inject.ts`** — `setRebuildBreakdown` called at the end of `buildRebuildDump` before the final return. Records `checkpoint` tokens (post-budget), `notes` tokens, `keyCount` (parsed from existing `keys` string, no new query), `keysTokens`, and `actorCount` (parsed from the markdown table rows, not binary).
- **`src/index.ts`** — Post-resume toast in `inject_rebuild` handler: reads `getRebuildBreakdown()` synchronously after `buildRebuildDump` returns, conditionally builds a parts array (`checkpoint (~N tok)`, `notes (~N tok)`, `N keys`, `N actor(s)`), and fires `notify()`. Gated on `ctx.hasUI` + `rb` truthy + `parts.length > 0`.
- **`src/index.ts`** — `resetBreakdowns()` called in `session_shutdown` before `db.close()` to ensure clean state for the next session.

**Result:** On resume/fork/compaction, the user sees:
```
🧠 mimo-cme: session resumed — checkpoint (~8K tok) · notes (~3K tok) · 5 keys
```

When checkpoint is empty or all placeholder, no toast fires (graceful skip). Token estimates use `fmtK()` for readable formatting (`847` → "847", `1234` → "1.2K").

**Deferred:** Verbose rebuild header wrapper (opt-in config) — not implemented in this pass. The summary toast provides the essential visibility; verbose mode can be added independently later.

---

## 3. Per-turn memory injection telemetry ✅ DONE

### The problem

Every turn, ~17–27K tokens of memory are injected into the system prompt: memory instructions (~2–3K), project MEMORY.md (up to 10K), global MEMORY.md (up to 6K), and the keys index (up to 500). The user has no idea this is happening or how much context it consumes. If they hit context limits, they can't tell whether memory injection is the culprit. The only diagnostic is `/memory metrics`, which covers the *writer* cost, not the *injection* cost.

### Implementation summary

**Files changed:** `src/injection-breakdown.ts` (extended from gap #1), `src/inject.ts`, `src/index.ts`, `test/injection-breakdown.test.ts` (new)

- **`src/injection-breakdown.ts`** — Added `formatAppendixFooterLabel()`: a pure helper that reads the last `AppendixBreakdown` snapshot and returns a compact footer label like `· ~14.5K inject (14.5K)` (cached) or `· ~14.5K inject (0)` (non-cached). Uses a module-local `fmtK` duplicate to avoid circular dependency with `index.ts`.
- **`src/index.ts`** — `refreshStatus()` now calls `formatAppendixFooterLabel()` and conditionally appends the inject segment to the existing `󰍛 <idx> idx · <hist> hist` footer line. The single `setStatus("mimo-cme", ...)` key is preserved. The inject segment is omitted entirely before the first turn (when no breakdown exists yet).
- **`src/inject.ts`** — Added anti-redundancy rule to the `## What NOT to do` section of the injected memory instructions: "Don't repeatedly append to notes.md with overlapping or redundant entries." Prevents the agent from entering a write-notes → re-read → write-notes loop.
- **`test/injection-breakdown.test.ts`** — New unit tests covering `getAppendixBreakdown()` and `formatAppendixFooterLabel()`: undefined before first set, cached vs non-cached states, reset behavior.

**Result:** The persistent footer now reads:
```
󰍛 12 idx · 8 hist · ~14.5K inject (14.5K)
```

On a cache hit (unchanged appendix), the breakdown is set with all-zero counts and `cached: true`, so the footer shows `· ~0 inject (0)` — distinguishing it from a non-cached `· ~14.5K inject (0)`. On the first turn before any injection, the footer stays unchanged (`󰍛 12 idx · 8 hist`).

**What was dropped from the original proposal:**
- The `↻` icon was replaced with `inject` text for clarity and terminal compatibility.
- The `/memory status` expansion (section B of the original proposal) was deferred — the ambient footer is the primary surface; `/memory status` readout can build on the same `getAppendixBreakdown()` API later.
- The dimmer/hidden counter for cached state was simplified to showing `(14.5K)` vs `(0)` — always visible, cache state encoded in the parenthesized value.

**Validation:** All 124 tests passing, typecheck clean. Validated via `/skill:validate` with verdict: pass.

---

## 4. Rich `/memory` command output ✅ DONE

### The problem

`/memory` (and its subcommands) output plain text via `pi.sendMessage({ display: true })`. In a terminal UI, this reads as undifferentiated monospaced text with no visual hierarchy. Compared to other pi features that use structured rendering, `/memory` feels like a raw dump. The status output especially benefits from structure — it shows ~15 fields across 4 sections, all in the same font weight.

### Implementation summary

**Files changed:** `src/formatting.ts` (new), `src/commands.ts`, `src/index.ts`, `src/injection-breakdown.ts`

- **`src/formatting.ts`** — New shared formatting module with 6 exports: `fmtK()` (compact token display: ≥1000 → "1.2K"), `sectionHeader()` (renders `── Name ──` dividers), `bar()` (auto-width ASCII progress bar: 20 chars ≤100K, 30 chars >100K context window), `labelValue()` (column-aligned label:value), `tokenBarLine()` (label + bar + token counts), `kvLine()` (key=value with padding). Pure functions, no pi imports — follows the `FooterCounts` utility module pattern.

- **`src/commands.ts` — `statusText()`** — Complete rewrite with 6 section dividers (`Memory Index`, `Injection Overhead`, `Rebuild Dump (last resume)`, `Session`, `Project`, `Meta`). New `── Injection Overhead ──` section shows per-section token breakdown (instructions, project MEMORY.md, global MEMORY.md, keys index) with `tokenBarLine()` progress bar for the total, sourced from `getAppendixBreakdown()`. New `── Rebuild Dump ──` section shows checkpoint/notes/keys/actors/total from `getRebuildBreakdown()`. Both gracefully handle absence ("not yet computed this session" / "no rebuild yet this session"). Memory files and history rows use `tokenBarLine()` progress bars. Accepts optional `contextWindow` parameter (from `ctx.getContextUsage()`) for bar width adaptation; defaults to 200K.

- **`src/commands.ts` — `metricsText()`** — Rewritten with 3 section dividers (`This Project`, `Fork Verdict`, `All Projects`). New `parent ctx` line in All Projects section exposes `avgParentTokens` across all projects. `okRate` guard fixed to `proj.n > 0` (plan review catch). Accepts optional `contextWindow` for future-proofing.

- **`src/commands.ts` — `validationText()`** — Rewritten with 3 section dividers (`This Project`, `Code Histogram`, `All Projects`). Clean rate rendered with `bar()` progress bar alongside percentage. Histogram unchanged (4-space indented `code: count`).

- **`src/commands.ts` — call sites** — `/memory status` and `/memory metrics` now pass `ctx.getContextUsage()?.contextWindow` to their respective text builders. `/memory validations` unchanged (no context-dependent bars).

- **`src/index.ts`** — Local `fmtK()` definition removed (lines 304-305). Import added from `./formatting.ts`. Post-resume toast and `reportPassResult` use the shared `fmtK`.

- **`src/injection-breakdown.ts`** — Local `fmtK()` definition removed (lines 52-53). Import added from `./formatting.ts`. `formatAppendixFooterLabel()` uses the shared `fmtK`.

**Result:** All `/memory` readouts now render with:
- `── Section Name ──` dividers for visual hierarchy
- ASCII progress bars with auto-width (20 or 30 chars based on context window)
- Injection overhead and rebuild dump detail sections in `/memory status`
- Parent context tokens exposed in `/memory metrics`
- Clean rate progress bar in `/memory validations`
- Single source of truth for `fmtK()` and formatting helpers

**Validation:** All 124 tests passing, typecheck clean. Validated via `/skill:validate` with verdict: pass.

---

## Summary

| # | Gap | Signal | Status | Complexity | Impact |
|---|-----|--------|--------|------------|--------|
| 1 | Short sessions show no proof of life | One-shot session-start toast with counts | ✅ Done | Low | High — first thing a new user sees |
| 2 | Rebuild dump is invisible to the user | Post-resume toast with per-section breakdown | ✅ Done | Low | Medium — only fires on resume/fork/compact |
| 3 | Per-turn injection cost is invisible | Footer `inject` segment with total + cached breakdown | ✅ Done | Low | High — diagnostic for context limit issues |
| 4 | `/memory` output is unformatted plain text | Section dividers, ASCII bars, injection/rebuild breakdowns | ✅ Done | Medium | Medium — improves daily usability |

All four gaps are shipped. Gap 3 built on the shared `src/injection-breakdown.ts` foundation from gaps 1+2. Gap 4 consumed `getAppendixBreakdown()` and `getRebuildBreakdown()` from the same module for the new `/memory status` sections, completing the visibility story.
