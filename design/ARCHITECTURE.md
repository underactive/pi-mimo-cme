## Architecture

MiMoCode frames agent bottlenecks across three time scales; each maps to concrete machinery here:

- **Computation** (single-turn quality): system-prompt injection every turn (`inject.ts`), the `memory` BM25 tool +
  `history` firehose tool (`tools.ts` + `fts.ts`), zero-hit escalation ladder.
- **Memory** (multi-turn continuity): `notes.md` scratchpad (taught in prompt, enforced by `guard.ts`),
  context-usage thresholds that fire checkpoints (`checkpoint.ts`), one-shot rebuild dump after resume/fork/compact.
- **Evolution** (cross-session): **dream** (consolidate/dedupe/prune) and **distill** (package workflows into pi
  skills) passes — headless `pi` subprocesses driven by prompts in `src/prompts/`.

### The load-bearing invariant

> **Markdown files (layers 1–3) are the source of truth. `memory.db` is a *derived* index plus the layer-4 history
> store. Deleting `memory.db` must lose no curated memory.**

`reconcile.ts` is what makes this true: it rebuilds index rows from the file tree by **size-mtime fingerprint** (lazily,
before each memory search). **If you add a write path that updates the DB without a corresponding markdown file, you
have broken the invariant.** The four layers:

| Layer | Artifact | Writer |
|---|---|---|
| 1. Session | `sessions/<sid>/checkpoint.md` (11 §) + `notes.md` | in-process checkpoint-writer session (checkpoint.md); main agent (notes.md, append-only) |
| 2. Project | `projects/<pid>/MEMORY.md` (4 §) | writer + dream; agent may Edit for explicit user rules |
| 3. Global | `global/MEMORY.md` | dream promotes entries; read-only for the agent |
| 4. History | every message in `memory.db` (`history_fts` + FTS5) | automatic: `message_end` events + JSONL backfill |

Memory root is `~/.pi/agent/pi-mimo-cme/` (respects `PI_CODING_AGENT_DIR`) — the **package name**, not a generic
`memory/`, so it can't collide with a future pi-native memory feature. `pid` = first 12 hex of `sha256(absolute cwd)`.

### Module map

`index.ts` is a deliberately thin **factory**: it opens resources once, wires every `pi.on` handler, registers the
tools/commands, and closes on shutdown. Real logic lives in focused modules — **keep `index.ts` as wiring only.**

```
src/
  index.ts      FACTORY: env guard, openDb, wire pi.on handlers, register tools/commands, close on shutdown
  config.ts     DEFAULT_CONFIG + config.json overlay & validation                 [pure]
  paths.ts      memory root, pid/sid → file paths, type-from-key regex            [pure]  ← source of truth for layout
  db.ts         openDb/migrate (PRAGMA user_version), schema SQL, meta get/set
  fts.ts        buildFtsQuery (OR/AND), memorySearch (score floor), historySearch/around   [pure-ish]
  reconcile.ts  tree walk + fingerprint upsert/prune (+ optional "cc" scope)
  budget.ts     token estimate + budgetedRead with truncation marker             [pure]
  templates.ts  checkpoint (11 §) / MEMORY (4 §) / notes templates + section budgets   [pure]
  inject.ts     system-prompt appendix + rebuild-dump assembly
  history.ts    message_end extraction, per-session seq counter, JSONL backfill
  checkpoint.ts usage thresholds, delta serialization, in-process writer via runWriter (queue depth 1), nudges
  guard.ts      path guard for write/edit under the memory root                   [pure]
  tools.ts      `memory` + `history` tool definitions
  commands.ts   /memory /dream /distill, reconcile+notify, status text
  prompts/      checkpoint-writer.ts, dream.ts, distill.ts — adapted MiMoCode prompts (template fns)
```

**Pure modules** (no `pi` imports) are unit-tested under plain `node --test`. Rule of thumb: if logic can be pure, put
it in a pure module and test it; the `pi`-coupled modules are wired together only in `index.ts`.