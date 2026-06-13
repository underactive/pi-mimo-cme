# pi-mimo-cme

A [pi](https://pi.dev) extension that re-implements [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code)'s
cross-session memory system: markdown files as the source of truth, SQLite FTS5 as a
derived index, an in-process checkpoint-writer session as the sole curator of structured memory,
and periodic LLM passes that consolidate and package what was learned.

## Computation / Memory / Evolution

MiMoCode frames agent bottlenecks across three time scales; this extension maps each to
concrete machinery:

| Principle | Bottleneck | What pi-mimo-cme does |
|---|---|---|
| **Computation** | single-turn decision quality | injects memory instructions + project/global memory into the system prompt every turn; `memory` tool (BM25 recall with a relative score floor); `history` tool as the escalation target; zero-hit escalation ladder |
| **Memory** | multi-turn continuity | `notes.md` scratchpad (taught, guarded); window-scaled context-usage thresholds (`"auto"`: every 20%/10%/5%) fire an in-process checkpoint-writer session; one-shot checkpoint dump after resume / fork / compaction; 70%/85% memory-flush nudges |
| **Evolution** | cross-session improvement | `dream` pass (consolidate, dedupe, prune — auto every 7 days) and `distill` pass (package repeated workflows into pi skills/commands — auto every 30 days) |

Hierarchy principle (MiMoCode): *"the upper layers are more refined, more persistent,
and smaller; the lower layers are more complete, larger, and slower."*

## The four layers

Root: `~/.pi/agent/pi-mimo-cme/` (respects `PI_CODING_AGENT_DIR`). The root is the
package name rather than a generic `memory/` so it can't collide with other extensions —
or with a future pi-native memory feature — sharing `~/.pi/agent/`.

| Layer | Artifact | Scope / lifetime | Writer |
|---|---|---|---|
| 1. Session memory | `sessions/<sid>/checkpoint.md` (11 sections) + `notes.md` | one session | in-process checkpoint-writer session (checkpoint.md, exclusive); main agent (notes.md, append-only) |
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
- `/memory metrics` — the checkpoint-writer cost readout (writer tokens vs. parent
  context per run) with a fork-vs-delta build-or-skip verdict (see divergence #5).
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

## Config — `~/.pi/agent/pi-mimo-cme/config.json` (all optional)

```jsonc
{
  "checkpoint": {
    "thresholds": "auto",             // window-scaled schedule (every 20%/10%/5%); or pin a flat array like [20,40,60,80]
    "scoreFloor": 0.15,               // relative BM25 floor (0 disables)
    "reconcileOnSearch": true,        // lazy file-tree reconcile before memory searches
    "reconcileDebounceMs": 4000,      // skip the reconcile walk if one ran this recently in-session (0 disables)
    "maxWriterFailures": 3,           // consecutive writer failures before giving up
    "pushCaps": {                     // per-section token budgets for injection
      "checkpoint": 11000, "memory": 10000, "global": 6000,
      "notes": 6000, "memoryKeys": 500, "actors": 2000
    }
  },
  "history": {
    // indexed kinds; add "reasoning" and/or "tool_output" to opt in
    "kinds": ["user_text", "assistant_text", "tool_input", "tool_error"]
  },
  "memory": { "ccIndex": false },     // index ~/.claude/projects/*/memory as scope "cc"
  "tasks":  { "enabled": true },      // observe @tintinweb/pi-subagents events → actor ledger (off = skip the wiring)
  "dream":   { "auto": true,  "intervalDays": 7 },
  "distill": { "auto": true, "intervalDays": 30 }
}
```

Auto passes start their interval clock on first sight of a project (no surprise dream
on a fresh install); background runs are logged to `~/.pi/agent/pi-mimo-cme/logs/`.

## How a session flows

1. **Every prompt**: the system prompt gains the memory instructions, the project and
   global MEMORY.md bodies (budgeted, with `⚠️ Truncated…` markers and Read offsets),
   and a memory-keys index of everything else searchable. Stable text keeps the prompt
   cache warm.
2. **During the session**: every finalized message is extracted into `history_fts`.
   When context usage crosses a threshold, the conversation delta since the last
   checkpoint is serialized and handed **inline** to an in-process pi SDK writer session
   (an in-memory `createAgentSession` with no extensions and no persisted session) that
   updates `checkpoint.md` / `MEMORY.md` and wipes `notes.md` back to its template (one
   writer at a time; newest pending request wins). At 70% / 85% usage the agent gets a
   one-time "context is filling up — write to memory now" nudge. `session_before_compact`
   fires a final checkpoint and waits up to 60s.
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
2. **~~Flat thresholds.~~ Window-scaled thresholds (now matches MiMoCode).** Like
   MiMoCode, `"thresholds": "auto"` (the default) scales checkpoint density with the
   model's context window — every 20% ≤200K, every 10% to 500K, every 5% beyond — so
   big-context models (e.g. 1M windows) checkpoint ~4× finer than a flat schedule. Pin a
   flat array (e.g. `[20, 40, 60, 80]`) to opt out and ignore the window.
3. **~~Distill auto-runs are off by default.~~ Distill auto-runs every 30 days (now matches
   MiMoCode).** Like MiMoCode, the distill pass runs automatically on the first prompt of a
   session once a project is ≥30 days old, packaging recurring workflows into skills/commands.
   It writes executable assets unprompted — set `"distill": { "auto": false }` to keep it
   manual (`/distill`) if that's too eager for a given project.
4. **No preStop validators in v1.** MiMoCode validates the writer's output (section
   structure, budgets) and forces reflection-retries. Here the writer prompt's budget
   text and dream's prune phase carry that pressure alone.
5. **In-process writer fed an inlined delta (not a forked context).** The checkpoint
   writer runs as an in-process pi SDK session (`createAgentSession` +
   `SessionManager.inMemory` + a `noExtensions` resource loader), handed the serialized
   conversation delta **inline** — no subprocess and no `delta-<n>.md` temp file. This
   removes the per-checkpoint process start and gives the writer state directly from the
   live parent rather than across a file boundary. It does **not** restore prefix-cache
   reuse: the writer is still a separate conversation with its own system prompt and tool
   schema, so its token prefix can't match the parent's. True reuse would require forking
   the parent's full prefix + tool schema (MiMoCode's `fork=true`), which even MiMoCode
   leaves off by default. An SDK investigation found `fork=true` is not merely neutral
   here but a likely **regression**: the deep (conversation) cache breakpoint can't be hit
   unless the writer carries the parent's *full* tool schema — which includes this
   extension's own tools and would therefore re-bind it (the recursion Phase 1 removed) —
   and even granted a hit, the writer would carry the entire parent context (tens-to-
   hundreds of K tokens) every checkpoint instead of a small delta, on top of date/cwd/TTL/
   auth-mode cache-bust vectors. Per the plan's own gate (*"only if profiling shows the
   writer's cold-start cost actually matters"*), the writer is now **instrumented**: each
   run records its token usage against the parent context size into a `writer_metrics`
   table, surfaced by **`/memory metrics`** with a build-vs-skip verdict — so the delta-vs-
   fork call is made from data, not theory. The delta thus remains a condensed text handoff
   (tool I/O clipped to 500 chars, whole delta capped at ~100KB, newest kept). Dream/distill
   still run as subprocesses (long-running, fire-and-forget, process-isolated).
6. **Actor (subagent) ledger + user task graph — both via soft community-extension deps.**
   *Actor half:* when `@tintinweb/pi-subagents` is loaded, the extension observes its
   lifecycle events over `pi.events` — a soft, optional dependency: no `import`, no spawn
   RPC, purely serializable event payloads — and derives an `actor` ledger plus per-subagent
   `progress.md` journals under `sessions/<sid>/tasks/<id>/` (synthesized from completion
   payloads, since we can't run a `postStop` hook inside another extension's subagent). The
   ledger is scoped to **background** subagents: pi-subagents emits `created` and the
   terminal `completed`/`failed` events only for background agents — foreground agents emit
   just `started` and return their result inline, so the conversation delta already captures
   them. (Verified end-to-end against live pi-subagents via `scripts/smoke-subagents.sh`.)
   *Task-graph half:* when `@juicesharp/rpiv-todo` is loaded, the extension reads its task
   snapshot — also softly, never imported. rpiv-todo emits nothing on the bus and writes no
   disk; instead every `todo` tool-result carries the full task list in its `details`, so we
   reconstruct the live graph by scanning the session branch last-write-wins, exactly as
   rpiv-todo's own replay does (plan §7; verified end-to-end via `scripts/smoke-todo-branch.sh`).
   checkpoint **§4 Task tree** (restored to MiMoCode's name) is reconciled from an inlined
   TASK GRAPH block (the todos) plus a `### Subagents` sub-block (the actor ledger), and the
   rebuild dump surfaces open todos under `## Open tasks` above in-flight actors under
   `## Active actors`. Fidelity caveats vs MiMoCode's `task`/`task_event`: rpiv-todo is a flat
   list + `blockedBy` dependency DAG (not a parent/child tree), carries **no timestamps**
   (so `task_archive_days` is unfillable and not implemented), and exposes **snapshots only**
   (no `task_event` history log). With both deps absent the ledger/snapshot stay empty and §4
   renders "(no tasks or subagents this session)"; nothing breaks. Toggle the whole layer
   with `"tasks": { "enabled": false }`.
7. **History rows are keyed by `(session_id, seq)`** with a synthetic
   `message_id = "<sid>#<seq>"`, rather than MiMoCode's message/part IDs — pi exposes
   messages, not parts. Dream/distill prompts document this schema for their SQL phase.
8. **Auto-pass scheduling lives in the `meta` table** (`last_dream_at:<pid>`), not in
   session titles, and the first sighting of a project starts the clock instead of
   firing immediately.
