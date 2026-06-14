# Checkpoint validator + reflection-retry plan

Status: **Phase 1 shipped ✅** (pure validator + log-only recording + `/memory validations` readout) · **Phase 2 deferred** → `docs/FUTURE-IMPROVEMENTS.md` (gated on Phase 1 data) · Supersedes `docs/MIMOCODE-PARITY-DEVS.md` §3.1 and §5 items 1–2 · Owner: TBD

This plan closes the **single highest-value parity gap** with MiMoCode: today checkpoint
quality is *prompt-guided* (the writer is asked nicely to follow the spec) but never
*enforced* (nothing checks the output, nothing can make it try again). MiMoCode runs an
`actor.preStop` validator that can force the writer to redo an out-of-spec checkpoint
(`docs/research/mimo-memory-system.md:195`). We add the equivalent here.

The work is split into **two phases**, shipped in order:

| # | Phase | Touches | Risk | Default behavior |
|---|-------|---------|------|------------------|
| 1 ✅ | Log-only validator | new `src/checkpoint-validator.ts` (pure) + `checkpoint.ts` + `db.ts` migration | low — never alters the writer or the files | validate after every write, **log + record** violations, change nothing |
| 2 ⏳ | Reflection-retry + revert (**deferred** → `docs/FUTURE-IMPROVEMENTS.md`) | `WriterRequest` contract + `index.ts` `runWriter` + `checkpoint.ts` `run()` | medium — re-prompts the writer, can roll back files | on persistent failure, **revert to the prior checkpoint** |

> **For humans — why two phases?**
> Phase 1 is a *smoke detector*: it watches every checkpoint and writes down what's wrong,
> but never acts. We run it for a while to learn how often each kind of problem actually
> happens and how big the overruns are. Phase 2 is the *sprinkler*: once we trust the
> detector, we let it make the writer fix its work, and — if it still can't — roll the file
> back to the last good version. Building the detector first means we tune the sprinkler from
> real data instead of guesswork, and Phase 1 can't break anything because it only watches.

---

## 0. Pinned decisions (read this first)

These four were decided with the owner before any code. They are the spine of the design;
a change to any of them changes the plan.

| Decision | Choice | Consequence |
|----------|--------|-------------|
| **Severity model** | **Severity ladder** (`warn` / `error` / `extract-required`) | Each violation class maps to a different response. Cosmetic → log only. Structural → force redo. Over-budget → force spillover extraction (not a blind redo). |
| **Retry cap** | **Up to 2 reflections** | Worst case 3 model passes per checkpoint (1 write + 2 fixes). Bounded so it cannot spiral. Retries reuse the same session's prefix cache (cheap). |
| **Give-up policy** | **Revert to prior checkpoint** | If still out-of-spec after 2 retries, restore the pre-write snapshot. We never persist an out-of-spec checkpoint. |
| **Rollout** | **Log-only first, then enable** | Phase 1 ships the validator in observe-only mode; Phase 2 wires retry + revert once the logs confirm it won't thrash. |

> **For humans — what "severity ladder" means.**
> Not every problem deserves the same reaction. A header someone accidentally renamed is
> *broken* and the writer must redo it. A section that ran 200 words too long isn't broken —
> it just needs its overflow moved into a side file ("spillover"). And a stylistic nit (an
> "Open notes" section that probably should be empty) isn't worth a redo at all — we just
> note it. The "ladder" is those three rungs: **warn** (log it), **error** (redo it),
> **extract-required** (move the overflow out). This avoids the trap where a trivial issue
> burns tokens forcing a full rewrite.

### 0.1 Implied sub-decision: revert without losing the cycle's content

"Revert" naively means *throw away everything the writer produced this cycle*. We can do
better. The checkpoint cycle is driven by a sequence pointer, `last_checkpoint_seq:<sid>`
(`checkpoint.ts:299,358`), which records how far into the conversation the last *successful*
checkpoint consumed. The delta for the next run is `messages.slice(lastSeq)`.

**Recommended resolution:** on revert, restore the file snapshot **and do _not_ advance
`last_checkpoint_seq`.** The next checkpoint fire then re-slices the same delta range *plus*
whatever has accumulated since — a strict superset — and tries again with more context. The
content is **deferred to a retry, not discarded.**

**Required guard against livelock:** if the writer is genuinely incapable of producing a
valid checkpoint (e.g. a persistent parser-confusing input), "revert + don't advance" would
loop forever and the session would *never* checkpoint. So track `consecutiveReverts` per
session; after **2 consecutive reverts**, escalate to *accept-best-effort* for that one
cycle: keep the imperfect write, advance the seq pointer, and emit a loud `warning`-level
log + toast. This caps the worst case at "we tolerate one slightly-imperfect checkpoint
rather than stop checkpointing entirely."

> **For humans — the "deferred, not destroyed" trick and its danger.**
> Imagine the writer's job is to summarize pages 1–50 of a book into your notebook. It does a
> bad job, so we tear the page out (revert). Instead of telling it "okay, start fresh from
> page 51" (which loses pages 1–50 forever), we say nothing — so next time it's asked to
> summarize pages 1–80, covering the same ground again with more to work with. Nothing is
> lost. **But** if it's *constitutionally* bad at summarizing pages 1–50, it'll fail forever
> and your notebook stays blank. The guard says: after two failed tear-outs, just accept the
> mediocre summary and move on, so the notebook never goes permanently blank.

---

## 1. Shared invariants (apply to both phases)

Non-negotiable; a phase that violates one is wrong even if its tests pass.

1. **The validator never crashes a checkpoint.** Validation and instrumentation are
   best-effort, exactly like `recordMetrics` (`checkpoint.ts:391-423`, "Instrumentation must
   never disrupt the writer flow"). Any throw inside the validator is caught and logged; the
   checkpoint proceeds as if no validator existed.
2. **A mediocre checkpoint beats none.** The give-up guard (§0.1) exists so quality
   enforcement can never permanently disable checkpointing. Validation failures are *not*
   `consecutiveFailures` (`checkpoint.ts:234`) — that counter is for writer *crashes* (no
   file written at all), a strictly worse condition.
3. **The template is the structural oracle.** Canonical section headers and `_instruction_`
   lines come from parsing `CHECKPOINT_TEMPLATE` (`templates.ts:10-55`), never from a
   hand-maintained copy. When the template changes, the validator follows automatically.
4. **Token counts use the existing approximation.** Budgets are compared with the same
   `ceil(chars / 4)` estimate already used in `recordMetrics` (`checkpoint.ts:393`) and
   `renderSectionBudgets` (`templates.ts:109`, "~4 chars/token"). Because that estimate is
   imprecise, budget violations carry a **tolerance** (§3.3) so a borderline section does not
   thrash.
5. **Phase 1 changes no files and re-prompts nothing.** It is observe-only. The only side
   effects are log lines and `checkpoint_validations` rows.

---

## 2. Where this plugs in (the seams)

Two seams matter, and the code is already shaped for both.

**Seam A — post-write validation (`checkpoint.ts` `run()`, lines 343-383).**
After `await this.deps.runWriter(...)` returns `ok` (line 355-357), `run()` already has the
job in hand — `job.sid`, `job.pid`, `job.taskTree`, plus `this.deps.root` to resolve paths,
and `buildSubagentProgress` for the §4 source-of-truth. This is exactly the data the
validator needs. Phase 1 adds a validate-and-log call right here. **No `index.ts` change.**

**Seam B — the re-prompt loop (`index.ts` `runWriter`, lines 145-217).**
`runWriter` builds an in-process pi SDK session, calls `session.prompt(prompt)` **once**
(line 176), then `session.dispose()` in `finally` (line 212). The session object is alive
between those two lines. Re-prompting *that same session* is what makes reflection-retry
both possible and cheap: the second `prompt()` reuses the first turn's prefix cache (the
`cache_read` column in `writer_metrics`, `db.ts:134`, becomes the proof it's working).
Phase 2 turns the single `prompt()` into a bounded loop here.

> **For humans — why re-prompting the *same* session is cheap.**
> A fresh model session has to re-read the entire instruction prompt + conversation delta
> from scratch — that's the expensive part. If we keep the *same* session alive and just add
> "you missed a quote in §1, fix it," the model already has all that context loaded (cached),
> so the fix costs a fraction of the first pass. The architecture currently throws the
> session away after one use; Phase 2 keeps it for a moment longer to collect the fix.

---

## 3. The validator: `src/checkpoint-validator.ts` (pure module, both phases use it)

A single pure function, fully unit-testable with no SDK and no disk:

```ts
export type Severity = "warn" | "error" | "extract-required";

export interface Violation {
  severity: Severity;
  section: string | null;     // "§6 Files and code sections", or null for whole-file
  code: string;               // stable machine code, e.g. "section-budget-exceeded"
  message: string;            // human-readable; doubles as reflection-message material
  detail?: Record<string, unknown>; // e.g. { tokens: 1900, budget: 1500, topicHint: "files" }
}

export interface ValidatorInput {
  checkpointText: string;     // on-disk checkpoint.md, read back after the writer ran
  memoryText: string;         // on-disk MEMORY.md
  taskGraphBlock: string;     // the TASK GRAPH source (job.taskTree)
  subagentBlock: string;      // the SUBAGENT PROGRESS source (buildSubagentProgress)
}

export function validateCheckpoint(input: ValidatorInput): Violation[];
```

**Shipped API note (Phase 1).** The module also exports `summarizeViolations(violations) →
ViolationCounts` (`{ nError, nExtract, nWarn, codes, maxOverrunPct }`) — the roll-up
`checkpoint.ts` records per run — plus the `BUDGET_TOLERANCE` constant. The `spillovers` input
field in the original sketch was dropped: no Phase 1 check consumes spillover sizes (that would
be a Phase 2 "nested-spillover / spillover-over-budget" check). `buildReflectionMessage(violations)
→ string` is **deferred to Phase 2** — reflection text is only needed once the retry loop exists,
and it belongs with that change so the two land together.

### 3.1 Parsing

Split `checkpointText` on `^## §(\d+) (.+)$`. For each section capture: the header line, the
`_..._` italic instruction line immediately below it, and the body (everything after the
instruction up to the next header). Parse `CHECKPOINT_TEMPLATE` (`templates.ts:10`) the same
way to obtain the canonical header titles and instruction lines (invariant 3). MEMORY.md is
parsed on `^## (.+)$` against `MEMORY_TEMPLATE` (`templates.ts:57`).

### 3.2 Checks, mapped to the severity ladder

**`error` — structural breakage; in Phase 2 forces a redo of the offending section(s):**

| Code | Condition | Source of the rule |
|------|-----------|--------------------|
| `missing-section` | A required `## §N <title>` is absent | prompt `:58-70`; SPEC "11 sections, all required" |
| `sections-out-of-order` | §-numbers not strictly ascending 1→11 | `docs/research/mimo-memory-system.md:195` |
| `header-modified` | A `## §N <title>` differs from the template | prompt `:122` "NEVER modify headers" |
| `instruction-modified` | An `_instruction_` line differs from the template | prompt `:123` "NEVER modify instruction lines" |
| `missing-file-heading` | File does not start with `# Session checkpoint` | `templates.ts:10` |
| `intent-no-verbatim` | §1 body has no block-quoted line `> "..."` | prompt `:131-134` (the §1 anchor) |
| `task-id-invented` | A `#<id>` or actor `<id>` in §4 is absent from the TASK GRAPH / SUBAGENT PROGRESS source blocks | prompt `:117` "NEVER invent or rename" |

**`extract-required` — over budget; in Phase 2 forces spillover, not a blind redo:**

| Code | Condition | Reflection asks for |
|------|-----------|---------------------|
| `section-budget-exceeded` | `ceil(bodyChars/4) > budget × (1 + tolerance)` per `CHECKPOINT_SECTION_BUDGETS` (`templates.ts:78`) | extract a coherent topic to `checkpoint-<topic>.md`, leave the index line `- See checkpoint-<topic>.md (N items) - <summary>` (prompt `:159-163`) |

**`warn` — advisory only; logged, never forces a redo even in Phase 2:**

| Code | Condition | Why warn not error |
|------|-----------|--------------------|
| `open-notes-nonempty` | §11 has content | "prefer empty when in doubt" is a *preference*; §11 is legitimately non-empty sometimes (prompt `:69`) |
| `directive-dup-memory` | A §3 line matches a MEMORY.md `## Rules` line | the dedup is a cleanup the dream pass also does (prompt `:110-112`) |
| `discovered-dup-title` | Duplicate titles under MEMORY.md `## Discovered durable knowledge` | matches MiMoCode's "no duplicate Discovered titles", but non-fatal here |
| `memory-budget-exceeded` | A MEMORY.md section over `MEMORY_SECTION_BUDGETS` (`templates.ts:92`) | MEMORY.md is project-durable; pruning it is the dream pass's job, not a per-checkpoint redo |

> **For humans — why the `task-id-invented` check is special.**
> Most "is this checkpoint good?" questions need judgment — and judgment can be wrong, which
> would force needless redos. This one doesn't. The system *hands the writer* the exact list
> of real task IDs (the "TASK GRAPH block"). So "did the writer make up a task that doesn't
> exist?" is a plain set-membership check: is every ID in the checkpoint also in the list we
> gave it? No guessing, no false alarms. It's the cheapest, most reliable check we have, and
> it guards against the worst failure — a checkpoint that confidently records work that never
> happened.

### 3.3 Budget tolerance

Because `chars/4` is approximate, `section-budget-exceeded` fires only above
`budget × (1 + TOLERANCE)`. Start with `TOLERANCE = 0.15` (15%). Phase 1's logs reveal the
real distribution of overruns; tune before Phase 2 enables enforcement.

### 3.4 §1 edge case (note for the implementer)

`intent-no-verbatim` is `error`, but consider one carve-out surfaced by Phase 1 data: a
session's *first* checkpoint where every user prompt so far was INSPECTION-style (prompt
`:142-145`) may legitimately have no commitment to quote. If Phase 1 logs show this firing on
benign first-checkpoints, downgrade that specific case to `warn`. Do not pre-build the
carve-out; let the data justify it.

---

## 4. Phase 1 — log-only validator

**Goal:** observe, don't act. Ship the validator, run it after every successful write, record
what it finds. Zero behavior change to the writer or the files.

### 4.1 Scope

- **New file** `src/checkpoint-validator.ts` (§3) + its unit tests.
- **`checkpoint.ts` `run()`** (Seam A): after a successful `runWriter` (line 357, inside the
  `if (result.ok)` branch), read back `checkpointPath` / `projectMemoryPath` / any
  `checkpoint-*.md` spillovers, call `validateCheckpoint`, then:
  - emit one structured log line per run summarizing counts by severity (greppable, mirrors
    the `recordMetrics` log style at `checkpoint.ts:416-422`);
  - record a `checkpoint_validations` row (§4.2).
  - All wrapped in try/catch (invariant 1).
- **`db.ts` migration** `SCHEMA_V4` appended to `MIGRATIONS` (`db.ts:150`).

### 4.2 Schema (`SCHEMA_V4`)

```sql
CREATE TABLE checkpoint_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  n_error INTEGER NOT NULL DEFAULT 0,
  n_extract INTEGER NOT NULL DEFAULT 0,
  n_warn INTEGER NOT NULL DEFAULT 0,
  codes TEXT NOT NULL DEFAULT '',            -- comma-joined violation codes, for histogramming
  max_section_overrun_pct INTEGER NOT NULL DEFAULT 0, -- worst budget overrun this run
  -- Phase 2 fills these; Phase 1 leaves them 0/false:
  reflection_attempts INTEGER NOT NULL DEFAULT 0,
  ended_valid INTEGER NOT NULL DEFAULT 1,
  reverted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX checkpoint_validations_session_idx ON checkpoint_validations (session_id, ts);
CREATE INDEX checkpoint_validations_project_idx ON checkpoint_validations (project_id, ts);
```

(Shipped as `SCHEMA_V4` in `db.ts`; the project index mirrors `writer_metrics` so the
`/memory validations` project-scoped readout doesn't scan the whole table.)

> **For humans — what we're trying to learn in Phase 1.**
> Three numbers decide whether Phase 2 is safe to switch on: (1) *How often does anything
> fire at all?* If checkpoints are nearly always clean, enforcement is cheap insurance. (2)
> *Which rules fire most?* Tells us where the writer prompt is weak. (3) *How big are the
> budget overruns?* Tells us whether the 15% tolerance is right, or whether real overruns are
> so large that retries would constantly trigger. We'd rather find that out from a silent log
> than from a thrashing production loop.

### 4.3 Exit gate to Phase 2

Promote to Phase 2 when the logged data shows, over a representative span of real sessions:
- the per-run `error` rate is low enough that retries are occasional, not the norm;
- budget overruns cluster below a tolerance that won't constantly trip `extract-required`;
- no rule is firing spuriously (e.g. the §1 first-checkpoint case, §3.4).

Quantify these thresholds from the actual histogram before building Phase 2; do not guess
them now.

### 4.4 Acceptance criteria — all met ✅

- ✅ `validateCheckpoint` unit tests cover every `code` in §3.2 plus a clean case that yields
  `[]` (`test/checkpoint-validator.test.ts`, 15 tests).
- ✅ A checkpoint run on a real session writes exactly one `checkpoint_validations` row
  (`test/checkpoint.test.ts`, "records one checkpoint_validations row per successful run").
- ✅ An out-of-spec write is flagged but **never blocks** the checkpoint — the write still
  succeeds and `last_checkpoint_seq` advances (`test/checkpoint.test.ts`, "validation row flags
  an out-of-spec write but never blocks the checkpoint"). The validate path is wrapped in
  try/catch in `checkpoint.ts validateAndLog` (invariant 1), so a validator throw is swallowed
  to the log.
- ✅ `/memory validations` readout (`commands.ts validationText`) prints the clean rate, the
  per-severity averages, the worst budget overrun, and the code histogram — no SQL needed.

> **Tests live in `test/`, not `src/`.** The original plan sketch said
> `src/checkpoint-validator.test.ts`; the repo convention (per `package.json` `"test":
> "node --test 'test/*.test.ts'"`) is `test/checkpoint-validator.test.ts`. Validation extends
> the existing `test/db.test.ts` (schema bumped to v4) and `test/checkpoint.test.ts` (the two
> Seam-A integration tests). Full suite: **119 pass, typecheck clean.**

---

## 5. Phase 2 — reflection-retry + revert

**Goal:** act on what the validator finds — make the writer fix `error` / `extract-required`
violations, and revert if it can't.

### 5.1 Contract change: add a `reflect` hook to `WriterRequest`

The validator is pure and lives in `checkpoint.ts`'s world (it knows the paths, the task
source blocks). The session lives in `index.ts`. We bridge them with a callback so neither
module learns the other's internals:

```ts
// checkpoint.ts
export interface WriterRequest {
  prompt: string;
  cwd: string;
  /**
   * Phase 2: after each writer pass, the runner calls this to decide whether to
   * re-prompt. The callback validates the on-disk files and returns a reflection
   * prompt to continue, or null when the checkpoint is valid (or no validator is
   * wired). The runner enforces the retry cap; the callback owns "is it valid +
   * what should the writer fix". Pure w.r.t. the session: it only reads files.
   */
  reflect?: () => string | null;
}

export interface WriterResult {
  ok: boolean;
  error?: string;
  metrics?: WriterTokenUsage;
  endedValid?: boolean;        // Phase 2: false ⇒ still out-of-spec after the cap
  reflectionAttempts?: number; // Phase 2: how many fixes were requested
}
```

### 5.2 `runWriter` becomes a bounded loop (`index.ts`, Seam B)

```ts
const MAX_REFLECTIONS = 2;     // pinned decision: up to 2

await session.prompt(prompt);                     // attempt 0 (existing line 176)
let attempts = 0;
let reflection = req.reflect?.() ?? null;         // validate the on-disk result
while (reflection !== null && attempts < MAX_REFLECTIONS) {
  await session.prompt(reflection);               // re-prompt SAME session (cache reused)
  attempts += 1;
  reflection = req.reflect?.() ?? null;           // re-validate after the fix
}
// reflection === null ⇒ valid; non-null ⇒ exhausted the cap, still invalid
return { ok: true, endedValid: reflection === null, reflectionAttempts: attempts, metrics };
```

`session.dispose()` stays in `finally` (line 212), now after the loop. Token metrics from
`getSessionStats()` (line 184) naturally include the reflection turns — no change needed
there; the `cache_read` column will show the reuse.

### 5.3 Snapshot + revert (`checkpoint.ts` `run()`, Seam A)

`run()` owns the file lifecycle, so the snapshot/revert lives here, wrapping the writer call:

```ts
// before runWriter: snapshot the files the writer may touch
const snapshot = snapshotFiles([
  checkpointPath(job.sid, root),
  projectMemoryPath(job.pid, root),
  notesPath(job.sid, root),
  ...glob(`${sessionDir(job.sid, root)}/checkpoint-*.md`),
]); // read bytes into memory; cheap relative to a model pass

const result = await this.deps.runWriter({ prompt, cwd, reflect });

if (result.ok && result.endedValid === false) {
  const reverts = (this.consecutiveReverts.get(job.sid) ?? 0) + 1;
  if (reverts <= MAX_CONSECUTIVE_REVERTS /* = 2 */) {
    restoreFiles(snapshot);                  // revert (pinned decision)
    this.consecutiveReverts.set(job.sid, reverts);
    // DO NOT advance last_checkpoint_seq → next fire retries the superset delta (§0.1)
    this.deps.log(`checkpoint: reverted (sid=${job.sid}, attempt ${reverts}) — still out-of-spec`);
    this.deps.notify?.("⚠️ mimo-cme: checkpoint deferred — will retry next cycle", "warning");
  } else {
    // livelock guard: accept best-effort this once
    this.consecutiveReverts.set(job.sid, 0);
    metaSet(db, `last_checkpoint_seq:${job.sid}`, String(job.messageCount)); // advance
    this.deps.log(`checkpoint: accepted with residual violations (sid=${job.sid}) after ${reverts} reverts`);
    this.deps.notify?.("⚠️ mimo-cme: checkpoint saved with minor issues", "warning");
  }
} else if (result.ok) {
  this.consecutiveReverts.set(job.sid, 0);     // clean run resets the guard
  metaSet(db, `last_checkpoint_seq:${job.sid}`, String(job.messageCount)); // existing line 358
  // ...existing success path...
}
```

`reflect` is the closure `run()` passes in, validating the on-disk files against `job`'s
source-of-truth:

```ts
const reflect = () => {
  try {
    const v = validateCheckpoint(readBackInput(job, root));
    const actionable = v.filter(x => x.severity === "error" || x.severity === "extract-required");
    return actionable.length ? buildReflectionMessage(actionable) : null; // warns never block
  } catch (e) {
    this.deps.log(`checkpoint: reflect validation error (ignored): ${String(e)}`);
    return null; // invariant 1: never let validation crash the writer
  }
};
```

### 5.4 What the reflection message says

`buildReflectionMessage` (in the validator module) emits a terse, imperative continuation
that names each actionable violation and the exact remedy, e.g.:

```
Your checkpoint is not yet in spec. Fix only these, then stop:
- §1 Active intent: no block-quoted user request found. Add the earliest user request from the delta as `> "<exact words>"`.
- §6 Files and code sections: ~1,900 tokens, budget 1,500. Extract a coherent topic to checkpoint-files.md and replace the moved lines with `- See checkpoint-files.md (N items) - <summary>`.
Do not modify section headers or instruction lines. Do not touch sections not listed.
```

This reuses the writer's own vocabulary (the spillover index-line format from prompt
`:159-163`, the §1 anchor format from `:131-134`), so the writer is being held to rules it
was already given — not new ones.

### 5.5 Acceptance criteria

- A mock `runWriter` that produces a deliberately broken checkpoint then a fixed one proves
  the loop re-prompts and stops at `endedValid` (unit-level, no SDK).
- An integration test (real in-process session) shows `reflection_attempts > 0` and
  `cache_read > 0` on a forced retry — proving the prefix cache is actually reused.
- A writer that *never* converges triggers exactly `MAX_REFLECTIONS` re-prompts, then a
  revert; a second consecutive failure reverts again; the third **accepts best-effort and
  advances the seq pointer** (livelock guard, §0.1).
- After a revert, `last_checkpoint_seq` is unchanged and the next fire's delta is a superset.
- `consecutiveFailures` (writer-crash counter) is untouched by any validation outcome
  (invariant 2).

---

## 6. Out of scope (and why)

- **Semantic / "Tier 2" validation** — verifying EXACT-FORM literals were copied verbatim
  (prompt `:102-105`), that content was routed to the *right* section, or that §1
  KEEP-vs-UPDATE (prompt `:136-147`) was decided correctly. These need model judgment, which
  can be wrong, which causes false-positive redos — the exact failure mode the ladder is
  designed to avoid. Revisit only if Phase 1 data shows these errors are common *and* a
  cheap structural proxy exists.
- **Validating the `dream` prune output** — the weekly cleanup pass has its own quality
  pressure; this plan is scoped to the per-checkpoint writer.
- **Configurable severity per deployment** — the ladder is fixed in code for v1. If sites
  later want to dial strictness, lift the code→severity map into config then.

---

## 7. File-change summary

| File | Phase | Change |
|------|-------|--------|
| `src/checkpoint-validator.ts` | 1 ✅ | **new** — pure `validateCheckpoint` + `summarizeViolations` (`buildReflectionMessage` deferred to Phase 2) |
| `test/checkpoint-validator.test.ts` | 1 ✅ | **new** — one case per violation code + clean case (15 tests) |
| `src/db.ts` | 1 ✅ | `SCHEMA_V4` + `checkpoint_validations` table + `recordValidation` + `validationSummary` |
| `test/db.test.ts` | 1 ✅ | schema-version bump 3→4; `recordValidation`/`validationSummary` coverage |
| `src/checkpoint.ts` | 1 ✅ | `run()` post-write `validateAndLog` (Seam A) + `readFileOr` helper |
| `test/checkpoint.test.ts` | 1 ✅ | two Seam-A integration tests (row recorded; out-of-spec never blocks) |
| `src/commands.ts` | 1 ✅ | `validationText` + `/memory validations` subcommand |
| `src/checkpoint.ts` | 2 ⏳ | `WriterRequest.reflect`, `WriterResult.endedValid`, snapshot/revert + livelock guard in `run()` |
| `src/index.ts` | 2 ⏳ | `runWriter` bounded reflection loop (Seam B) |

---

## 8. Cross-references

- Roadmap entry this implements: `docs/MIMOCODE-PARITY-DEVS.md:182-197` (§3.1, "the biggest
  quality gap") and `:290-305` (§5 items 1–2).
- User-facing framing: `docs/MIMOCODE-PARITY-MARKETING.md:103-105`.
- Upstream behavior being matched: `docs/research/mimo-memory-system.md:195` (the
  `actor.preStop` validator + reflection severities) and `:355,420,428-431,461-464`.
- Divergence note retired by this plan: `README.md:160-162` ("No preStop validators in v1").
- Writer prompt (the rules being enforced): `src/prompts/checkpoint-writer.ts:40-194`.
- Budgets + template (the structural oracle): `src/templates.ts:10-55,78-98`.
- Seams: `src/checkpoint.ts:343-383` (`run`), `src/index.ts:145-217` (`runWriter`).
