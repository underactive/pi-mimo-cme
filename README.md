# pi-mimo-cme

A [pi](https://pi.dev) extension that re-implements [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code)'s
cross-session memory system: markdown files as the source of truth, SQLite FTS5 as a
derived index, a checkpoint-writer subprocess as the sole curator of structured memory,
and periodic LLM passes that consolidate and package what was learned.

## Computation / Memory / Evolution

MiMoCode frames agent bottlenecks across three time scales; this extension maps each to
concrete machinery:

| Principle | Bottleneck | What pi-mimo-cme does |
|---|---|---|
| **Computation** | single-turn decision quality | injects memory instructions + project/global memory into the system prompt every turn; `memory` tool (BM25 recall with a relative score floor); `history` tool as the escalation target; zero-hit escalation ladder |
| **Memory** | multi-turn continuity | `notes.md` scratchpad (taught, guarded); context-usage thresholds (20/40/60/80%) fire a checkpoint-writer subprocess; one-shot checkpoint dump after resume / fork / compaction; 70%/85% memory-flush nudges |
| **Evolution** | cross-session improvement | `dream` pass (consolidate, dedupe, prune — auto every 7 days) and `distill` pass (package repeated workflows into pi skills/commands — manual by default) |

Hierarchy principle (MiMoCode): *"the upper layers are more refined, more persistent,
and smaller; the lower layers are more complete, larger, and slower."*

## The four layers

Root: `~/.pi/agent/memory/` (respects `PI_CODING_AGENT_DIR`).

| Layer | Artifact | Scope / lifetime | Writer |
|---|---|---|---|
| 1. Session memory | `sessions/<sid>/checkpoint.md` (11 sections) + `notes.md` | one session | checkpoint-writer subprocess (checkpoint.md, exclusive); main agent (notes.md, append-only) |
| 2. Project memory | `projects/<pid>/MEMORY.md` (4 sections) | all sessions in a project (`pid` = 12-hex sha256 of the cwd) | writer + dream; main agent may Edit for explicit user rules |
| 3. Global memory | `global/MEMORY.md` | all projects (user preferences) | dream pass promotes entries; read-only for the agent |
| 4. History | every conversation fragment in `memory.db` (`history_fts` + FTS5 index) | forever, machine-wide | automatic (`message_end` indexing + JSONL backfill) |

Layers 1–3 are markdown files — the source of truth. The SQLite database is a derived
index (reconciled lazily by size-mtime fingerprints before every search) plus the native
layer-4 store. **Deleting `memory.db` loses no curated memory.**

## Install

Any one of:

1. **Package install** (from a git host once published):
   `pi install git:github.com/<you>/pi-mimo-cme`
2. **settings.json** — add the absolute path to `~/.pi/agent/settings.json` (global) or
   `.pi/settings.json` (project):
   ```json
   { "extensions": ["/path/to/pi-mimo-cme"] }
   ```
3. **Symlink** into the auto-discovery directory:
   ```sh
   ln -s /path/to/pi-mimo-cme ~/.pi/agent/extensions/pi-mimo-cme
   ```
   (the `package.json` `"pi": { "extensions": ["./src/index.ts"] }` field tells the
   loader what to load)

For a one-off trial: `pi -e /path/to/pi-mimo-cme/src/index.ts`.

No build step and no runtime dependencies — pi loads the TypeScript directly via jiti,
and storage is `node:sqlite`.

Development: `npm install`, then `npm run typecheck` and `npm test` (Node ≥ 24, plain
`node --test` over erasable TypeScript).

## Commands

- `/memory` — status: per-scope index counts, history row counts, db size, last
  dream/distill timestamps, current session/project paths.
- `/memory search <query>` — run the same BM25 search the model uses; prints top hits.
- `/memory dream`, `/memory distill` — aliases for the commands below.
- `/dream` — manual consolidation pass **in the current session** (you watch it work).
- `/distill` — manual workflow-packaging pass in the current session.

## Tools (registered for the model)

- **`memory`** — `query`, optional `scope` (global | projects | sessions | cc),
  `scope_id`, `type`, `limit`. BM25 over markdown bodies, OR-joined tokens, relative
  score floor (top hit always kept). Reconciles the file tree before searching, so
  off-tool writes are immediately searchable. Zero hits return an escalation ladder.
- **`history`** — `operation=search` (AND-joined query; filters: scope project|global,
  `session_id`, `kind[]`, `tool_name`, `time_after`/`time_before`, limit ≤ 50) or
  `operation=around` (±N rows around a `message_id` from a search hit, output capped at
  20KB). Described to the model as the *unindexed firehose*: use only when `memory`
  returns nothing useful.

There is **no memory-write tool**: writes go through ordinary `write`/`edit` calls,
constrained by a path guard that allows only `sessions/<sid>/notes.md` and
`projects/<pid>/MEMORY.md`; everything else under the memory root is blocked
(checkpoint.md is the writer's domain; no `learning.md`, no `scratch.md`).

## Config — `~/.pi/agent/memory/config.json` (all optional)

```jsonc
{
  "checkpoint": {
    "thresholds": [20, 40, 60, 80],   // context-% crossings that fire the writer
    "scoreFloor": 0.15,               // relative BM25 floor (0 disables)
    "reconcileOnSearch": true,        // lazy file-tree reconcile before memory searches
    "maxWriterFailures": 3,           // consecutive writer failures before giving up
    "pushCaps": {                     // per-section token budgets for injection
      "checkpoint": 11000, "memory": 10000, "global": 6000,
      "notes": 6000, "memoryKeys": 500
    }
  },
  "history": {
    // indexed kinds; add "reasoning" and/or "tool_output" to opt in
    "kinds": ["user_text", "assistant_text", "tool_input", "tool_error"]
  },
  "memory": { "ccIndex": false },     // index ~/.claude/projects/*/memory as scope "cc"
  "dream":   { "auto": true,  "intervalDays": 7 },
  "distill": { "auto": false, "intervalDays": 30 }
}
```

Auto passes start their interval clock on first sight of a project (no surprise dream
on a fresh install); background runs are logged to `~/.pi/agent/memory/logs/`.

## How a session flows

1. **Every prompt**: the system prompt gains the memory instructions, the project and
   global MEMORY.md bodies (budgeted, with `⚠️ Truncated…` markers and Read offsets),
   and a memory-keys index of everything else searchable. Stable text keeps the prompt
   cache warm.
2. **During the session**: every finalized message is extracted into `history_fts`.
   When context usage crosses a threshold, the conversation delta since the last
   checkpoint is serialized to `sessions/<sid>/delta-<n>.md` and a fresh
   `pi --no-extensions -p "<writer prompt>"` subprocess updates `checkpoint.md` /
   `MEMORY.md` and wipes `notes.md` back to its template (one writer at a time; newest
   pending request wins). At 70% / 85% usage the agent gets a one-time "context is
   filling up — write to memory now" nudge. `session_before_compact` fires a final
   checkpoint and waits up to 60s.
3. **After resume / fork / compaction**: the first prompt gets a one-shot persistent
   message — checkpoint.md (11K cap) + notes.md (6K cap) + memory keys (500) — framed
   with "Resume directly. Do not acknowledge this memory dump, do not recap."
4. **Across sessions**: on startup, past session JSONLs are backfilled into history
   (idempotent, fingerprint-gated), and the dream pass runs in the background when due.

## Divergences from MiMoCode

Deliberate adaptations, in roughly decreasing order of consequence:

1. **Project/global memory ride in the system prompt every turn.** MiMoCode injects
   them only at checkpoint rebuilds because its loop guarantees rebuilds happen; pi
   sessions may never compact, so the small upper layers are always present instead.
   The per-turn text is stable, so the provider prompt cache stays warm.
2. **Flat thresholds.** MiMoCode scales threshold density with the model's context
   window (every 5–20%). We default to a flat `[20, 40, 60, 80]` (configurable) —
   window-size-dependent tiers are overkill for v1.
3. **Distill auto-runs are off by default.** MiMoCode auto-distills every 30 days.
   Creating skills/extensions unprompted is more invasive than editing memory files, so
   `/distill` is manual unless you set `"distill": { "auto": true }`.
4. **No preStop validators in v1.** MiMoCode validates the writer's output (section
   structure, budgets) and forces reflection-retries. Here the writer prompt's budget
   text and dream's prune phase carry that pressure alone.
5. **Subprocess writer instead of an in-process subagent.** pi has no subagent
   machinery; the checkpoint writer is a fresh `pi --no-extensions -p` process fed a
   serialized conversation delta file (`delta-<n>.md`) instead of a forked context.
   Consequences: no prefix-cache reuse, and the delta is condensed (tool I/O clipped to
   500 chars, file capped at 100KB, newest kept).
6. **No task registry / actor system.** checkpoint.md keeps all 11 sections for
   structural fidelity, but §4 Task tree is pinned to "(no task registry)" and the
   subagent progress machinery is dropped.
7. **History rows are keyed by `(session_id, seq)`** with a synthetic
   `message_id = "<sid>#<seq>"`, rather than MiMoCode's message/part IDs — pi exposes
   messages, not parts. Dream/distill prompts document this schema for their SQL phase.
8. **Auto-pass scheduling lives in the `meta` table** (`last_dream_at:<pid>`), not in
   session titles, and the first sighting of a project starts the clock instead of
   firing immediately.
