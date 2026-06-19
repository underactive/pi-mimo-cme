---
date: 2026-06-18T22:30:27-0700
author: Eric Sison
commit: 7c843e1
branch: main
repository: pi-mimo-cme
topic: "Rich /memory command output"
tags: [research, codebase, commands, memory, status, search, metrics, validations]
status: ready
last_updated: 2026-06-18T22:30:27-0700
last_updated_by: Eric Sison
---

# Research: Rich /memory command output

## Research Question
How does the `/memory` command surface currently work, and what are the integration points, data flows, and architectural patterns that would need to be understood to enhance its output with richer formatting, additional metrics, or new diagnostic information?

## Summary
The `/memory` command is a hub with 7 subcommands (status, search, metrics, validations, dream, distill, clear), each with distinct backend paths. The status readout issues 5 sequential SQL queries against `DatabaseSync`, search uses FTS5 with OR-join + relative score floor, metrics aggregates writer token usage for a Phase 3 fork-writer verdict, and validations tracks checkpoint quality for Phase 2 gate. All display-only readouts use `showReadout()` which routes through `pi.sendMessage({ customType, content, display: true })` — the non-queued path that renders in UI. The `deliverAs:"nextTurn"` approach was rejected because it silently parked output in an invisible queue. Key architectural constraints: (1) never use raw `ctx.ui` after async boundaries (use `latestCtx` shim), (2) use in-memory cached state (FooterCounts pattern) instead of per-turn SQL, (3) check for cross-extension footer overlap, (4) all new readouts must follow the `statusText() → showReadout()` template.

## Detailed Findings

### Command Dispatch Architecture
- `/memory` registered at `src/commands.ts:189` via `pi.registerCommand("memory", ...)`
- Handler at `src/commands.ts:195` parses subcommand from trimmed args
- Default (no subcommand or "status") falls through to `statusText()` at line 319
- Search at line 315, metrics at line 263, validations at line 266, dream/distill at lines 295-298, clear at line 260

### Status Readout (`/memory status`)
- `statusText()` at `src/commands.ts:74-121` issues 5 SQL queries:
  1. Scope-grouped memory counts: `SELECT scope, COUNT(*) FROM memory_fts GROUP BY scope` (line 77-79)
  2. Total history count: `SELECT COUNT(*) FROM history_fts` (line 80-81)
  3. Per-project history count: `SELECT COUNT(*) FROM history_fts WHERE project_id = ?` (line 82-84)
  4. Per-session actor status breakdown: `SELECT status, COUNT(*) FROM actor WHERE session_id = ? GROUP BY status` (line 85-88)
  5. Dream/distill timestamps via `metaGet(db, key)` (lines 97-99, 111-112)
- DB size via `fs.statSync(dbPath(root)).size` (lines 90-93)
- Output assembled at lines 99-120, rendered via `showReadout(ctx, "mimo-cme:status", content)` at line 319

### Search Pipeline (`/memory search`)
- Dispatch at `src/commands.ts:315` splits query from args
- Optional `reconcileAndNotify()` if `config.checkpoint.reconcileOnSearch` is true (line 301-302)
- Debounced per session via WeakMap `lastReconcileAt` at line 151 (default 4000ms)
- Calls `memorySearch(deps.db, {query, limit: 10, floorRatio: config.checkpoint.scoreFloor})` at line 305
- `memorySearch()` at `src/fts.ts:69`:
  - `buildFtsQuery()` at line 14 tokenizes into `\p{L}\p{N}_+` runs, OR-joins them
  - FTS5 query against `memory_fts_idx` JOIN `memory_fts` with BM25 scoring (line 76)
  - Sign-flip at lines 92-93 (BM25 returns lower-is-better)
  - `applyScoreFloor()` at line 46-53: keeps row i if `i === 0 || score >= top * ratio`
- Results formatted at lines 307-312, rendered via `showReadout(ctx, "mimo-cme:search", content)`

### Memory Tool vs Command Search Divergence
- Both call same `memorySearch()` at `src/fts.ts:69`
- Tool (`src/tools.ts:51-97`) accepts additional parameters: scope, scopeId, type, limit
- Tool output (`src/tools.ts:24-39`) includes scope/type metadata, escalation ladder, authoritative footer
- Command output (`src/commands.ts:307-312`) is compact: score + path on one line, no metadata
- Both share `config.checkpoint.scoreFloor` default of 0.15

### Metrics Readout (`/memory metrics`)
- `metricsText()` at `src/commands.ts:142-175` calls `writerMetricsSummary()` twice (project + global)
- `writerMetricsSummary()` at `src/db.ts:172-200` aggregates `AVG(writer_input)`, `AVG(parent_tokens)`, etc.
- Fork verdict at lines 155-165: computes `forkBestCase = avgParentTokens * 0.1` (10% cache-read price)
- If `forkBestCase > avgInput` → "fork LOSES even best case" → Phase 3 not worth building
- `parent_tokens` captured at fire time in `src/checkpoint.ts:280` (nullable, SQLite AVG ignores NULLs)

### Validations Readout (`/memory validations`)
- `validationText()` at `src/commands.ts:188-224` calls `validationSummary()` twice (project + global)
- `validationSummary()` at `src/db.ts:244-289` runs two queries:
  1. Aggregate stats: `cleanCount`, `withError`, `withExtract`, `withWarn`, averages, `maxOverrunPct`
  2. Code histogram: fetches all `codes` strings, tallies in JS
- Data populated by `validateAndLog()` at `src/checkpoint.ts:425-450` after every successful writer run
- `validateCheckpoint()` at `src/checkpoint-validator.ts:87-156` runs 12 checks (8 error, 1 extract-required, 3 warn)
- Phase 2 gate: `cleanCount`/`withError`/`withExtract` ratios determine if retry+revert can be enabled

### ShowReadout Rendering Path
- `showReadout()` at `src/commands.ts:263-268` checks `ctx.isIdle()`, then calls `pi.sendMessage({ customType, content, display: true })`
- Historical bug: `deliverAs:"nextTurn"` parked output in `_pendingNextTurnMessages` — invisible, never rendered
- Idle guard exists because `sendMessage` throws mid-stream; readouts are instant to re-run
- All display-only readouts (status, search, metrics, validations) use this pattern
- `/memory clear` uses `pi.sendMessage` directly (not through `showReadout`) due to async confirmation flow

### Config Surface
- Three knobs in `src/config.ts:36-41`:
  - `checkpoint.scoreFloor` (number, default 0.15) — relative BM25 score floor
  - `checkpoint.reconcileOnSearch` (boolean, default true) — tree walk before search
  - `checkpoint.reconcileDebounceMs` (number, default 4000) — debounce window
- Loaded from `<root>/config.json` via `loadConfig()` at `src/config.ts:73-78`
- Malformed values silently ignored (type guards at lines 86-88)

## Code References
- `src/commands.ts:74-121` — statusText() function, 5 SQL queries
- `src/commands.ts:142-175` — metricsText() function, Phase 3 fork verdict
- `src/commands.ts:188-224` — validationText() function, Phase 2 gate readout
- `src/commands.ts:263-268` — showReadout() rendering gateway
- `src/commands.ts:250-256` — deliverAs:"nextTurn" bug documentation
- `src/commands.ts:315-319` — /memory search dispatch
- `src/fts.ts:14-20` — buildFtsQuery() tokenization
- `src/fts.ts:46-53` — applyScoreFloor() relative threshold
- `src/fts.ts:69-95` — memorySearch() FTS5 query
- `src/db.ts:172-200` — writerMetricsSummary() aggregation
- `src/db.ts:244-289` — validationSummary() aggregation + histogram
- `src/checkpoint.ts:280` — parent_tokens capture at fire time
- `src/checkpoint.ts:393-420` — recordMetrics() persistence
- `src/checkpoint.ts:425-450` — validateAndLog() post-write validation
- `src/checkpoint-validator.ts:87-156` — validateCheckpoint() pure function (12 checks)
- `src/checkpoint-validator.ts:218-230` — summarizeViolations() rollup
- `src/config.ts:36-41` — search config knobs
- `src/tools.ts:24-39` — formatMemoryHits() tool output
- `src/tools.ts:51-97` — memory tool handler
- `src/paths.ts:28` — dbPath() resolution
- `src/paths.ts:73-75` — projectId() hash computation

## Integration Points

### Inbound References
- `src/index.ts:160-260` — runWriter() populates writer_metrics table
- `src/index.ts:406` — maybeAutoPass() sets dream/distill timestamps
- `src/index.ts:597-611` — refreshStatus() updates live footer (cached counters)
- `src/reconcile.ts` — reconcileAndNotify() shared by search + memory tool

### Outbound Dependencies
- `src/db.ts` — DatabaseSync handle, all SQL queries
- `src/paths.ts` — dbPath(), projectId(), configPath()
- `src/config.ts` — loadConfig(), DEFAULT_CONFIG
- `src/fts.ts` — memorySearch(), buildFtsQuery(), applyScoreFloor()
- `src/checkpoint-validator.ts` — validateCheckpoint(), summarizeViolations()

### Infrastructure Wiring
- `src/index.ts:105` — openDb(dbPath(root)) creates DatabaseSync handle
- `src/index.ts:159` — registerCommands() wires all /memory subcommands
- `src/index.ts:260-280` — memory tool registration
- `src/index.ts:285-300` — history tool registration

## Architecture Insights
- **Hub-and-spoke command pattern**: `/memory` as root dispatching to subcommands via callback in handler. Standalone commands (/dream, /distill) registered separately.
- **Two FTS5 search backends**: Memory uses OR-join (broad recall), history uses AND-join (tight relevance). Both share config knobs.
- **Cached state over SQL**: FooterCounts pattern (module-level get/set/reset, zero pi import) replaced per-turn COUNT(*). New count surfaces must follow this.
- **Non-queued rendering**: `sendMessage({ customType, content, display: true })` is the only correct path for UI-visible readouts. `deliverAs:"nextTurn"` silently loses output.
- **Async safety**: `latestCtx` shim required for UI work after async boundaries. Raw `ctx` invalidated on session switch/fork.
- **Measure-first instrumentation**: Both metrics (Phase 3 fork) and validations (Phase 2 retry) are "measure first" features that gate future work on real data.

## Precedents & Lessons
6 similar past changes analyzed.

### Precedent: Fix /memory readout delivery — silent parking bug
**Commit(s)**: `24e0ce5` — "Fix /memory readout delivery; drop redundant footer prefix" (2026-06-13)
**Blast radius**: 4 files across 2 layers
  src/commands.ts — gated display behind isIdle() check, switched to non-queued sendMessage path
  src/index.ts — dropped redundant 'mem ·' prefix from live footer status

**Follow-up fixes**:
- `901c954` — "Cache footer counters to drop per-turn COUNT(*) queries" (2026-06-13) — 1 day later

**Lessons from docs**:
- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md:63` — showReadout() uses non-queued sendMessage path
- `.rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md:81` — rebuild breakdown toast pattern is proven template

**Takeaway**: Any new /memory readout MUST use `sendMessage({ customType, content, display: true })` — `sendUserMessage` silently parks output.

### Precedent: Surface memory transformation events as TUI toasts
**Commit(s)**: `9e3b23c` — "Surface memory transformation events as TUI toasts" (2026-06-12)
**Blast radius**: 6 files across 3 layers
  src/commands.ts — added reconcileAndNotify shared by /memory search and memory tool
  src/checkpoint.ts — checkpoint-saved toast via CheckpointManager.run()
  src/index.ts — latestCtx shim for async UI safety, 4 toast signals

**Follow-up fixes**:
- `1ef809b` — "Harden memory hot paths and subprocess lifecycle" (2026-06-12) — same day

**Lessons from docs**:
- `.rpiv/artifacts/audits/full-codebase-audit.md` — notify() shim + latestCtx pattern safe across async boundaries
- `.rpiv/artifacts/plans/2026-06-18_20-18-18_memory-alive-heartbeat-short-sessions.md:55` — "Post-await safety via latestCtx" is established pattern

**Takeaway**: `latestCtx` shim required for UI work after async boundaries. `reconcileAndNotify` is shared pattern for search + memory tool paths.

### Precedent: Show live memory state in the persistent footer
**Commit(s)**: `4093c1d` — "Show live memory state in the persistent footer" (2026-06-12)
**Blast radius**: 1 file, 1 layer
  src/index.ts — refreshStatus() helper with `mem idx · hist` format

**Follow-up fixes**:
- `901c954` — replaced raw COUNT(*) with cached FooterCounts counters (1 day later)
- `f1898a5` — fix(footer): dropped redundant actor count (1 day later)
- `09547cc` — style(footer): cosmetic polish (2 days later)

**Lessons from docs**:
- `.rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md:55` — FooterCounts pattern is canonical
- `.rpiv/artifacts/plans/2026-06-18_21-36-24_per-turn-memory-injection-telemetry.md:75` — "footer update is zero-SQL and zero-I/O"

**Takeaway**: Footer changes get 2-3 follow-up commits within days. Check for cross-extension overlap. Use in-memory cached state.

### Precedent: Instrument checkpoint-writer token cost (Phase 3 "measure first")
**Commit(s)**: `bab0a37` — "Instrument checkpoint-writer token cost" (2026-06-13)
**Blast radius**: 9 files across 4 layers
  src/commands.ts — added /memory metrics readout
  src/db.ts — SCHEMA_V3 writer_metrics table
  src/checkpoint.ts — WriterTokenUsage + WriterResult.metrics

**Follow-up fixes**:
- `24e0ce5` — Fix /memory readout delivery (same day)
- `1ef809b` — Harden memory hot paths (same day)

**Lessons from docs**:
- `.rpiv/artifacts/plans/2026-06-18_20-18-18_memory-alive-heartbeat-short-sessions.md:63` — per-turn footer injection telemetry deferred
- `.rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md` — showReadout() uses non-queued path

**Takeaway**: When adding new /memory subcommands, gate output delivery behind isIdle() and use non-queued sendMessage path.

### Precedent: Cache footer counters to drop per-turn COUNT(*) queries
**Commit(s)**: `901c954` — "Cache footer counters to drop per-turn COUNT(*) queries" (2026-06-13)
**Blast radius**: 6 files across 2 layers
  src/commands.ts — added reseedMemory after reconcileAndNotify
  src/footer-counts.ts — NEW pure module: FooterCounts
  src/index.ts — wire reseedMemory after every reconcile
  src/tools.ts — wire reseedMemory in memory tool reconcile path

**Follow-up fixes**:
- `09547cc` — style(footer): cosmetic polish (2 days later)

**Lessons from docs**:
- `.rpiv/artifacts/plans/2026-06-18_20-18-18_memory-alive-heartbeat-short-sessions.md:48` — FooterCounts pattern is reference
- `.rpiv/artifacts/validation/2026-06-18_20-56-36_memory-alive-heartbeat-short-sessions.md` — injection-breakdown.ts follows same pattern

**Takeaway**: Any new /memory readout showing counts must use cached state, never direct SQL. In-memory, no-pi-import pattern is architectural invariant.

### Composite Lessons
- **#1 — Output delivery must use the non-queued path**: `/memory` output silently parked because `sendUserMessage` was used instead of `sendMessage({ customType, content, display: true })`. Every new subcommand must funnel through `showReadout()`.
- **#2 — Never use raw `ctx.ui` after async boundary**: `latestCtx` shim exists because pi invalidates captured `ctx` after session switch/fork/reload. Any new output after async gap must use `notify()` shim.
- **#3 — Footer segments must be checked for cross-extension overlap**: Actor count duplicated by pi-subagents required revert within 1 day. Any footer enhancement must check other active extensions.
- **#4 — In-memory state, never per-turn SQL**: FooterCounts pattern replaced two per-turn COUNT(*) queries within 1 day. New count surfaces must read from cached state.
- **#5 — Three-layer precedent for readout sections**: `statusText()`, `metricsText()`, `validationText()` pattern is established. New enhancements should add formatting function following `showReadout(ctx, customType, content)` template.
- **#6 — Rich formatting was explicitly deferred twice**: Heartbeat plan defers "Rich /memory formatting with icons and ASCII bars" as gap #4. Injection telemetry plan defers "add injection breakdown section to `/memory status`" to follow-up.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md` — memory system architecture and heartbeat design
- `.rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md` — injection telemetry patterns and footer integration
- `.rpiv/artifacts/plans/2026-06-18_20-18-18_memory-alive-heartbeat-short-sessions.md` — heartbeat plan with deferred gaps
- `.rpiv/artifacts/plans/2026-06-18_21-36-24_per-turn-memory-injection-telemetry.md` — injection telemetry plan
- `.rpiv/artifacts/validation/2026-06-18_20-56-36_memory-alive-heartbeat-short-sessions.md` — validation report for heartbeat implementation
- `.rpiv/artifacts/audits/full-codebase-audit.md` — full codebase audit with patterns

## Developer Context
(No developer questions asked during this research — all findings are from codebase analysis.)

## Related Research
- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md` — memory system architecture
- `.rpiv/artifacts/research/2026-06-18_21-20-04_per-turn-memory-injection-telemetry.md` — injection telemetry

## Open Questions
- Should `/memory status` be enhanced with injection breakdown sections (memory instructions, MEMORY.md sizes, rebuild overhead)?
- Should the code histogram in `/memory validations` be filterable by session or time range?
- Should `/memory metrics` show non-null parent_tokens count to expose AVG bias?
- Should `/memory search` output be unified with memory tool output format for consistency?