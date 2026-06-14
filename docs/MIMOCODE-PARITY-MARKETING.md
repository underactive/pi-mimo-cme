# Built on MiMoCode. Tuned for pi. — How pi-mimo-cme compares

**pi-mimo-cme** brings the memory system behind [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code)
— Xiaomi's research agent — to the [pi](https://pi.dev) coding agent. This page is for anyone
evaluating the extension and asking the fair question: *"Is this the real thing, or a watered-down
clone?"*

**Short answer: it's the real thing.** Not "inspired by." Not "memory-ish." pi-mimo-cme reproduces
MiMoCode's actual memory architecture — the same layered design, the same automatic checkpoints, the
same consolidation passes — and then adapts the plumbing to fit pi, with a few engineering upgrades
along the way.

> Want the line-by-line engineering breakdown with file citations? See
> [MIMOCODE-PARITY-DEVS.md](./MIMOCODE-PARITY-DEVS.md). New here? Start with the
> [User Guide](./ONBOARDING-USERS.md). Want *proof* it works rather than claims? See the
> head-to-head [memory benchmark](./MEMORY-BENCHMARK.md) (same agent, with the extension vs. without).

---

## The idea you're buying into

Every coding-agent session starts from zero. You re-explain your project, re-state your rules,
re-hit the same bugs. MiMoCode's insight was to treat agent forgetting as **three different problems
on three different time scales** — and to solve each:

| | The forgetting it fights | What pi-mimo-cme gives you |
|---|---|---|
| 🧮 **Computation** | the model can't recall what it knew, *within a single answer* | the right memory injected into pi's prompt every turn, plus search tools the agent reaches for before asking you to repeat yourself |
| 🧵 **Memory** | context fills up and early turns fall out, *across a long session* | a running scratchpad, **automatic checkpoints** as context fills, and a clean re-load when you resume |
| 🌙 **Evolution** | lessons never compound, *across many sessions* | a weekly **"dream"** pass that consolidates and de-duplicates, and a monthly **"distill"** pass that turns your repeated workflows into reusable skills |

The guiding principle, taken straight from MiMoCode:

> *The upper layers are more refined, more persistent, and smaller; the lower layers are more
> complete, larger, and slower.*

In practice that's **four layers** — your cross-project preferences, your per-project rules and
decisions, the current session, and a full-text-searchable history of every message you've ever
exchanged. The top three are plain Markdown files you can open and edit. The bottom is a search
index that's purely derived — **delete it and you lose nothing**; it rebuilds itself.

---

## Faithful where it counts

These aren't "similar in spirit" — they're the same design, reproduced down to the numbers:

- ✅ **The same four-layer memory hierarchy** — session, project, global, and full history.
- ✅ **The same 11-section session checkpoint** that captures your intent, your next step, the files
  in play, the errors and fixes, and the decisions reached.
- ✅ **The same automatic checkpoint rhythm** — snapshots that get *more frequent on bigger context
  windows*, so nothing important slips out as the conversation grows.
- ✅ **The same recall engine** — fast full-text ranking that surfaces your most relevant memory
  first, with a clear fallback to the raw history "firehose" when needed.
- ✅ **The same curation discipline** — a background writer owns your structured memory so it stays
  tidy; you and the agent only ever hand-touch a scratchpad and your project rules.
- ✅ **The same self-improvement passes** — weekly consolidation and monthly workflow-packaging, both
  on by default, exactly as MiMoCode ships them.
- ✅ **Markdown is the source of truth.** Your memory is human-readable text files you fully own —
  the database is just a fast index on top.

If a behavior matters to how the memory system *works*, pi-mimo-cme matches it.

---

## Adapted for pi — by necessity, not compromise

pi and MiMoCode's host (a fork of opencode) are different platforms, so some of the *plumbing*
differs. In every case the **goal is identical and the result is equivalent** — it's a translation,
not a downgrade:

- 🔌 **It plays nice with your other extensions.** Instead of bolting into a proprietary agent
  registry, pi-mimo-cme *observes* pi's standard event bus. It can track your background sub-agents
  and your task list (via popular community extensions) without taking them over — and it degrades
  gracefully if they're not installed.
- 🧠 **Your project rules ride along every turn.** Because a pi session might never need to compact,
  pi-mimo-cme keeps your small, important upper-layer memory in the prompt *continuously* — so the
  agent always has your rules at hand, not just after a reset.
- ⚙️ **No build step, no native dependencies.** It loads directly and stores everything in Node's
  built-in SQLite. One folder, all plain files, fully yours.

---

## Actually better in a few places

Re-implementing a system is a chance to sand off the rough edges. pi-mimo-cme adds:

- 📊 **It measures its own cost.** Every checkpoint records exactly how many tokens and how much time
  it spent — so the project's performance decisions are made from data, not guesswork.
- 🤝 **It can't exaggerate what it did.** When the weekly consolidation runs, its report is computed
  from the *actual change to your memory files*, not from the AI narrating its own work. What it
  tells you happened, happened.
- 🛟 **It stays out of your way.** Index refreshes are debounced, oversized files are capped, and a
  live status footer (`🧠 N idx · M hist`) shows the system working without ever interrupting you.
- 🗂️ **It won't surprise you.** The consolidation clock starts the first time it sees your project —
  so a fresh install never kicks off a background pass on day one.

---

## Honest about the edges

No marketing page is complete without the fine print, and we'd rather you hear it from us:

- **Checkpoint quality is prompt-guided, not yet auto-validated.** MiMoCode runs a strict validator
  that can force the writer to redo an out-of-spec checkpoint. pi-mimo-cme relies on careful
  instructions plus the weekly cleanup pass instead — it's on the roadmap to add the validator.
- **In-session token-squeezing is left to pi.** MiMoCode aggressively rewrites the live conversation
  window to save tokens. pi-mimo-cme instead re-loads your memory cleanly when pi compacts or you
  resume, and leaves the in-window optimization to pi itself — the right call on this platform.
- **Task archiving needs richer task data.** Tied to a community task extension that keeps snapshots
  but not timestamps, so time-based task archiving isn't available today.

None of these affect the core promise: **your decisions, rules, discoveries, and history persist
across sessions, in files you own.** They're refinements, and they're written down — see the
[technical comparison](./MIMOCODE-PARITY-DEVS.md) for exactly where each stands.

---

## The bottom line

| | |
|---|---|
| **Same memory architecture as MiMoCode?** | Yes — four layers, identical checkpoint schema, same checkpoint cadence, same recall engine, same dream/distill passes. |
| **Same "your files are the truth" guarantee?** | Yes — Markdown is the source of truth; the database is a throwaway index. |
| **Where it differs** | Host-specific plumbing (event-bus integration instead of a native registry), plus a couple of refinements still on the roadmap. |
| **Where it's ahead** | Self-measuring, honest-by-construction reporting, and gentler on your session. |

You're getting MiMoCode's memory system as a first-class pi citizen — faithful to the original where
it matters, and pragmatically better where it can be.

➡️ **Get started:** [User Guide](./ONBOARDING-USERS.md) · **Look under the hood:**
[Technical comparison](./MIMOCODE-PARITY-DEVS.md) · [Developer guide](./ONBOARDING-DEVS.md)
