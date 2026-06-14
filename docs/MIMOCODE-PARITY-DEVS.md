# pi-mimo-cme vs. MiMoCode — Parity, Divergences & Gaps (Technical)

A side-by-side of **MiMoCode's memory system** (the upstream design this extension re-implements)
and **pi-mimo-cme** (this repo's implementation on the [pi](https://pi.dev) coding agent). It
exists to answer one question precisely: *where does this extension reach feature parity, where
does it deliberately diverge, and where are the genuine gaps?* — and to record **why** for each.

> **Audience:** developers extending this extension or evaluating it against the original. For a
> non-technical overview, see [MIMOCODE-PARITY-MARKETING.md](./MIMOCODE-PARITY-MARKETING.md).
>
> **Sources of truth.** MiMoCode's behavior is taken from `docs/research/mimo-memory-system.md`
> and `docs/research/opencode-mimocode-fork-delta.md` (these describe **upstream**, not this repo).
> This extension's behavior is taken from `src/*` (code wins over prose) and `docs/design/SPEC.md`.
> The repo already maintains a shorter divergence list in [`../README.md`](../README.md) and
> [ONBOARDING-DEVS.md §11](./ONBOARDING-DEVS.md); this doc is the long-form, evidence-cited version.

---

## TL;DR verdict

**pi-mimo-cme is a high-fidelity re-implementation of MiMoCode's memory system — not an
approximation of the idea, but a port of the actual schemas, thresholds, prompts, and FTS5
mechanics.** The two systems share the same four-layer hierarchy, the same checkpoint section
schema, the same window-scaled checkpoint cadence, the same BM25 recall semantics, and the same
"Markdown is truth, SQLite is a derived index" invariant — down to preserving MiMoCode's
external-content FTS5 `'delete'`-trigger war story verbatim.

Where it diverges, it is almost always because **the host platform differs** (pi's extension API
vs. opencode's fork-with-plugin-hooks model), not because a corner was cut for convenience. There
are **two true capability gaps** worth a roadmap (writer-output validators; active window
microcompaction), one gap forced by a community dependency (task-event archival), and a handful of
**additions** this port makes that the upstream notes don't mention (writer-cost instrumentation,
honest-by-construction pass reporting, reconcile debouncing).

| Bucket | Count | One-line characterization |
|---|---|---|
| **Parity** | ~20 mechanisms | Same design, same numbers — the core memory system is faithfully reproduced |
| **Divergences** | 9 | Same intent, different mechanism — forced by pi-vs-opencode host differences |
| **Gaps** | 3 (+2 minor) | MiMoCode capabilities not (yet) reproduced; reasons + roadmap below |
| **Additions** | 6 | Engineering this port adds on top of the upstream design |

---

## 1. Parity — same design, same numbers

These are reproduced faithfully. Where a number appears, both systems use it.

| # | Mechanism | MiMoCode | pi-mimo-cme | Evidence |
|---|---|---|---|---|
| 1 | **Computation / Memory / Evolution** framing & the hierarchy principle | ✅ | ✅ | README, `inject.ts` |
| 2 | **Four layers** (session → project → global → history) | ✅ | ✅ | both |
| 3 | **Session checkpoint = 11 sections** with identical §-budgets (~11.5K tok) | ✅ | ✅ | `templates.ts`, `prompts/checkpoint-writer.ts` |
| 4 | **Project `MEMORY.md` = 4 sections** (Context / Rules / Architecture decisions / Discovered) | ✅ | ✅ | `templates.ts` |
| 5 | **Global `MEMORY.md`**, dream-promoted, agent-read-only | ✅ | ✅ | `inject.ts`, `prompts/dream.ts` |
| 6 | **History layer** = SQLite FTS5, machine-wide, never deleted | ✅ | ✅ | `db.ts`, `history.ts` |
| 7 | **`memory` tool**: BM25, **OR-joined** tokens, **relative score floor `0.15`** (top hit always kept) | ✅ | ✅ | `fts.ts` `memorySearch` |
| 8 | **`history` tool**: `search` + `around` (±N msgs), output capped (~20 KB) | ✅ | ✅ | `fts.ts`, `tools.ts` |
| 9 | **Window-scaled checkpoint thresholds**: ≤200K → 20/40/60/80%; →500K → every 10%; >500K → every 5% | ✅ | ✅ | `checkpoint.ts` `defaultThresholdsFor` |
| 10 | **Markdown = source of truth; DB = derived index.** Deleting the DB loses no curated memory | ✅ | ✅ | `reconcile.ts` |
| 11 | **Size-mtime fingerprint reconcile**, lazy before each search | ✅ | ✅ | `reconcile.ts` |
| 12 | **External-content FTS5 `'delete'`-magic triggers** (the war story) | ✅ | ✅ | `db.ts` (comment preserved) |
| 13 | **`unicode61 remove_diacritics 1`** tokenizer; integer `AUTOINCREMENT` PK as `content_rowid` | ✅ | ✅ | `db.ts` |
| 14 | **`notes.md` scratchpad** — main-agent append-only, wiped to template at checkpoint | ✅ | ✅ | `inject.ts`, writer prompt |
| 15 | **Write-separation path guard** — main agent may write only `notes.md` + project `MEMORY.md` | ✅ | ✅ | `guard.ts` |
| 16 | **70% / 85% memory-flush nudges**, once per level per session | ✅ | ✅ | `checkpoint.ts` `nudgeFor` |
| 17 | **Dream pass** — consolidate / dedupe / prune / promote, **auto every 7 days**, <200 line / 10 KB target | ✅ | ✅ | `prompts/dream.ts` |
| 18 | **Distill pass** — package repeated workflows (≥2× recurrence) into skills/commands, **auto every 30 days, on by default** | ✅ | ✅ | `prompts/distill.ts` |
| 19 | **Promotion ladder** notes → checkpoint §§ → project `MEMORY.md` → global; workflows → skills | ✅ | ✅ | writer + dream + distill prompts |
| 20 | **LLM-judged forgetting** (no algorithmic decay); conflicts resolved newest-evidence-wins | ✅ | ✅ | dream prompt |
| 21 | **`cc` scope** — optionally index `~/.claude/projects/*/memory`, **off by default** | ✅ | ✅ | `reconcile.ts`, `config.ts` |

**Reading of the matrix:** the entire *read path* (injection + BM25 recall + history firehose),
the entire *curation model* (background writer owns checkpoints, main agent owns notes, guard
enforces it), and the entire *evolution path* (dream/distill cadence and behavior) are at parity.
The numbers that most prove fidelity: the **20/40/60/80%** window-scaled threshold schedule, the
**0.15** relative score floor, the **11-section** checkpoint schema with per-section token budgets,
and the **`'delete'`-magic FTS5 trigger** — all reproduced exactly.

---

## 2. Divergences — same intent, different mechanism

Each of these achieves the *same goal* by a *different route*, because pi is not opencode. None is
a reduction in capability; they're translations across host platforms.

### 2.1 Checkpoint writer: in-process pi SDK session ⟂ native hidden subagent

| | MiMoCode | pi-mimo-cme |
|---|---|---|
| Writer is | a **native, hidden, `mode:subagent`** agent spawned via opencode's agent system | an **in-process `createAgentSession(...)`** pi SDK session (`runWriter`) |
| Recursion guard | opencode's native-agent isolation | `DefaultResourceLoader({ noExtensions: true })` — the writer loads zero extensions, so pi-mimo-cme never binds to it |
| No-transcript guard | n/a | `SessionManager.inMemory()` — no JSONL, so the writer's own output isn't backfilled as "user history" |

**Why:** pi has no opencode-style native-agent registry; the idiomatic pi equivalent is a fresh SDK
session. `noExtensions` + `inMemory` reproduce the isolation opencode gets for free. Evidence:
`checkpoint.ts` `runWriter`, `index.ts`.

### 2.2 Writer input: inlined delta ⟂ delta file + `fork=true`

| | MiMoCode | pi-mimo-cme |
|---|---|---|
| Writer receives | a `delta-<n>.md` **temp file** (Read by the writer) and optionally `fork=true` (parent **prefix-cache reuse**) | the serialized delta **inlined into the prompt** between `BEGIN/END CONVERSATION DELTA` markers; no temp file |
| Delta cap | token-budgeted boundary | `DELTA_CAP` ~100 KB, **head-dropped** (newest content kept), tool I/O clipped to 500 chars |

**Why:** prefix-cache reuse across the parent and the writer is **not achievable here** — the writer
is a *separate conversation* with its own system prompt and tool schema, so there is no shared
prefix to reuse. (MiMoCode itself ships `fork=false` by default for the same reason.) Inlining also
removed the temp-file round-trip and, as a side effect, fixed parent-state access: the writer pulls
`model`/`modelRegistry` live from the parent `ctx` at run time. This decision was made
**data-first** — see the `writer_metrics` instrumentation in §4.1. Evidence: `checkpoint.ts`
`serializeDelta`, `prompts/checkpoint-writer.ts`, ONBOARDING-DEVS §11.5.

### 2.3 Subagent progress journal: synthesized from events ⟂ written inside the subagent via postStop hook

| | MiMoCode | pi-mimo-cme |
|---|---|---|
| `tasks/<id>/progress.md` is | written by the **task-bound subagent itself**, *forced* by a `postStop` hook before it may terminate (5 exact sections) | **synthesized externally** by `actors.ts` from the subagent's terminal-event payload |

**Why:** pi-mimo-cme cannot run a lifecycle hook *inside another extension's* subagent
(`@tintinweb/pi-subagents` owns the subagent). So it observes the completion event over `pi.events`
and writes the journal itself. Same durable artifact, same `memory_fts` indexing (`type='progress'`)
— but derived from the terminal event rather than the subagent's own first-person reflection (see
gap §3.4). Evidence: `actors.ts`.

### 2.4 Task tree §4 source: `rpiv-todo` branch snapshot ⟂ opencode native task registry

| | MiMoCode | pi-mimo-cme |
|---|---|---|
| §4 "Task tree" reconciled from | opencode's **native `task` tool registry** (authoritative source of truth) | the **`@juicesharp/rpiv-todo`** community extension's snapshot, scanned last-write-wins from the session branch (`tasks.ts`, a pure module, no DB) |

**Why:** pi has no native task subsystem. rpiv-todo is the community option and emits no events / writes
no disk, so `tasks.ts` reads the `todo` tool-result `details` payload exactly as rpiv-todo's own
`replay.ts` does. Both halves are **soft/optional** deps — absent ⇒ §4 renders
`"(no tasks or subagents this session)"`, gated by `config.tasks.enabled`. Evidence: `tasks.ts`,
ONBOARDING-DEVS §11.6.

### 2.5 Subagent integration: soft event-observation ⟂ native actor/spawn/registry

MiMoCode's `actor/{spawn,registry}.ts` is *part of opencode's agent model*. pi-mimo-cme **observes
only** — it subscribes to `subagents:created|started|completed|failed|compacted` on the
cross-extension `pi.events` bus, never imports or spawns. **Scoped to background subagents:**
pi-subagents emits `created` + terminal events only for background agents (foreground agents emit
`started` and return inline → already in the delta), so `created` is the sole row-introducer and
other phases gate on an existing row. Evidence: `actors.ts`, `index.ts` bus wiring.

### 2.6 History keys: `(session_id, seq)` ⟂ message/part IDs

MiMoCode keys `history_fts` by opencode `part_id` (preserving part granularity). pi exposes
*messages*, not parts, so pi-mimo-cme keys by `(session_id, seq)` with a synthetic
`message_id = "<sid>#<seq>"` that the `around` operation parses back. Evidence: `history.ts`, `db.ts`.

### 2.7 Auto-pass scheduling: `meta` table ⟂ session-title query

MiMoCode recovers "last dream/distill ran at" by querying the `session` table for the last
`"Auto Dream"`/`"Auto Distill"`-titled session. pi-mimo-cme stores `last_dream_at:<pid>` /
`last_distill_at:<pid>` in the `meta` table — portable, no session dependency — and the **first
sighting of a project starts the clock** rather than firing immediately, so a fresh install never
surprise-runs a pass. Evidence: `index.ts` `maybeAutoPass`, ONBOARDING-DEVS §11.8.

### 2.8 Upper layers injected every turn ⟂ injected only at rebuild

MiMoCode assembles project + global memory into the **rebuild dump** at a checkpoint boundary.
pi-mimo-cme carries project + global `MEMORY.md` in the **system prompt every turn** (budgeted,
stable text so the prompt cache stays warm). **Why:** pi sessions may *never* compact, so deferring
the small upper layers to a rebuild that might not happen would starve continuity. This is
pi-mimo-cme being *more* aggressive about availability, traded against a slightly larger steady-state
prompt. Evidence: `inject.ts` `buildSystemPromptAppendix`, ONBOARDING-DEVS §11.1.

### 2.9 Dream/distill execution: pi subprocess ⟂ native hidden subagent

Both run the same prompts, but MiMoCode runs them as native hidden subagents while pi-mimo-cme
spawns `pi --no-extensions --no-session -p <prompt>` (env `PI_MIMO_CME_CHILD=1`, `wal_checkpoint(TRUNCATE)`
first so the child's read-only `sqlite3` sees committed writes). `--no-session` + the env guard
prevent transcript-pollution and extension recursion. Evidence: `index.ts`, `prompts/{dream,distill}.ts`.

---

## 3. Gaps — MiMoCode capabilities not (yet) reproduced

These are real differences in *what the system can do*, with the reason and an improvement note.

### 3.1 ⚠️ No writer-output validators / reflection-retry (the biggest quality gap)

**MiMoCode:** an `actor.preStop` plugin validates each checkpoint write — topic format, all required
sections present & ordered, no duplicate "Discovered" titles, **per-section token budgets** — and on
violation *forces the writer to continue with a reflection message* (severity ladder: warn → error →
extract-required, the last forcing spillover extraction) rather than letting it stop.

**pi-mimo-cme:** **no preStop validation.** The writer prompt's budget text and dream's prune phase
carry that pressure by instruction only. A malformed or over-budget checkpoint is not caught and
re-driven; it's written as-is and tidied later (or not).

**Why:** pi v1 simplification — the in-process writer path doesn't yet wire a post-generation
validate-and-retry loop. **Improvement:** add a validation pass over the writer's output (sections
present/ordered, budgets respected) and, on failure, re-prompt the same in-process session with a
reflection message before `dispose()`. This is the single highest-value parity item. Evidence:
absence in `checkpoint.ts`; ONBOARDING-DEVS §11.4.

### 3.2 ⚠️ No active window microcompaction / synthetic rebuild boundary

**MiMoCode:** at context saturation it *actively rewrites the live window* — inserts a synthetic
`checkpoint` boundary message, rebuilds the window from the four layers in priority order, and
**microcompacts regeneratable tool outputs** (read/bash/grep/glob/edit/write/…) to
`"[Old tool result content cleared]"` while **preserving state-carrying tools** (memory/history/task).
The tail (10–20 K tokens) is kept verbatim.

**pi-mimo-cme:** does **not** rewrite the live window or microcompact. It emits a one-shot
**rebuild dump** (checkpoint + notes + open tasks/actors) *after* resume/fork/compaction and
otherwise relies on **pi's host-owned compaction** to manage the window.

**Why:** active window surgery needs the deep message-model control opencode exposes to plugins; in
pi, compaction is the host's job, and the extension's lever is *injection*, not *window rewriting*.
pi-mimo-cme compensates with §2.8 (always-inject upper layers) + the rebuild dump on resume. This is
a genuine architectural divergence **and** a partial capability gap: token efficiency inside a single
long pre-compaction window is the host's to optimize, not ours. **Improvement** is bounded by what
pi's API exposes — track it against the pi extension API rather than as a pure code task. Evidence:
`inject.ts` `buildRebuildDump`; MiMoCode `insertRebuildBoundary`/`renderRebuildContext`.

### 3.3 No task-event history → no `task_archive_days`

**MiMoCode:** a `task_event` log gives tasks timestamps, enabling date-based archival
(`task_archive_days`, default 7).

**pi-mimo-cme:** `@juicesharp/rpiv-todo` provides **snapshots only — no timestamps, no event log** —
so task archival is *unfillable* regardless of effort. **Why:** community-dependency limitation, not
a design choice. **Improvement:** only possible if rpiv-todo (or a replacement) starts emitting an
event/timestamp stream. Evidence: `tasks.ts`, ONBOARDING-DEVS §11.6.

### 3.4 (minor) Subagent progress journal is derived, not first-person

Covered as divergence §2.3, but worth flagging as a *fidelity* gap: MiMoCode's `progress.md` is the
subagent's own reflection (5 enforced sections, authored before it may stop); ours is synthesized
from the terminal-event payload. Same slots, shallower content (no in-subagent introspection).

### 3.5 (minor) Foreground subagents are invisible to the actor ledger

pi-subagents emits terminal events only for *background* subagents. Foreground subagent work is
captured solely via the conversation delta (so the checkpoint writer still sees it), but it never
produces an actor row or a `progress.md`. **Why:** host event model. Acceptable because the delta
already carries foreground results inline.

---

## 4. Additions — what this port adds on top

Engineering present in pi-mimo-cme that the MiMoCode research notes do not describe. (Framed as
"additions this port makes"; MiMoCode may do some of these internally without it being documented.)

### 4.1 Writer-cost instrumentation (`writer_metrics`, "measure first")

A dedicated `writer_metrics` table records, per checkpoint run: writer input/output/cache tokens,
cost, delta size, parent context tokens/window, message count, duration. This turns the §2.2
`fork`-vs-inlined-delta question into a **data-driven** decision instead of a theoretical one — the
whole reason inlining was chosen confidently. No equivalent is documented upstream. Evidence:
`db.ts` SCHEMA_V3, `checkpoint.ts`.

### 4.2 Honest-by-construction pass reporting

A dream's reported effect is read from the **reconcile index diff** (it edited Markdown); a distill's
effect is the **before/after asset-file snapshot** — *never* from parsing the child's freeform stdout.
The pass physically cannot over-report what it did. Evidence: `commands.ts`/`index.ts`
`reportPassResult`, ONBOARDING-DEVS §6.

### 4.3 Reconcile debounce (4 s, per-DB-handle clock)

`reconcileOnSearch` is debounced via a `WeakMap<DatabaseSync, number>` keyed on the per-session DB
handle (can't mis-share across concurrent sessions; GC'd on close). The first search of a session
always reconciles; only rapid repeats within `reconcileDebounceMs` (4000) collapse — keeping the
synchronous tree-walk off the interactive hot path as session count grows. Evidence: `commands.ts`.

### 4.4 `MAX_INDEXED_BODY_BYTES` cap (256 KB)

Reconcile caps any single indexed body at 256 KB so one runaway memory file can't stall the walk.
Evidence: `reconcile.ts`.

### 4.5 `bigint` `mtimeNs` fingerprints

Fingerprints use nanosecond mtime (`"${size}-${mtimeNs}"`), detecting same-size edits that land
inside the same millisecond — finer than `mtimeMs`. Evidence: `reconcile.ts`.

### 4.6 Hot-path footer counts + package-name root

A live `🧠 N idx · M hist [· K actors]` footer is served from an in-memory cache seeded once per
session (zero SQL on the per-turn path, reseeded after batch mutations). And the memory root is a
**short, distinct top-level segment** `~/.pi/cme/` (a sibling of the agent dir), not a generic `memory/`, so it can't collide with a
future pi-native memory feature. Evidence: `footer-counts.ts`, `paths.ts`.

---

## 5. Parity roadmap (if exact parity is the goal)

Ordered by value-to-effort:

1. **Writer-output validators + reflection-retry** (§3.1) — highest value, self-contained in
   `checkpoint.ts`/`runWriter`. Validate sections-present/ordered + per-section budgets; on failure
   re-prompt the same in-process session once before `dispose()`.
2. **Spillover-extraction enforcement** — MiMoCode's validator can *force* `checkpoint-<topic>.md`
   extraction when a section blows its budget. The file format is already supported here; only the
   forcing mechanism (a consequence of #1) is missing.
3. **Active window microcompaction** (§3.2) — gated on what the pi extension API exposes for live
   message-window manipulation; track against `docs/research/pi-extension-api.md`, not as pure code.
4. **First-person subagent progress** (§3.4) and **task-event archival** (§3.3) — both blocked on
   upstream deps (`pi-subagents` postStop-equivalent; rpiv-todo timestamps), not on this codebase.

Everything else is at parity or a deliberate, documented divergence — no action implied.

---

## 6. Cross-references

| For… | Read |
|---|---|
| The marketing-friendly version of this comparison | [MIMOCODE-PARITY-MARKETING.md](./MIMOCODE-PARITY-MARKETING.md) |
| MiMoCode's schemas + **verbatim prompts** (upstream source) | `docs/research/mimo-memory-system.md` |
| What MiMoCode changed vs. base opencode | `docs/research/opencode-mimocode-fork-delta.md` |
| This extension's architecture & invariants | [ONBOARDING-DEVS.md](./ONBOARDING-DEVS.md), `docs/design/SPEC.md` |
| The short divergence list the repo already maintains | [`../README.md`](../README.md), ONBOARDING-DEVS §11 |
| pi v0.79.x extension API + gotchas (bounds the §3.2 roadmap) | `docs/research/pi-extension-api.md` |
