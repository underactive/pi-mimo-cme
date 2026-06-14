# Future improvements

A single registry of **deferred / proposed** work for pi-mimo-cme. Each item is fully
designed in its source plan under `docs/plans/`; this file is the index — what's deferred,
**why**, and the **gate** (the concrete condition that should trigger picking it up) so
nobody rebuilds the analysis. When an item ships, move it out of here and mark its plan done.

> **For humans — what this file is for.**
> The detailed plans answer "*how* would we build X." This file answers "*should we build X
> yet, and what would tell us it's time.*" Most of these are intentionally **off by default**
> or **waiting on data** — they're not bugs or unfinished work, they're decisions parked until
> a real signal justifies the cost. Read the "Gate" line for each: that's the trip-wire.

| # | Item | Source plan | Status | Gate (build when…) |
|---|------|-------------|--------|--------------------|
| 1 | Checkpoint validator **Phase 2** — reflection-retry + revert | `plans/CHECKPOINT-VALIDATOR-PLAN.md` §5 | Designed, decisions pinned, **gated on Phase 1 data** | Phase 1 logs show errors are occasional (not the norm), overruns cluster under tolerance, and no rule fires spuriously |
| 2 | `history_fts` **retention prune** | `plans/SCALING-RETENTION-PLAN.md` Phase 2 | Proposed, opt-in (default OFF) | History DB size/latency becomes a real cost, or a user wants bounded retention |
| 3 | **GC consolidated session folders** | `plans/SCALING-RETENTION-PLAN.md` Phase 3 | Proposed, opt-in (default OFF), depends on #2 infra | Session-folder count grows unbounded enough to matter (after #2 ships) |
| 4 | **Scope/cache reconcile's tree walk** | `plans/SCALING-RETENTION-PLAN.md` Phase 4 | Proposed, pure perf | The per-search reconcile walk (O(all machine-wide sessions)) shows up as turn latency |
| 5 | **True prefix-cache fork** for the writer | `plans/SUBAGENT-INTEGRATION-PLAN.md` §6 Phase 3 | Deferred — *likely never*; measure-first shipped | `/memory metrics` data overturns the SDK-archaeology finding that a fork is a net cost regression (not expected) |
| 6 | **Cross-session task history** (`task_event` log / Option B) | `plans/SUBAGENT-INTEGRATION-PLAN.md` §7.4 | Deferred | A use case needs task history across sessions (the §4/rebuild use case does not) |

---

## 1. Checkpoint validator Phase 2 — reflection-retry + revert

**The headline deferred item.** Phase 1 (shipped) validates every checkpoint and *records*
what's out of spec but never acts. Phase 2 makes the validator **enforce**: on an
`error`/`extract-required` violation it re-prompts the same in-process writer session to fix
it (up to **2** retries, reusing the prefix cache), and if it still can't, **reverts to the
prior checkpoint**.

**Decisions already pinned** (so Phase 2 is build-ready, no re-litigation):
- **Severity ladder** — `warn` logs only, `error` forces a redo, `extract-required` forces a
  spillover extraction.
- **Retry cap = 2**, then accept what exists.
- **Give-up = revert to the prior checkpoint**, with the refinement (`§0.1`) that revert does
  **not** advance `last_checkpoint_seq` — so the next cycle retries the same delta plus more,
  deferring the content rather than discarding it — plus a **2-consecutive-revert livelock
  guard** that accepts best-effort once, so checkpointing can never permanently stall.

**Gate (build when):** Phase 1's `/memory validations` histogram, over a representative span
of real sessions, shows (a) the per-run `error` rate is low enough that retries are
occasional, (b) budget overruns cluster below a tolerance that won't constantly trip
`extract-required`, and (c) no rule fires spuriously (watch the §1 first-checkpoint case,
plan §3.4). Quantify these from the actual data — don't guess.

**Where to look:** full design in `plans/CHECKPOINT-VALIDATOR-PLAN.md` §5 (contract change,
control flow, snapshot/revert) and §0 (pinned decisions). The shipped Phase 1 left the seams
ready: `WriterResult` is the place to add `endedValid`/`reflectionAttempts`, the
`checkpoint_validations` table already has `reflection_attempts`/`reverted`/`ended_valid`
columns waiting, and `summarizeViolations` already produces the actionable set.

> **For humans — what's left to wire.** Phase 1 built the *detector and the database columns*
> for the verdict. Phase 2 is the *loop and the undo button*: keep the writer's session alive
> for one or two more "you missed X, fix it" turns, and if it still fails, restore the previous
> file. The hard thinking (how strict, how many tries, what happens on give-up) is done; what
> remains is the plumbing in two functions (`runWriter` in `index.ts`, `run()` in
> `checkpoint.ts`).

---

## 2. `history_fts` retention prune

`history_fts` (the layer-4 conversation firehose) is **insert-only** and machine-wide — the
dominant data-size vector. Phase 2 of the scaling plan adds **opt-in** retention (`maxAgeDays`
/ `maxRowsPerProject`) that prunes inside the dream-completion pass (a proven, infrequent,
project-scoped cadence), routing all deletes through the FTS5 `_ad` trigger + an `'optimize'`
maintenance command to keep the index consistent (the war story).

**Default behavior is unchanged** (absent config ⇒ unlimited, exactly as today).

**Gate (build when):** the shared `memory.db` grows large enough that size or query latency
matters, or a user explicitly wants bounded history. Full design + prune SQL + FTS discipline:
`plans/SCALING-RETENTION-PLAN.md` Phase 2.

---

## 3. GC consolidated session folders

One `sessions/<sid>/` folder is created per session and never removed; each adds a
`checkpoint.md`/`notes.md` row to `memory_fts`. Small per session, unbounded in count. Phase 3
deletes a session folder only when it's safe (not live, non-empty checkpoint, a dream has run
since its last checkpoint, and it's outside a keep window), letting reconcile's existing
vanished-file prune clean the index — so **no bespoke index code** is needed.

**Reuses Phase 2's retention infra**, so it follows #2 in dependency order. Opt-in; absent
config ⇒ keep everything. Note the layer boundary: this GCs *our* markdown session layer, not
`history_fts` (which is #2's job). Full design: `plans/SCALING-RETENTION-PLAN.md` Phase 3.

---

## 4. Scope/cache reconcile's tree walk

`reconcile` walks every session folder across **all** projects on the first `/memory search`
per session and after each dream — O(total machine-wide sessions). Phase 4 makes the walk
**incremental** with an mtime-gated descent (skip session subtrees unchanged since the last
walk), keeping a periodic full walk + the per-file fingerprint as the correctness backstop.

Pure performance, no data-semantics change; benefits compound once #2/#3 manage session count.

**Gate (build when):** the reconcile walk shows up as per-turn latency (the authors already
flag this in the `reconcileDebounceMs` config comment). Full design:
`plans/SCALING-RETENTION-PLAN.md` Phase 4.

---

## 5. True prefix-cache fork for the writer (likely never)

A `checkpoint.fork` flag that seeds the writer session with the parent's exact prefix + tool
schema for real provider cache reuse (MiMoCode parity). **The measure-first prerequisite has
shipped** (the `writer_metrics` table + `/memory metrics` verdict), but an SDK investigation
argues the fork should stay unbuilt: a real cache-read requires a byte-identical tool block,
which would force re-binding this extension into the writer session (the recursion Phase 1
removed) and would make the writer carry the *entire* parent context every checkpoint — a
likely **net cost regression**, not a win.

**Gate (build when):** `/memory metrics` data, after real sessions cross the 20/40/60/80%
thresholds, **overturns** that finding (i.e., shows the writer's full-price cold-start input
genuinely exceeds what a cache-warm fork would carry). Not expected. Full reasoning:
`plans/SUBAGENT-INTEGRATION-PLAN.md` §6 Phase 3.

> **For humans — why "measure first."** Instead of betting on whether a clever caching trick
> pays off, the writer now logs its actual cost every run. `/memory metrics` turns that into a
> plain verdict. The current data and the SDK analysis both say "don't build it" — but the
> instrumentation is there so the decision stays evidence-based, not a guess.

---

## 6. Cross-session task history (`task_event` log / Option B)

The shipped §4 "Task tree" reads a live **snapshot** of the user task graph from
`@juicesharp/rpiv-todo`. It does **not** keep an append-log of task events or task history
across sessions (rpiv-todo's model is snapshot-only; timestamps and a parent/child tree aren't
in its `Task` type). Option B — a `task`/`task_event` table fed by observing
`tool_execution_end` for `toolName==="todo"` — would add cross-session history.

**Gate (build when):** a real use case needs task history beyond the current session (the §4
checkpoint + rebuild use case does not). Full fidelity-gap analysis:
`plans/SUBAGENT-INTEGRATION-PLAN.md` §7.4.

---

## Conventions

- Backtick paths (`` `src/foo.ts` ``) are repo-root-relative; markdown links (`plans/X.md`)
  are relative to this file (`docs/`).
- Keep this file an **index**: the design lives in the plans. When an item ships, remove its
  row from the table and the section, and flip its plan's status to shipped.
