# OpenCode → MiMoCode Fork Delta — Memory-System Baseline Reference

Research date: 2026-06-13. **Purpose:** the definitive structural diff between upstream OpenCode and the MiMoCode fork, scoped to the memory system. Use this to (a) understand *what MiMoCode added on top of stock OpenCode*, (b) extend Pi's re-implementation against a known boundary, and (c) **debug against a reference baseline** — when Pi's memory behavior is wrong, this tells you exactly which MiMoCode file/symbol owns the equivalent behavior and whether it was inherited or invented.

## Sources & provenance

| Repo | Remote | Commit | Clone |
|---|---|---|---|
| **MiMoCode** (fork) | `github.com/XiaomiMiMo/MiMo-Code` | `42e7da3` (2026-06-11) | `/tmp/mimo-research/mimo-code` |
| **OpenCode** (base) | `github.com/anomalyco/opencode` | `73dbd8a` (2026-06-12) | `/tmp/mimo-research/opencode` |

Everything labeled with a `file:line` is **confirmed from source** at these commits. Paths are relative to `packages/opencode/src/` unless prefixed otherwise. `[OC]` tags refer to the OpenCode clone.

**Companion docs (read alongside this one):**
- `docs/research/mimo-memory-system.md` — the deep **"HOW it works"** reference: verbatim prompts (checkpoint-writer / dream / distill), full SQL schemas, the 11-section checkpoint template, ranking math, write/read lifecycle. **This doc deliberately does not duplicate those internals** — it gives the structural map and points there for the body.
- `docs/research/pi-extension-api.md` — the Pi v0.79.1 API surface the re-implementation targets.

> **How the two memory docs divide labor:** `mimo-memory-system.md` answers *"what does the memory system do and how?"* This doc answers *"which parts are MiMoCode's and which are inherited OpenCode, and where do they bolt together?"* If you're debugging, start here to localize the subsystem, then jump to `mimo-memory-system.md` for the internals.

---

## 0. TL;DR — the fork in one mental model

MiMoCode is OpenCode with **a database and a memory brain grafted onto the inherited agent loop**. The graft has four physical pieces:

1. **A SQLite layer that OpenCode never had** (`storage/db*.ts` + 34 migrations). OpenCode persists everything as loose `.json` files on disk (`[OC] storage/storage.ts` globs `storage/session/**/*.json`); it has *no database*. The memory system needs relational scoping + FTS5, so the fork adds one global SQLite DB.
2. **Four net-new subsystem directories** — `memory/`, `history/`, `task/`, `actor/` — that do not exist upstream at all.
3. **A checkpoint/consolidation subsystem inside the inherited `session/` dir** — ~20 net-new files (`checkpoint*.ts`, `prune.ts`, `auto-dream.ts`, `budgeted-read.ts`, …) plus three native-agent prompts (`agent/prompt/{checkpoint-writer,dream,distill}.txt`).
4. **~8 splice points** where that machinery hooks into OpenCode's otherwise-inherited `Session.prompt` runLoop (§7).

**The "stock vs added" rule of thumb when reading the fork:**
- If a file lives in `memory/ history/ task/ actor/`, or matches `session/checkpoint*`, `session/prune.ts`, `session/auto-dream.ts`, `session/budgeted-read.ts`, `session/boundary.ts`, `session/goal.ts`, `session/classify.ts`, `session/claude-import*`, `storage/db*`, `tool/{memory,history,actor,workflow,codesearch,memory-path-guard}.ts`, or `agent/prompt/{checkpoint-writer,dream,distill}.txt` → **it's a MiMoCode invention.**
- If it's anything else in `session/`, `tool/`, `agent/`, `provider/`, `config/`, `permission/`, `mcp/`, etc. → **it's inherited OpenCode**, possibly with memory hooks spliced in (the seams in §7).

Package identity also changed: `[OC] package.json name: "opencode"` → MiMoCode `package.json name: "@mimo-ai/cli"` (the directory is still `packages/opencode/`, so paths look identical — only the npm name differs).

---

## 1. The inherited substrate (what OpenCode gives the memory system to build on)

The memory system is not free-standing; it rides on OpenCode primitives. Knowing which primitives are *stock* tells you what behavior you can look up in upstream OpenCode docs vs. what is MiMoCode-specific.

**Inherited, used heavily, essentially unchanged in spirit:**
- **The `Session.prompt` runLoop** (`session/prompt.ts`) — the per-turn agent loop. Same skeleton in both; MiMoCode grew it from ~68 KB to ~147 KB purely by splicing in memory hooks (§7). This is the single most important inherited file.
- **The agent registry** (`agent/agent.ts`) — `native`/`hidden`/`mode` agent definitions, tool allowlists, permission merging. MiMoCode adds agents to it (§8) but the mechanism is stock.
- **The tool registry** (`tool/registry.ts`) — `Tool.init`/`builtin[]`/`all()`. MiMoCode pushes new tools into the same `builtin` array (§8).
- **Message/part model** (`session/message-v2.ts`, the `message`/`part` SQLite tables once the DB exists) — the raw trajectory the `history` subsystem indexes.
- **Permission system, MCP, providers, config schema plumbing** — all stock; MiMoCode adds config *keys* (§9) but the Effect-Schema config machinery is OpenCode's.
- **Compaction** (`session/compaction.ts`) — OpenCode's lossy LLM summarization. **Still present and still used** — but only for *subagents*. The fork's insight: replace compaction *for the main agent* with checkpoint-rebuild, keep compaction for subagents (`prompt.ts` routes `agentID !== "main"` to `compaction.create`).

**Inherited but fundamentally rebuilt:**
- **Storage** (`storage/`). `[OC] storage/storage.ts` is a JSON-file store: `pathForKey()` returns `<dir>/<...key>.json` (`[OC] storage.ts:64`); sessions/messages/parts are globbed from `storage/session/**/*.json`. MiMoCode keeps `storage.ts` + `schema.ts` but **adds an entire SQLite layer beside it** (§6). The raw `session`/`message`/`part` rows the memory system queries only exist because of this addition.
- **LLM request assembly** (`session/llm.ts`). `[OC]` splits this across a `session/llm/` subdir (`request.ts`, `native-request.ts`, `native-runtime.ts`, `ai-sdk.ts`). MiMoCode **deleted that subdir and folded everything into a monolithic `session/llm.ts`** — specifically so it could inline the memory-system-prompt injection into the `system()` builder (§7.2).

---

## 2. Top-level structural delta (`src/` directory level)

### 2.1 Directories that exist ONLY in MiMoCode (net-new)

| Dir | Memory-relevant? | What it is |
|---|---|---|
| **`memory/`** | ★ core | FTS5 memory search service over the markdown memory tree (§3) |
| **`history/`** | ★ core | FTS5 index + search over raw conversation trajectory (§4) |
| **`task/`** | ★ load-bearing | Task registry (the `§4 Task tree` source of truth) + gating (§5) |
| **`actor/`** | ★ load-bearing | Subagent/background-actor registry, spawn, turn, waiter, return-header (§5) |
| `workflow/` | indirect | Multi-agent workflow runs (separate from memory but shares the DB) |
| `inbox/` | indirect | Inter-actor messaging table |
| `global/` | indirect | Resolves `MIMOCODE_HOME`/XDG base paths (DB + memory roots live here) |
| `flag/` | indirect | `MIMOCODE_*` env flags (incl. `MIMOCODE_DB`, `MIMOCODE_HOME`, skip-migration toggles) |
| `metrics/`, `npm/`, `pty/`, `team/` | no | Unrelated fork features |

### 2.2 Directories that exist ONLY in OpenCode (dropped by the fork)

| `[OC]` dir | Note |
|---|---|
| `session/llm/` | Folded into MiMoCode's monolithic `session/llm.ts` (enabled the memory-prompt inline) |
| `background/` | Replaced by the `actor/` lifecycle model |
| `image/` | Dropped |

### 2.3 The memory system's footprint, by directory

| Directory | OpenCode | MiMoCode | Delta |
|---|---|---|---|
| `memory/` | — | 6 files | **+6 (all new)** |
| `history/` | — | 8 files | **+8 (all new)** |
| `task/` | — | 7 files | **+7 (all new)** |
| `actor/` | — | 10 files | **+10 (all new)** |
| `session/` | 20 files | 39 files | **+~20 checkpoint/memory files** |
| `tool/` | (no memory tools) | +`memory,history,actor,workflow,codesearch,memory-path-guard` | **+6 memory-relevant tools** |
| `agent/prompt/` | — | +`checkpoint-writer,dream,distill` `.txt` | **+3 prompts** |
| `storage/` | 2 files | 8 files | **+6 (SQLite layer)** |
| `migration/` | 1 dir | 34 dirs | **+33** (17 memory/history/task/actor-relevant) |

---

## 3. `memory/` — FTS search over the markdown memory tree (net-new)

| File | Responsibility |
|---|---|
| `paths.ts` | `Scope`/`MemoryType` taxonomy; `<data>/memory/<scope>/<scope_id>/<key>.md` layout; `resolveProjectId = sha256(absRepoPath)[:12]`; type-from-key regex |
| `service.ts` | The `memory.search` BM25 query (SQL in §4 of `mimo-memory-system.md`); relative score-floor; pre-search reconcile trigger |
| `reconcile.ts` | Directory-walk re-index: size+mtime `fingerprint` change detection; prunes rows whose file vanished. **This is how off-tool file writes become searchable** |
| `fts-query.ts` | `buildFtsQuery` — alnum-run → phrase-quoted literal, **OR-join** (rationale: BM25 ranks by token rarity; AND returns 0 for most multi-word queries) |
| `fts.sql.ts` | Drizzle `MemoryFtsTable` object — **a typed query target, NOT DDL** (see §6.4) |
| `index.ts` | Barrel/layer wiring |

Deep internals (ranking, escalation ladder, the `cc` scope for indexing Claude Code's memory): `mimo-memory-system.md` §2, §4.

---

## 4. `history/` — FTS over raw trajectory (net-new)

| File | Responsibility |
|---|---|
| `writer.ts` | Subscribes to the message-part event bus (`MessageV2.Event.PartUpdated/PartRemoved`); upserts/deletes `history_fts` rows through an unbounded queue. **Continuous indexing** |
| `backfill.ts` | Project-bootstrap backfill: newest-session-first, batches of 500, idempotent via `NOT EXISTS` |
| `extract.ts` | The `kind` taxonomy: `user_text \| assistant_text \| tool_input \| tool_error \| reasoning \| tool_output` |
| `resolve.ts` | Resolves the `around` anchor (±N whole messages) |
| `service.ts` | `history.search` / `history.around`; project/session/kind/tool filters; 50-result cap; 20 KB `around` cap |
| `fts-query.ts` | **Independent copy** of memory's query builder that uses **AND-join** (the two modules deliberately evolve apart) |
| `fts.sql.ts` | Drizzle `HistoryFtsTable` query target (re-exported by `storage/schema.ts:7`) |
| `index.ts` | Barrel/layer wiring |

Deep internals (default indexed kinds, opt-in `tool_output`/`reasoning`, the `around` byte-spill behavior): `mimo-memory-system.md` §3.2, §5.4.

---

## 5. `task/` and `actor/` — the registries the memory system reads (net-new, load-bearing)

These are not "memory" per se, but the checkpoint writer's **§4 Task tree** is sourced *exclusively* from the `task` tool/registry (it is forbidden to invent task IDs), and the rebuild dump's `## Active actors` / `## Tasks ledger` sections read these tables. So they are part of the memory system's *query surface*.

**`task/`** — user-facing task graph: `registry.ts`, `schema.ts`, `task.sql.ts` (the `task` + `task_event` tables), `gate.ts`/`gate-state.ts` (task gating), `events.ts`, `index.ts`.

**`actor/`** — subagent/background-actor lifecycle: `registry.ts` (the `actor_registry` table), `spawn.ts`/`spawn-ref.ts`, `turn.ts`, `waiter.ts`, `return-header.ts` (the subagent "Return format (required)" contract), `schema.ts`, `actor.sql.ts`, `events.ts`, `index.ts`. The checkpoint-writer, dream, and distill subagents are all *actors* registered here, and `actorReg.isSystemSpawned(...)` is the gate that suppresses memory-prompt injection for them (§7.2).

---

## 6. The SQLite storage layer (net-new — the enabling foundation)

OpenCode is fileystem/JSON-backed and has **no database**. The memory system's relational scoping (`scope`/`scope_id`/`project_id`) and FTS5 search are impossible without one, so the fork adds it. This is the single biggest "you can't port the memory system without this" dependency.

New files: `storage/db.ts`, `db.bun.ts`, `db.node.ts`, `schema.sql.ts`, `json-migration.ts`, `index.ts`.

### 6.1 Driver selection (resolved at bundle/runtime, not in JS)
Driver is chosen via Node `imports` conditions in `package.json:30-35`:
```jsonc
"#db": { "bun": "./src/storage/db.bun.ts", "node": "./src/storage/db.node.ts", "default": "./src/storage/db.bun.ts" }
```
- `db.bun.ts` — `new Database(path, {create:true})` from **`bun:sqlite`** + `drizzle-orm/bun-sqlite`.
- `db.node.ts` — `new DatabaseSync(path)` from **`node:sqlite`** (Node's built-in) + `drizzle-orm/node-sqlite`.

> **Pi note:** Pi's re-implementation runs on Node 24.4.0 and uses `node:sqlite` (the `db.node.ts` path) — verified to have FTS5 + `bm25()` (project memory). The `bun:sqlite` path is irrelevant to Pi.

### 6.2 DB file path resolution (`db.ts:37-43`, with env overrides)
1. `Flag.MIMOCODE_DB` set → `:memory:` or absolute used verbatim; else treated as a filename under `Global.Path.data`.
2. Else `<data>/mimocode.db`. (Per-channel `mimocode-<channel>.db` isolation exists but is **off by default** — `MIMOCODE_DISABLE_CHANNEL_DB` defaults `true`.)

`Global.Path.data` (`global/index.ts:8` → `@mimo-ai/shared/global` `global.ts:26-50`): if env **`MIMOCODE_HOME`** set (must be absolute) → `<MIMOCODE_HOME>/data`; else XDG → `<xdgData>/mimocode`.

### 6.3 Migration runner & **one global DB**
- Lazy singleton client (`db.ts:84`); on first open sets PRAGMAs `journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, cache_size=-64000, foreign_keys=ON` + a passive WAL checkpoint (`db.ts:89-94`).
- Migrations applied via Drizzle `migrate(db, entries)` (`db.ts:96-112`); entries from a build-injected `OPENCODE_MIGRATIONS` global, else scanned from `packages/opencode/migration/<YYYYMMDDHHMMSS_name>/migration.sql`, sorted by the timestamp prefix. `MIMOCODE_SKIP_MIGRATIONS` replaces each migration body with `select 1;` (test fast-path).
- **One global DB for everything.** No per-project file. Project/session/workspace separation is by **columns + FKs** (`history_fts.project_id`, `memory_fts.scope`/`scope_id`, `... REFERENCES session(id) ON DELETE CASCADE`), never separate DB files.

### 6.4 Where the DDL actually lives (debugging gotcha)
**The authoritative `CREATE TABLE` / `CREATE VIRTUAL TABLE` / triggers live ONLY in the timestamped `migration/*/migration.sql` files.** The `src/memory/fts.sql.ts` and `src/history/fts.sql.ts` files are **Drizzle `sqliteTable` objects used as typed query targets** (`db.insert/select/delete`), not DDL. They declare the base/content columns + secondary indexes but **cannot** declare the fts5 virtual table or the AI/AD/AU sync triggers. Consequence: the `*_idx` vtab and the critical `'delete'`-magic-command trigger fix are invisible to the Drizzle schema layer — the app writes the base table and relies on migration-defined triggers to keep `*_idx` in sync. If FTS rows go stale, look at the **migration triggers**, not `fts.sql.ts`.

---

## 7. Migration ledger — 33 MiMoCode-only migrations (17 memory-relevant)

A `comm` of the two `migration/` dirs: **every MiMoCode migration is fork-only**; OpenCode's single `20260511173437_session-metadata` is absent from MiMoCode. The memory-relevant ones, grouped by subsystem:

**memory_fts (FTS5 memory search)**
- `20260515010000_memory_fts` — initial `memory_fts` table (path PK) + `memory_fts_idx` fts5 vtab + AI/AD/AU triggers.
- `20260521010000_memory_fts_v6` — drop+recreate: autoinc `id` PK, `path` UNIQUE, `content_rowid='id'` (rowid stability — see `test/memory/fts-rowid-stability.test.ts`).
- `20260521020000_memory_fts_triggers` — **the war-story fix**: rewrites AD/AU triggers to use the FTS5 `'delete'` magic command (`INSERT INTO memory_fts_idx(memory_fts_idx,rowid,body) VALUES('delete',OLD.id,OLD.body)`) instead of `DELETE FROM` the external-content vtab (which leaked tokens → vtab corruption). The SQL comment documenting this is reproduced in `mimo-memory-system.md` §3.1.

**history_fts (FTS5 trajectory search)**
- `20260609000000_history_fts` — `history_fts` table (part_id PK) + `history_fts_idx` fts5 vtab + AI/AD/AU triggers (already using the correct `'delete'` form from the start — it was authored after the memory_fts lesson).

**Checkpoint cursor**
- `20260519000000_last_checkpoint_message_id` — `ALTER TABLE session ADD last_checkpoint_message_id text` (the per-session pointer the writer advances; enables fork=false "delta since last checkpoint" cold-start).

**Task registry (user-facing task graph)**
- `20260515020000_user_task` — `task` (composite PK `(session_id,id)`) + `task_event` tables.
- `20260529000000_task_todo_redesign`, `20260603000000_task_in_progress_owner` — schema evolution (drop `focus`/`kind`/`priority`; add `owner`).

**Actor registry (subagent lifecycle)**
- `20260422170000_task_registry` → `20260515000000_actor_rename` → `20260521000100_actor_registry_v6` → `20260527000000_actor_lifecycle` — the table was *born as* `task_registry`, renamed to `actor_registry`, rebuilt with composite PK `(session_id,actor_id)` + `mode`/`parent_actor_id`/`context_watermark`/`tools`, then given `lifecycle`/`last_outcome`/`last_error`.
- `20260521000000_message_agent_id`, `20260526000000_agent_id_main` — add `message.agent_id` (empty/`'main'` = main agent; non-empty = subagent) — the attribution dream/distill queries rely on.

**Adjacent (share the DB, not strictly memory):** `20260527000100_inbox` (inter-actor messaging), `20260603000000_workflow_run` (+ `script_sha`, `agent_timeout_ms`), `20260608000000_claude_import` (+ `claude_import_message_ids`) — importing Claude Code transcripts into the trajectory.

---

## 8. Session-loop integration seams (THE debugging section)

This is where MiMoCode's machinery splices into the inherited `Session.prompt` runLoop. **When memory behavior misfires, one of these eight hooks is the cause.** All refs are MiMoCode `session/` unless tagged `[OC]`.

| # | Hook | Location | Calls | Fires |
|---|---|---|---|---|
| 1 | **Memory system-prompt injection** | `llm.ts:256-280` | `buildMemoryInstructions(sid, pid, memoryRoot)` (`llm.ts:99`) + `migrateProjectMemory` | per LLM request, when assembling system prompt; **gated** by `actorReg.isSystemSpawned` (skipped for writer/dream/distill) |
| 2 | **Auto dream/distill spawn** | `prompt.ts:2253-2287` | `shouldAutoDream`/`shouldAutoDistill` (`auto-dream.ts:103,113`) → detached `Service.prompt({agent:"dream"\|"distill"})` | first model step of a top-level session (`step===1 && !session.parentID`) |
| 3 | **Per-turn recall reminder** | `prompt.ts:2156-2190` | `checkpoint.hasMemoryOrTasks` (`checkpoint.ts:958`) + `recallHintLines` | start of each turn, if the session has memory artifacts/tasks |
| 4 | **Memory-flush pressure nudge** | `prompt.ts:2319-2346` | `pressureLevel({cfg,tokens,model})` (`overflow.ts:35`) | mid-turn when pressure ≥2 (>70%) |
| 5 | **Mid-turn checkpoint firing** | `prompt.ts:2403-2418` | `prune.fireCheckpoints(...)` (`prune.ts:240`, `SessionPrune.fireCheckpoints`) | start of each runLoop iteration, before overflow check; skips system-spawned + `mode:"subagent"` actors |
| 6 | **Overflow → rebuild (turn boundary)** | `prompt.ts:2420-2499` | `overflowCheck` **OR** `prune.maxThresholdCrossed` → `checkpoint.insertRebuildBoundary` (`checkpoint.ts:1276`) → `prune.resetThresholds` | on overflow / max-threshold crossing; subagents route to `compaction.create` instead |
| 7 | **Overflow → rebuild (provider-signalled)** | `prompt.ts:2857-2923` | on stream `result==="overflow"`: `waitForWriter` → `insertRebuildBoundary` → `resetThresholds`; falls back to `compaction.create({overflow:true})` if no boundary | mid-stream, main-agent only, `!isBoundedComputation` |
| 8 | **Turn-end prune** | `prompt.ts:2934-2945` | `prune.prune({...})` (`prune.ts:370`, `SessionPrune.prune`) | turn end; soft-trims/strips old regeneratable tool outputs (replaces `[OC]` `compaction.prune`) |

The actual rebuild dump enters the stream inside `checkpoint.insertRebuildBoundary` → `renderRebuildContext` (`checkpoint.ts:1008/1285`), writing synthetic user-message text parts under the header `"Summary of previous conversation from checkpoint files:"` (`message-v2.ts:708`). The layered, per-section budgeted assembly of that dump is documented in `mimo-memory-system.md` §5.3.

### 8.1 System-prompt injection detail (seam #1)
MiMoCode **rewrote `llm.ts`'s `system()` builder** (`llm.ts:242-295`) — this is *why* the `[OC] session/llm/` subdir was deleted and folded into a monolith. After the stock prompt pushes, it computes `isSystemActor = actorReg.isSystemSpawned(...)` (`llm.ts:263-265`) and, when **not** a system actor, runs `migrateProjectMemory(projectID)` then `system.push(buildMemoryInstructions(...))` (`llm.ts:278-279`). The full text of that block is in `mimo-memory-system.md` §7. **`[OC]` has no equivalent** — its system array is assembled in `session/llm/request.ts` + `native-request.ts` with zero memory logic.

### 8.2 Threshold-default gotcha (seam #5) — code vs docstring
`config.ts` documents `checkpoint.thresholds` default as `["40%","60%","80%"]`. **That docstring is stale.** When `thresholds` is unset, `prune.ts:287` uses `cfg.checkpoint?.thresholds ?? defaultThresholdsFor(windowSize)`, and `defaultThresholdsFor` (`prune.ts:44-49`) returns window-size-dependent lists:
```
window < 25K        → []                              (subsystem disabled)
25K ≤ w ≤ 200K      → ["20%","40%","60%","80%"]
200K < w ≤ 500K     → every 10% (10%…90%)
w > 500K            → every 5%
```
**Code wins.** A debugger who trusts the docstring will predict the wrong firing points. (Pi's re-implementation deliberately uses a flat `20/40/60/80%` — matching the 25K–200K row — per project memory.)

### 8.3 STOCK vs ADDED in `session/`
**Inherited, memory hooks spliced in:** `prompt.ts` (the 8 hooks), `system.ts` (only reworded identity string), `overflow.ts` (added `pressureLevel`), `instruction.ts`, `compaction.ts` (still used — for subagents), `retry.ts`, `revert.ts`, `run-state.ts`, `summary.ts`, `todo.ts`, `status.ts`, `processor.ts`, `message*.ts`.
**Rewritten:** `llm.ts` (monolith + memory injection).
**Net-new (no `[OC]` equivalent):** `auto-dream.ts`, `prune.ts` (the `SessionPrune` service), `checkpoint.ts` + satellites (`checkpoint-align.ts`, `checkpoint-context.ts`, `checkpoint-paths.ts`, `checkpoint-progress-reconcile.ts`, `checkpoint-retry.ts`, `checkpoint-templates.ts`, `checkpoint-validator.ts`), `boundary.ts`, `budgeted-read.ts`, `classify.ts`, `claude-import.ts`(+`.sql.ts`), `goal.ts`, `last-message-info.ts`, `llm-request-prefix.ts`, `max-mode.ts`, `prefix-capture-ref.ts`, `projectors.ts`, `session.sql.ts`.
**`[OC]`-only, dropped:** `session/llm/` subdir (`request.ts`, `native-request.ts`, `native-runtime.ts`, `ai-sdk.ts`), `reminders.ts`, `tools.ts`, `message-error.ts`.

---

## 9. Tool, native-agent & config registration deltas

### 9.1 Tools (registered into the same inherited `builtin[]`)
MiMoCode pushes new tools into the stock `tool/registry.ts` `builtin` array (`registry.ts:249-252` etc.). Tool IDs exposed to the model (literal first arg to `Tool.define`):

| Tool | ID | File | Notes |
|---|---|---|---|
| memory | `"memory"` | `tool/memory.ts:22` | single op `operation:enum(["search"]).default("search")` — **read-only** |
| history | `"history"` | `tool/history.ts:42` | ops `["search","around"]` — read-only |
| actor | `"actor"` | `tool/actor.ts:264` | replaces `[OC]`'s `tool.task` slot |
| task | `"task"` | `tool/task.ts:329` | the §4 Task-tree source of truth |
| workflow | `"workflow"` | `tool/workflow.ts:55` | gated on `MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL` |
| codesearch | `"codesearch"` | `tool/codesearch.ts:8` | provider-filtered |

**There is NO memory-write tool** (confirmed three ways: the `memory` tool's only op is `search`; no `memory.write/save/store` tool exists repo-wide; the registry registers none). Memory files are written through the **ordinary `write`/`edit`/`apply_patch` tools**, gated by the path guard:

- `assertMemoryWriteAllowed(...)` (`tool/memory-path-guard.ts:95`) is a pure function: early-returns for targets outside `<memoryRoot>`; for `agentName==="checkpoint-writer"` enforces a precise allowlist (`projects/<pid>/memory.md|memory-*.md`, `sessions/<sid>/checkpoint.md|notes.md|checkpoint-*.md`, `sessions/<sid>/tasks/<TID>/*.md`); for every other agent throws on anything under `sessions/<sid>/tasks/` unless bound to that exact `taskId`.
- It's called via the funnel `assertWriteAllowed` (`tool/external-directory.ts:76`, calls guard at `:97`), which **every write tool invokes first**: `edit.ts:79`, `write.ts:39`, `apply_patch.ts:70/130`.

> **Debugging implication:** if a memory write is mysteriously rejected, the throw is in `memory-path-guard.ts`, reached through `external-directory.ts:assertWriteAllowed`, not in the memory subsystem itself.

### 9.2 Native agents (`agent/agent.ts`)
Net-new agents vs `[OC]` (which has only `build/plan/general/explore/compaction/title/summary`):

| Agent | Flags | Tool allowlist | Prompt | Loaded where |
|---|---|---|---|---|
| **checkpoint-writer** | `mode:subagent, native, hidden` | *none in agent.ts* — fork agent; runtime whitelist set at spawn | `agent/prompt/checkpoint-writer.txt` | imported in `session/checkpoint.ts:25`, injected `:300` with `{{SECTION_BUDGETS}}` |
| **dream** | `mode:subagent, native, hidden` | `[read,write,edit,glob,grep,memory,bash]` + `external_directory` under `<data>/memory` | `agent/prompt/dream.txt` (`PROMPT_DREAM`) | `agent.ts:315-341` |
| **distill** | `mode:subagent, native, hidden` | `[read,write,edit,glob,grep,memory,bash]` + same external dir | `agent/prompt/distill.txt` (`PROMPT_DISTILL`) | `agent.ts:342-368` |

MiMoCode also adds a non-memory `compose` primary agent (and optional `max`), and adds the `toolAllowlist` field to the agent `Info` schema (`agent.ts:51`). Note `[OC]` makes `compaction/title/summary` `mode:"primary"`+hidden; MiMoCode makes them `mode:"subagent"`+hidden. Verbatim prompts for checkpoint-writer/dream/distill are in `mimo-memory-system.md` §8.

### 9.3 Config keys (all net-new; `[OC] config.ts` has zero matches for these)
`checkpoint.*` (`config.ts:252-322`): `thresholds`, `reserved` (20000), `max_writer_failures` (3), `fork` (false), `push_caps.{tasks_ledger:2000, focus_task:4000, actor_ledger:500, memory_titles:500, global:6000, checkpoint:11000, memory:10000, notes:6000, design_decisions:3000, open_notes:800}`, `task_archive_days` (7), `memory_reconcile_on_search` (true), `memory_search_score_floor` (0.15).
`memory.cc_index` (false). `history.kinds` (defaults `[user_text, assistant_text, tool_input, tool_error]`). `dream.{auto:true, interval_days:7}`. `distill.{auto:true, interval_days:30}`.

> **Caveat:** `checkpoint.reserved` docstring says 20000 but the code constant `CHECKPOINT_RESERVED` is 13000 — another doc-vs-code drift (see `mimo-memory-system.md` §10).

---

## 10. Using this as Pi's debugging baseline

When Pi's memory extension misbehaves, map the symptom to the MiMoCode owner, then compare:

| Pi symptom | MiMoCode reference to compare against |
|---|---|
| FTS search returns stale / missing rows | `memory/reconcile.ts` (fingerprint walk) + the **migration triggers** (`20260521020000_memory_fts_triggers`, the `'delete'` form) — NOT `fts.sql.ts` (§6.4) |
| Search returns 0 for multi-word queries | `memory/fts-query.ts` OR-join + relative score floor (`memory_search_score_floor:0.15`) |
| Checkpoint fires at wrong context % | `prune.ts:44` `defaultThresholdsFor` (NOT the config docstring — §8.2). Pi uses flat 20/40/60/80% by design |
| Memory not injected into context | Seam #1 (`llm.ts:256` `buildMemoryInstructions`, gated by `isSystemSpawned`). Pi diverges: injects every turn (Pi can't guarantee compaction/rebuild) |
| Writer can't write a memory file | `memory-path-guard.ts:95` via `external-directory.ts:assertWriteAllowed` (§9.1) |
| Dream/distill never auto-runs | Seam #2 (`prompt.ts:2253`, gate `step===1 && !parentID`; `auto-dream.ts` interval check vs last `Auto Dream` session). Pi sets distill auto **OFF** by default |
| DB in wrong location | `db.ts:37` path resolution + `MIMOCODE_HOME`/`MIMOCODE_DB` (§6.2). Pi uses its own data dir |

**Known intentional Pi divergences from this baseline** (from project memory / README):
- Project+global memory injected into the system prompt **every turn** (MiMoCode injects at rebuild; Pi can't guarantee a compaction/rebuild hook).
- Flat `20/40/60/80%` thresholds (MiMoCode's 25K–200K-window default).
- Distill auto **OFF** by default (MiMoCode: ON, 30d).
- **No preStop validators** in Pi v1 (MiMoCode has `checkpoint-validator.ts` + the `actor.preStop`/`postStop` plugin hooks).
- Headless subprocess model: Pi runs checkpoint-writer/dream/distill as `pi --no-extensions -p` subprocesses with `PI_MIMO_CME_CHILD=1`, vs MiMoCode's in-process native actors.

---

## 11. Caveats / not verified

- **Plugin-hook seams not fully traced here:** `src/plugin/checkpoint-splitover.ts` (preStop validator-retry) and `subagent-progress-checker.ts` (postStop progress journal) are documented in `mimo-memory-system.md` §5.2 but their registration into the inherited plugin system was not re-diffed against `[OC]` for this report.
- **Line numbers** are from commit `42e7da3` and will drift; the **symbol names** (`fireCheckpoints`, `buildMemoryInstructions`, `insertRebuildBoundary`, `assertMemoryWriteAllowed`, `defaultThresholdsFor`) are the durable handles — grep for those.
- **`workflow/`, `inbox/`, `team/`, `metrics/`** were classified as non-memory and not deeply read; they share the DB but don't touch the memory tree.
- This doc is a *structural* diff. For *behavioral* internals (ranking math, the 11-section template, verbatim prompts, the rebuild dump's section budgets), `mimo-memory-system.md` remains authoritative.
