# Does pi-mimo-cme actually improve an agent's memory?

A head-to-head benchmark of the **same** pi agent **with** the `pi-mimo-cme` memory
extension versus **without** it. This is the empirical companion to
[MIMOCODE-PARITY-MARKETING.md](./MIMOCODE-PARITY-MARKETING.md) (which argues *why* it should
help) and the unit tests under `test/` (which prove the *machinery* is correct). Those are
necessary but not sufficient: a passing `reconcile` test proves a row comes back from a query;
it does **not** prove the agent answers a user's question better. This document measures the
behaviour.

> **TL;DR.** With the extension, a brand-new session recalls facts and *obeys rules*
> established in an earlier session it never saw; without it, the same agent says "I don't
> know" or falls back to default behaviour. The cross-session recall win is, by construction,
> near-guaranteed (a stateless agent has no channel to a prior session) — so the numbers worth
> reading are the **reliability** of the channel, whether it ever surfaces the **wrong**
> memory, and the **token cost** it adds. Those are the columns this benchmark exists to fill.

## How to reproduce

```sh
# pilot (≈1 min, validates wiring):
node scripts/bench-memory.mjs --pilot

# full suite (the numbers in this doc):
node scripts/bench-memory.mjs --trials 5 --parallel 5 --out /tmp/cme-full
```

Requires `pi` on PATH and a configured provider. The harness is `scripts/bench-memory.mjs`;
raw per-call data lands in `<out>/raw.json`, aggregates in `<out>/summary.json`.

## The one variable

Everything is held constant between the two conditions except the extension itself:

| | Baseline (without) | Treatment (with) |
|---|---|---|
| Command | `pi -p --no-extensions` | `pi -p -e src/index.ts` |
| Memory root | n/a | isolated `PI_CODING_AGENT_DIR` per item |
| Model | same (pi's configured default) | same |
| `cwd`, prompts, `--no-context-files` | same | same |

`--no-context-files` disables `AGENTS.md`/`CLAUDE.md` discovery so a stray project file can't
leak the answer — the *only* path by which session B can learn session A's content in the
treatment arm is the extension's memory.

**Cross-session = a fresh process.** Each "session B" uses a brand-new session id and **never
resumes** session A (no `--continue`/`--resume`). The two sessions share only their `cwd` —
and since the project id is `sha256(cwd)`, that's exactly what lets the extension's
project-memory layer bridge them. Plain pi has no equivalent bridge; that's the point.

## What's measured (four tracks)

1. **`incontext` — sanity control.** Fact *and* question in one session, both conditions.
   Proves the model *can* answer when the fact is in context, so any cross-session gap is about
   persistence, not capability. Expect ~100% for **both** arms; if baseline isn't ~100% here
   the questions are broken.
2. **`recall` — cross-session fact recall.** Session A persists a fact (treatment writes it to
   `MEMORY.md`; baseline has nowhere to put it); a fresh session B is asked. Questions use
   arbitrary, unguessable values (`pglake_staging_7`, on-call `Priya Raghunathan`, port `8473`)
   so a model with no prior knowledge cannot bluff. Wrong answers are split into honest
   **"I don't know"** vs. confident-but-wrong (**hallucination**).
3. **`rule` — cross-session rule *adherence* (behavioural).** The non-tautological track.
   Session A saves a project rule ("new modules go under `src/domains/`"); a fresh session B is
   given a task that silently violates the rule unless it's remembered. Scores whether the
   *action* honoured the rule — memory changing behaviour, not just Q&A.
4. **`precision` — does memory surface the *right* fact?** One project loaded with **all** ten
   facts, then each question asked separately. Catches the failure mode where a memory system
   confidently retrieves a *neighbouring* fact. `conf` counts answers that matched a *different*
   fact's expected token.

Each track runs across N independent trials in isolated sandboxes (parallel-safe). Token and
latency columns come from pi's own `--mode json` usage accounting.

## Results

_Model: `deepseek-v4-flash` (provider `opencode-go`, pi's configured default) · 5 trials ·
350 real pi sessions · 625s wall · total cost $0.357. Regenerate the table with
`node scripts/bench-report.mjs /tmp/cme-full`._

| Track | Condition | Accuracy | Correct | "I don't know" | Hallucinated | Wrong-fact | Avg input tok | Avg ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `incontext` (sanity control) | **with** ext | **100%** | 50/50 | 0 | 0 | 0 | 963 | 4609 |
|  | without | **100%** | 50/50 | 0 | 0 | 0 | 188 | 4439 |
| `recall` (cross-session fact) | **with** ext | **100%** | 50/50 | 0 | 0 | 0 | 1098 | 4748 |
|  | without | **0%** | 0/50 | 46 | 4 | 0 | 226 | 12983 |
| `rule` (cross-session behaviour) | **with** ext | **100%** | 15/15 | 0 | 0 | 0 | 1140 | 8656 |
|  | without | **0%** | 0/15 | 0 | 15 | 0 | 134 | 25705 |
| `precision` (right fact, loaded) | **with** ext | **100%** | 50/50 | 0 | 0 | 0 | 1192 | 4517 |

(The four baseline `recall` non-IDK rows were not hallucinated answers — with tools disabled the
model tried to *narrate* a filesystem search it couldn't run; none produced a correct value.)

### Same task, opposite behaviour (the `rule` track)

A fresh session is given a task; the relevant project rule was established in an earlier session it
never saw:

| Task | Without the extension | With the extension |
|---|---|---|
| Create a new module | `…/rate-limiter/rate_limiter.go` (generic path, wrong language) | `src/domains/rate-limiter/index.ts` ✓ |
| Write a commit message | `Fix typo in README` | `[ZN] Fix typo in README` ✓ |
| Delete the `build/` folder | **`rm -rf build/`** ⚠️ | `safe-rm build/` ✓ |

The last row is the point in miniature: without memory the agent confidently proposes a destructive
`rm -rf`; with memory it reaches for the project's `safe-rm` wrapper. The rule was never in its
context this session — only in memory.

## What the numbers do and don't prove

**What they establish:**

1. **The cross-session channel works end-to-end with the real agent.** A brand-new session, with no
   resume, recalls prior-session facts **100%** of the time and obeys prior-session rules **100%** of
   the time; the identical agent without the extension scores **0%** on both.
2. **Recall is at the model's in-context ceiling — the memory layer loses essentially nothing.** The
   `incontext` control is 100% for *both* arms, and treatment `recall` is also 100%. In other words,
   pulling a fact out of a *past* session works as reliably as having it typed into the *current*
   prompt. The extension's job — make earlier knowledge present — is done losslessly here.
3. **Memory didn't degrade precision.** Loaded with all ten facts at once, the agent retrieved the
   *right* one every time (`precision` 100%, `Wrong-fact` 0). The classic "confidently returns a
   neighbouring memory" failure did not occur in this run.
4. **The behavioural win is larger than the trivia win — and includes safety.** On a knowledge
   question the agent can at least say "I don't know" (baseline did, 46/50). On a *task*, it can't
   flag its own ignorance — it just acts, and without the rule in memory it acted wrongly all 15/15
   times, including proposing `rm -rf`. Memory matters most exactly where the agent wouldn't know to
   ask.
5. **The cost is favourable, not just "small".** The extension adds **~775 input tokens/turn** (the
   injected memory instructions + project `MEMORY.md`). But the treatment arm produced **fewer output
   tokens and ran faster** — recall: 110 out / 4.7s vs the baseline's 405 out / 13.0s; rule: 293 out /
   8.7s vs 796 out / 25.7s — because it answered directly instead of flailing toward a worse result.
   On these cross-session tasks the input "tax" is offset by cheaper, faster completions.

**What they do _not_ prove** — see the threats section above for the full list, but the load-bearing
caveats are: the headline gap is partly true *by construction* (a stateless baseline has no channel,
so ~0% is the floor, not a discovery — the non-tautological evidence is points 2–5); it's one small
model on one machine at modest N, so treat magnitudes as directional; and the recall here rides the
**injection** path (small memory fits the prompt), so the BM25 `memory`/`history` search tools — which
carry the load once memory outgrows the budget — are *not* stressed by this benchmark and warrant
their own.

## Honest limits (threats to validity)

- **The headline comparison is partly tautological.** "Agent with cross-session memory beats
  agent with none, on cross-session recall" is true almost by construction — a stateless
  baseline has no information channel to a prior session, so it *must* score near zero. This
  benchmark's value is therefore not the existence of the gap but its **shape**: does the
  channel fire reliably (treatment < 100% would be the interesting failure), does it ever inject
  the *wrong* memory (`precision`/`conf`), and what does it **cost** (token columns)?
- **Single machine, single model, small N.** Results are directional, not publication-grade.
  The model is pi's configured default (recorded in the table), a small/fast model chosen
  deliberately: a weaker model bluffs less, so recall differences are attributable to memory
  rather than the model guessing from convention.
- **Out of scope here (mechanism-tested only).** The `dream` (weekly consolidation) and
  `distill` (monthly workflow-packaging) passes operate on day/week timescales and can't be
  exercised in a benchmark window — they're covered by `test/` and the design docs, not
  measured here. Within-session continuity (checkpoint/resume after context fills) is likewise
  only partially exercised: the cross-session tracks lean on the **injection** + **MEMORY.md**
  path, which is the channel a fresh session actually uses.
- **Treatment recall leans on injection, not search.** In the recall track the agent answers
  from the project memory injected into its system prompt (no `memory`/`history` tool call
  observed). That's the cheapest path and the common case; it does **not** exercise the BM25
  search tools, which matter when memory is large enough that not everything fits in the prompt.
