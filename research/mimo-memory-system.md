# MiMoCode Cross-Session Memory System — Technical Report

Research date: 2026-06-12.
Sources:
- Blog: https://mimo.xiaomi.com/blog/mimo-code-long-horizon (fetched via WebFetch; paraphrased by fetch model, marked "from blog")
- Source: https://github.com/XiaomiMiMo/MiMo-Code @ commit `42e7da3` (shallow clone at `/tmp/mimo-research/mimo-code`)
- Baseline: https://github.com/anomalyco/opencode (shallow clone at `/tmp/mimo-research/opencode`)

Everything below labeled with a file path is **confirmed from source**. Items labeled "from blog" are from the announcement post (paraphrased by the fetching model, not byte-verbatim). Discrepancies between blog and code are called out.

MiMoCode is a fork of OpenCode (the npm scope is `@mimo-ai`, package dir is still `packages/opencode`). The memory system lives almost entirely in directories that exist in MiMo-Code but NOT in upstream OpenCode: `src/memory/`, `src/history/`, `src/task/`, `src/actor/`, plus heavy additions to `src/session/` (`checkpoint*.ts`, `auto-dream.ts`, `prune.ts`, `budgeted-read.ts`) and `src/tool/` (`memory.ts`, `history.ts`, `memory-path-guard.ts`).

---

## 1. Conceptual framing (from blog)

Three time scales — "computation, memory, evolution":

> "The most prominent bottlenecks vary across different time scales: the quality of single-turn decisions within a session is mainly constrained by **computation**; the continuity of multi-turn tasks within a session is mainly constrained by **state management**; and improvement across sessions is mainly constrained by the **mechanism for distilling experience**."

- **Computation** = single-turn decision quality (model capability).
- **Memory** = multi-turn continuity within a session (checkpoint/rebuild machinery).
- **Evolution** = cross-session improvement (dream/distill consolidation).

Hierarchy principle (from blog): "the upper layers are more refined, more persistent, and smaller; the lower layers are more complete, larger, and slower."

Benchmark claims (from blog, NOT verified): MiMo Code + MiMo-V2.5-Pro beats Claude Code + Claude Sonnet 4.6 across three evaluations; human double-blind testing covered 576 developers, 474 private repos, 1,213 A/B pairs; win rate ~50% for tasks <200 steps, >65% for >200 steps. Rebuild injection budget "roughly 65K tokens total" (from blog; code section caps below sum to ~40K + tail of 10–20K, so ~50–60K is plausible — the 65K figure is **not found in code**).

## 2. The four memory layers

| Layer | Artifact | Scope / lifetime | Writer | Path |
|---|---|---|---|---|
| 1. Session memory | `checkpoint.md` (11 sections) + `notes.md` + `tasks/<TID>/progress.md` | one session | checkpoint-writer subagent (checkpoint.md, exclusive); main agent (notes.md append-only); subagents (their own tasks/<TID>/progress.md) | `<data>/memory/sessions/<sid>/` |
| 2. Project memory | `MEMORY.md` (4 sections) | all sessions in a project | checkpoint-writer + dream agent; main agent may Edit for explicit user rules | `<data>/memory/projects/<pid>/MEMORY.md` |
| 3. Global memory | `MEMORY.md` | all projects (user preferences) | dream agent promotes; "Read-only from the agent side; no auto-create" (checkpoint-paths.ts) | `<data>/memory/global/MEMORY.md` |
| 4. History | full raw trajectory (messages, parts/tool calls) in SQLite | forever, machine-wide | automatic (event-bus writer) | `<data>/mimocode.db` (`message`, `part` tables + `history_fts`) |

Layers 1–3 are **markdown files on disk**; SQLite FTS5 is a derived *index over those files* (reconciled lazily), not the storage. Layer 4 is SQLite-native. Blog calls layer 4 "stored without indexing", but the code DOES add an FTS index over it (`history_fts`, migration dated 2026-06-09 — added after the blog, presumably).

Confirmed scope/type taxonomy (`src/memory/paths.ts`):

```ts
export type Scope = "global" | "projects" | "sessions" | "cc"
export type MemoryType =
  | "free" | "memory" | "checkpoint" | "progress" | "notes"
  | "feedback" | "project" | "reference" | "user"   // last 4 are CC (Claude Code) types
```

Path layout: `<data>/memory/<scope>/<scope_id>/<key>.md`. Type is detected from the key by regex (`memory*` → memory, `checkpoint*` → checkpoint, `tasks/<id>/progress` → progress, `tasks/<id>/notes` → notes, else `free`). `resolveProjectId` = sha256(absRepoPath) truncated to 12 hex chars.

A fourth *scope* (`cc`) optionally indexes **Claude Code's** memory dir `~/.claude/projects/<slug>/memory/**/*.md` (config `memory.cc_index`, default false), deriving `type` from YAML frontmatter `metadata.type` (feedback/project/reference/user). Read-only.

## 3. SQLite schema (confirmed, verbatim)

DB location: `<data>/mimocode.db` where `<data>` = `$MIMOCODE_HOME/data` if `MIMOCODE_HOME` is set, else XDG (`~/.local/share/mimocode` on Linux, equivalent on macOS) — `packages/shared/src/global.ts`, `src/storage/db.ts`. Env override `MIMOCODE_DB` (absolute path, relative-to-data name, or `:memory:`). **One global DB for everything** (all projects); scoping is via columns, not separate DBs.

### 3.1 Memory FTS (final form: migrations `20260521010000_memory_fts_v6` + `20260521020000_memory_fts_triggers`)

```sql
CREATE TABLE `memory_fts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `path` text NOT NULL UNIQUE,
  `scope` text NOT NULL,
  `scope_id` text DEFAULT '' NOT NULL,
  `type` text NOT NULL,
  `body` text NOT NULL,
  `fingerprint` text NOT NULL,
  `last_indexed_at` integer NOT NULL
);
CREATE INDEX `memory_fts_scope_idx` ON `memory_fts` (`scope`, `scope_id`);
CREATE INDEX `memory_fts_type_idx` ON `memory_fts` (`type`);
CREATE VIRTUAL TABLE `memory_fts_idx` USING fts5(
  body,
  content='memory_fts',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER `memory_fts_ai` AFTER INSERT ON `memory_fts` BEGIN
  INSERT INTO `memory_fts_idx`(rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER `memory_fts_ad` AFTER DELETE ON `memory_fts` BEGIN
  INSERT INTO `memory_fts_idx`(`memory_fts_idx`, rowid, body) VALUES('delete', OLD.id, OLD.body);
END;
CREATE TRIGGER `memory_fts_au` AFTER UPDATE ON `memory_fts` BEGIN
  INSERT INTO `memory_fts_idx`(`memory_fts_idx`, rowid, body) VALUES('delete', OLD.id, OLD.body);
  INSERT INTO `memory_fts_idx`(rowid, body) VALUES (NEW.id, NEW.body);
END;
```

Implementation war story preserved in the trigger migration comment (worth copying for a re-implementation):

```sql
-- Fix v6.1 trigger pattern: external content FTS5 vtab requires the 'delete'
-- magic command to remove OLD body's tokens, NOT a plain DELETE FROM the vtab.
-- The previous DELETE FROM pattern was contentless-mode syntax misapplied to
-- external-content mode, leaving stale tokens accumulating until vtab corrupts.
```

(They also migrated from `path` as PK + `content_rowid='rowid'` to an explicit AUTOINCREMENT `id` PK for rowid stability — see `test/memory/fts-rowid-stability.test.ts`.)

`fingerprint` = `"${stat.size}-${stat.mtimeMs}"` — cheap change detection for reconcile.

### 3.2 History FTS (migration `20260609000000_history_fts`)

```sql
CREATE TABLE `history_fts` (
  `part_id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `message_id` text NOT NULL,
  `project_id` text NOT NULL,
  `kind` text NOT NULL,
  `tool_name` text,
  `body` text NOT NULL,
  `time_created` integer NOT NULL
);
CREATE INDEX `history_fts_session_idx` ON `history_fts` (`session_id`, `time_created`);
CREATE INDEX `history_fts_project_idx` ON `history_fts` (`project_id`, `time_created`);
CREATE INDEX `history_fts_message_idx` ON `history_fts` (`message_id`);
CREATE VIRTUAL TABLE `history_fts_idx` USING fts5(
  body,
  content='history_fts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);
-- ai/ad/au triggers identical in pattern to memory_fts (with the 'delete' command form)
```

`kind` ∈ `user_text | assistant_text | tool_input | tool_error | reasoning | tool_output` (`src/history/extract.ts`). Default indexed kinds: `["user_text","assistant_text","tool_input","tool_error"]` (reasoning and tool_output opt-in via `history.kinds` config; enabling `tool_output` reclassifies completed tools from `tool_input`).

Raw trajectory itself lives in OpenCode-inherited tables `session`, `message(id, session_id, agent_id, time_created, data JSON)`, `part(id, message_id, session_id, time_created, data JSON)`, plus MiMo-added `task`, `task_event`, `actor_registry` (the dream/distill prompts document these as their query surface).

## 4. Query path: FTS query building + ranking (confirmed)

`src/memory/fts-query.ts` — verbatim core:

```ts
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? []
  if (tokens.length === 0) return null
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`)
  return quoted.join(" OR ")
}
```

Rationale comments (verbatim, abridged): FTS5 MATCH grammar crashes on raw user punctuation; each alphanumeric run becomes a phrase-quoted literal. **OR-join, not AND**: "AND returned 0 results for nearly all multi-word queries... OR lets BM25 rank by how many / how rare the matched tokens are; the caller applies a score floor to drop common-word-only noise." `\p{L}` includes CJK. Note: `src/history/fts-query.ts` is an independent copy that uses **AND**-join ("Independent copy from memory/fts-query.ts so the two modules can evolve apart").

Memory search SQL (`src/memory/service.ts`):

```sql
SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type,
       snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
       bm25(memory_fts_idx) AS score
FROM memory_fts_idx
JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
WHERE memory_fts_idx MATCH ?
  -- optional: AND memory_fts.scope = ? AND memory_fts.scope_id = ? AND memory_fts.type = ?
ORDER BY score
LIMIT ?
```

Ranking mechanics (confirmed):
- Pure **BM25**, sign-flipped to higher-is-better. **No recency weighting, no decay** in scoring.
- **Relative score floor**: over-fetch `min(limit*3, 50)` rows, then keep row i if `i === 0 || score >= topScore * floorRatio` (default `floorRatio = 0.15`, config `checkpoint.memory_search_score_floor`, 0 disables). Comment: relative not absolute "because BM25 magnitudes are corpus-size-dependent — in a tiny corpus every score collapses toward 0 (low IDF)... The #1 result is ALWAYS kept."
- **Lazy reconcile before search** (config `checkpoint.memory_reconcile_on_search`, default true): walks the memory tree, re-indexes files whose size+mtime fingerprint changed, prunes rows whose file vanished (`src/memory/reconcile.ts`). This is how off-tool writes (the writer subagent writes plain files) become searchable without any explicit index API.

History search adds filters: `project_id` (default scope=project; scope=global removes it), `session_id`, `kind IN (...)`, `tool_name`, `time_after/time_before`; hard cap 50 results.

## 5. Write path / lifecycle hooks (confirmed)

### 5.1 During the agent loop (per iteration), `src/session/prompt.ts` + `src/session/prune.ts`

1. **History indexing is continuous**: `src/history/writer.ts` subscribes to the message-part event bus (`MessageV2.Event.PartUpdated` / `PartRemoved`) and upserts/deletes `history_fts` rows through an unbounded queue. `src/history/backfill.ts` runs at project bootstrap, fire-and-forget, newest-session-first, batches of 500, idempotent via `NOT EXISTS`.
2. **Checkpoint thresholds fire mid-turn**: at the START of each runLoop iteration, `prune.fireCheckpoints` compares the last assistant message's total tokens to threshold list. Defaults (`src/session/prune.ts: defaultThresholdsFor`):

```
< 25K window          → []  (subsystem disabled)
25K ≤ w ≤ 200K        → ["20%", "40%", "60%", "80%"]
200K < w ≤ 500K       → ["10%" ... "90%"]   (every 10%)
w > 500K              → every 5% (18 triggers)
```

   (Blog says "approximately 20%, 45%, and 70%" — the shipped defaults differ; treat blog numbers as an earlier iteration.) Config: `checkpoint.thresholds` (strings: `"40%"`, `"100K"`, `"1.5M"`), `checkpoint.reserved` (default 13_000 in code constant `CHECKPOINT_RESERVED`; config doc says 20000 — code wins). Per-session `crossed` set prevents re-firing; one writer at a time per session with a 1-slot pending queue (newest evicts older — "its range is a strict superset"). Max 3 consecutive writer failures (`checkpoint.max_writer_failures`) then gives up until restart.
3. **Memory-flush nudge**: at context pressure ≥2 (>70%/>85%), a synthetic `<system-reminder>` part is appended to the last user message: "Context is filling up... If you have important learnings or decisions from this session, consider writing them to memory now before context may be reset."
4. **Recall reminder**: if the session has any memory artifacts or tasks, a ~120-token per-turn reminder points at `<data>/memory/sessions/<sid>/` and says "Don't ask the user about something memory may already record."
5. **Main agent writes during the turn**: only (a) appends to `notes.md` (format `## [turn N · ISO-8601Z]` + free body), (b) Edits to `MEMORY.md` for explicit user rules/decisions (taught by system prompt, see §7), enforced by `src/tool/memory-path-guard.ts` (`assertMemoryWriteAllowed`) which rejects everything else under the memory root (e.g. `learning.md`, `scratch.md`, other sessions' files; task subagents may write only their own `tasks/<TID>/` subtree via `taskId` binding).

### 5.2 Checkpoint write (the writer subagent), `src/session/checkpoint.ts`

`tryStartCheckpointWriter`:
- Computes a token-budgeted boundary (`computeBoundary`): preserve a tail of 10K–20K tokens / ≥5 text-block messages; everything before the boundary will be summarized into checkpoint.md and dropped from the live context at the next rebuild. Boundary is adjusted to never split tool_use/tool_result pairs or thinking blocks (`adjustBoundaryForApiInvariants`).
- Ensures `checkpoint.md` / `MEMORY.md` / `notes.md` exist from templates (§6).
- Spawns agent `checkpoint-writer` (`native: true, hidden: true, mode: "subagent"`) in a **fresh child session**, `background: true`, runtime tool whitelist `["read","write","edit","apply_patch","glob","grep","task"]`. Two context modes (config `checkpoint.fork`, default **false**): fork=true forks the parent's full prompt prefix for prefix-cache reuse; fork=false cold-starts with only the **delta** of messages since `last_checkpoint_message_id` (column on `session` table, migration `20260519000000`).
- The prompt = `<system-reminder>` wrapper pinning ABSOLUTE PATHS (CHECKPOINT_PATH / MEMORY_PATH / TASK_MEM_DIR / NOTES_PATH — "USE THESE VERBATIM. NEVER COMPUTE, INFER, OR MODIFY") + a SUBAGENT PROGRESS diff block (`buildProgressDiff`) + the checkpoint-writer prompt (§8.1) with `{{SECTION_BUDGETS}}` substituted.
- On settle, `last_checkpoint_message_id` advances; pending queued request fires.
- Validation/retry: an `actor.preStop` plugin hook (`src/plugin/checkpoint-splitover.ts`) runs validators (`checkpoint-validator.ts`: topic format, required sections present and ordered, no duplicate "Discovered" titles, section token budgets via `section-budget-exceeded`, etc.); on violation the writer is forced to continue with a reflection message instead of stopping (severities: warn / error / extract-required, the last forcing spillover extraction).
- Subagents get a parallel mechanism: `actor.postStop` hook (`src/plugin/subagent-progress-checker.ts`) blocks a task-bound subagent from terminating until it writes `tasks/<TID>/progress.md` with 5 exact sections (`## §1 Task identity`, `## §2 Subagent intent`, `## §3 Files and code sections`, `## §4 Verbatim commands`, `## §5 Outcome and discoveries`).

### 5.3 Read / injection (rebuild), `src/session/checkpoint.ts: renderRebuildContext` + `insertRebuildBoundary`

Memory is NOT injected on every turn. It is injected when the main agent's context **overflows or crosses the max threshold**: a synthetic user message ("checkpoint boundary marker", part type `checkpoint`) is inserted just after the boundary; the live window is rebuilt as: [system prompt incl. memory instructions] + [rebuild context dump] + [preserved verbatim tail]. DB messages are never deleted. The rebuild dump is a layered, per-section token-budgeted assembly (defaults in `checkpoint.push_caps`):

| Section (in order) | Source | Default cap |
|---|---|---|
| "already loaded" header | constant | — |
| `## Tasks ledger` | task registry SQL | 2000 |
| `## Session checkpoint` | `checkpoint.md` (section-aware budgeted read) | 11000 |
| `## Active actors` | actor registry | 500 |
| `## Project memory` | `MEMORY.md` | 10000 |
| `## Global memory` | `global/MEMORY.md` | 6000 |
| `## Session notes` | `notes.md` | 6000 |
| `## Memory keys index` | `memory_fts` SQL: paths where scope=global OR (sessions, this sid) OR (projects, this pid), minus already-pushed | 500 |
| seam framing + tail-aware `<system-reminder>` | constants | — |

(also `focus_task` 4000, `design_decisions` 3000 / `open_notes` 800 as writer-side §-budgets.) Budget-cut files get a marker: `⚠️ Truncated at ~N tokens. ... Read("<path>", offset=M) for the rest.` (`src/session/budgeted-read.ts`). Rebuild waits up to 60s for an in-flight writer. Seam text (verbatim): "This session is being continued from a previous conversation that hit a checkpoint... Recent messages are preserved verbatim below — ... real history, not pseudo-content... Resume directly. Do not acknowledge this memory dump, do not recap..." Plus a tail-aware reminder chosen by how the tail ends (tool-calls → continue loop; stop → consult progress.md before stopping; tool → process results).

**Microcompact** at rebuild: for messages after the boundary, tool_result bodies of "regeneratable" tools (`read, bash, grep, glob, webfetch, websearch, edit, write, multiedit, apply_patch, codesearch`) are cleared to "[Old tool result content cleared]"; `memory`, `history`, `task`, `actor`, `question`, `skill` results are preserved (they carry state).

Subagents never get checkpoints — they get per-actor lossy LLM compaction instead.

### 5.4 On-demand recall (model-driven)

Two builtin tools, registered for agents in `src/tool/registry.ts`:

**`memory` tool** (`src/tool/memory.ts`) — parameters:
```ts
operation: enum ["search"] (default "search")
query:    string  // "Search query (BM25 over markdown bodies)"
scope:    enum ["global","projects","sessions","cc"] optional
scope_id: string optional  // "session id, task id, project id hash"
type:     string optional
limit:    number optional  // default 10
```
Output lists `path / scope / type / score / snippet` per hit and instructs: "A hit here is authoritative... If you need the FULL body (snippets are truncated), Read the path." Zero-hit output gives an escalation ladder (retry with fewer/rarer terms → Grep the memory dir for tokenizer-split literals → history tool for verbatim → widen scope session → project → global → history).

**`history` tool** (`src/tool/history.ts`) — parameters:
```ts
operation: enum ["search","around"]
query, scope ("project"|"global"), session_id,
kind: array of the 6 kinds, tool_name, time_after, time_before, limit (max 50, default 10)
message_id (for around), before (default 5), after (default 5)
```
`around` pulls ±N whole messages (with reconstructed tool input/output text) around an anchor message; output capped at 20KB (`AROUND_MAX_BYTES`), overflow spills to a file. Description (verbatim header): "Search RAW conversation trajectory... USE ONLY WHEN MEMORY SEARCH RETURNS NOTHING USEFUL. memory is your curated notebook — small, fast, semantically organized. ALWAYS try `memory` first. history is the unindexed firehose of your past sessions..."

There is **no memory-write tool**: writes go through ordinary `write`/`edit` file tools constrained by the path guard, and indexing happens by reconcile.

## 6. File templates (confirmed verbatim, `src/session/checkpoint-templates.ts`)

`checkpoint.md` — 11 sections, each `## §N <title>` followed by an italic `_instruction_` line the writer must never modify, body starts as `(none yet)`:
§1 Active intent (verbatim block-quoted user request — "ground truth... do not paraphrase"), §2 Next concrete action, §3 Directives (this session), §4 Task tree, §5 Current work, §6 Files and code sections, §7 Discovered knowledge (cross-task), §8 Errors and fixes, §9 Live resources, §10 Design decisions and discussion outcomes, §11 Open notes.

`MEMORY.md` — 4 sections: `## Project context`, `## Rules`, `## Architecture decisions`, `## Discovered durable knowledge` (dream may add `## Patterns`, `## Gotchas`).

`notes.md` template (verbatim): `# Session notes` + italic instruction: "_Free-form scratchpad for the main agent. Append entries as you go; the checkpoint writer reconciles them at checkpoint events. Format each entry as `## [turn N · YYYY-MM-DDTHH:MM:SSZ]` ... if you've already noted substantially similar content, add a short `(see entry above)` reference instead of duplicating._"

Section token budgets (`CHECKPOINT_SECTION_BUDGETS`, total ~11K): §1:500, §2:1000, §3:800, §4:1000, §5:2000, §6:1500, §7:2000, §8:1500, §9:1000, §10:3000, §11:800. `MEMORY_SECTION_BUDGETS` (total ~10K): context 1000, rules 2000, architecture 3000, discovered 4000.

## 7. System-prompt memory instructions (confirmed verbatim, `src/session/llm.ts: buildMemoryInstructions`)

Appended to the main agent's system prompt every session (skipped for system-spawned actors). Full text:

```
# Memory system

You have a persistent file-based memory system. Four file types:

- Project memory at `<root>/projects/<pid>/MEMORY.md` — persistent across all sessions in this project. Contains: project context, rules, architecture decisions, durable cross-task knowledge.
- Session checkpoint at `<root>/sessions/<sid>/checkpoint.md` — current session's structured state, written ONLY by the checkpoint-writer subagent. 11 sections covering active intent, next action, directives, task tree, current work, files, learnings, errors, live resources, design decisions, and open notes. Task content lives inside §4 Task tree and §5 Current work.
- Per-task progress at `<root>/sessions/<sid>/tasks/<id>/progress.md` — writer-derived splitover from session-level progress.md (not LLM-written). When you spawn a subagent on a task, the subagent may be handed this path for reading; you do not maintain it.
- Global memory at `<root>/global/MEMORY.md` — user-level preferences and cross-project feedback that persist across all projects. Auto-injected into rebuild context under the "## Global memory" header when present.

The checkpoint writer is the sole curator of the structured files. You don't maintain them mid-task — the writer extracts everything from the conversation at checkpoint events.

## When to Edit MEMORY.md directly

You may Edit MEMORY.md when:
- User states a project-level rule that should hold across sessions → ## Rules
- User states a project-level architectural decision → ## Architecture decisions
- A clearly durable cross-session fact emerges that you want available immediately, before the next checkpoint → ## Discovered durable knowledge

These are exceptions, not the norm. The writer covers most extraction at checkpoint time.

## Notes scratchpad

You have a single legal scratchpad at `<root>/sessions/<sid>/notes.md`. Append entries to it when you want to record:

- A quote (from the user, an article, a known engineer) that has lasting value but isn't a task-specific decision
- An unresolved question — something you noticed but won't answer this turn
- A cross-project observation — "we did this in project X, similar pattern here"
- A note for future-self — context that would matter weeks later but doesn't fit any current task

Format each entry as:
  ## [turn N · YYYY-MM-DDTHH:MM:SSZ]
  Free-form body. The writer reorganizes structured content at checkpoint time.

This is your ONLY legal scratchpad — don't create `learning.md`, `scratch.md`, or any other ad-hoc memory file.

## Subagent return format

When you (as a subagent) finish your task, your final assistant message will be delivered to the spawning agent. If the spawn machinery added a "Return format (required)" section to your prompt, follow it exactly:

  **Status**: success | partial | failed | blocked
  **Summary**: <one-line description>

  <deliverable body>

  **Files touched**: <comma-separated paths or "(none)">
  **Findings worth promoting**: <bullet list, or "(none)">

If your spawn prompt didn't include this format (e.g., explore/title/summary agents have their own contracts), follow whatever your prompt specifies.

## What NOT to do

- Don't Edit checkpoint.md — that's the writer's domain.
- Don't create memory files other than notes.md (no learning.md, no scratch.md). Use notes.md for any free-form entry.
- Don't ask the user about something memory may already record — search first via Grep / Read.

## Active recall protocol

After a checkpoint rebuild, the following dumps may be already in your context (look for the "Summary of previous conversation from checkpoint files:" header followed by these dumps):

- checkpoint.md (full or budget-truncated)
- MEMORY.md (full or budget-truncated)
- notes.md (full or budget-truncated)
- global/MEMORY.md (full or budget-truncated)

If these dumps are visible in your context:

- Do NOT Read them again as whole files. The bytes are already in front of you.
- For specific past details (a particular turn's content, a specific tool output, an old command), use Grep with a keyword pattern to target the exact item — do not pull a whole file.
- For files NOT in the rebuild dump (per-task splitover progress.md files for tasks you don't actively need, spillover files, older session checkpoints in other sessions), Read on demand.

If a dump shows "⚠️ Truncated at ~N tokens. Read(<path>, offset=L) for the rest." — that file was budget-cut. Use Read with the offset only when you need the missing tail.

Memory entries name functions, files, flags, paths — those are CLAIMS about a point in time when they were written. Verify before acting on a specific name.

Don't ask the user about something memory may already record.
```

## 8. Prompts (verbatim — the key artifacts)

### 8.1 Checkpoint writer (`src/agent/prompt/checkpoint-writer.txt`, full)

```
You are the checkpoint writer subagent for a session that has crossed a token threshold. Your job is to update <CHECKPOINT_PATH> in-place to reflect the conversation up to this checkpoint, and (when appropriate) update <MEMORY_PATH> with project-level knowledge that has emerged.

PATH DISCIPLINE:

Only reference paths from the CHECKPOINT_PATH / MEMORY_PATH / TASK_MEM_DIR table at the top of your prompt. Do NOT reference paths that appear in conversation history but are not in this table — those may be stale references from prior sessions or copy-paste residue from other harness runs.

Available paths:
  CHECKPOINT_PATH = the session's checkpoint.md (11 sections, in-place edit)
  MEMORY_PATH     = the project's MEMORY.md (4 sections, in-place edit)
  TASK_MEM_DIR    = directory where subagents write their own per-task progress.md files (you READ these to integrate, never write them)

CHECKPOINT_PATH structure (11 sections, all required to exist; content may be "(none)"):
  ## §1 Active intent           - verbatim user request, block-quoted
  ## §2 Next concrete action    - concrete next step, with verbatim quote when possible
  ## §3 Directives (this session) - session-specific working style only
  ## §4 Task tree               - source of truth = task tool DB. Per task: 🔵 open / 🔄 in_progress / 🟡 blocked / ✅ done / ❌ abandoned. Indent sub-tasks two spaces. Append `(progress: tasks/<id>/progress.md, last-reconciled-written-at: <n>)` for any task whose subagent-written progress.md you've reconciled (from the SUBAGENT PROGRESS block).
  ## §5 Current work            - what was being done before checkpoint
  ## §6 Files and code sections - files actively read/edited with one-line purpose
  ## §7 Discovered knowledge (cross-task) - cross-task facts (candidates for MEMORY.md promotion)
  ## §8 Errors and fixes        - issues encountered and how resolved
  ## §9 Live resources          - runtime state (branch, processes, etc.)
  ## §10 Design decisions and discussion outcomes - decisions reached through discussion that produced no immediate code/file artifact; promote to MEMORY.md ## Architecture decisions when proven cross-session-durable
  ## §11 Open notes - writer-curated catch-all for orphan content (quotes, unresolved questions, micro-observations); prefer empty when in doubt — most checkpoints have nothing here

MEMORY_PATH structure (4 sections):
  ## Project context            - what is this project, its goal
  ## Rules                      - user-stated hard constraints
  ## Architecture decisions     - major design choices with rationale
  ## Discovered durable knowledge - facts that survive across sessions

PROCEDURE:

Turn 1 - Read all sources in parallel:
  Read CHECKPOINT_PATH
  Read MEMORY_PATH
  Read NOTES_PATH (file may not exist for v8.1-era sessions; treat as empty if so)
  (also Read any spillover files referenced in either main file's index lines)

Turn 2a - Reconcile pass (read sources, decide migrations, then plan Edits):

For content gathered from BOTH the main session conversation tail AND the entries in NOTES_PATH:
  - Working-style preference / directive → §3 (session) or MEMORY.md ## Rules (project-durable)
    Examples: "always use snake_case for fields"; "no try/catch — early-return"; "prefer functional array methods over for-loops"
  - Cross-task transferable fact → §7 (session candidate) or MEMORY.md ## Discovered (project-durable)
    Examples: "left-recursive grammars need Pratt parsing"; "Bun's Read has no native tail-N"; "tool X errors on input Y because of Z"; "architectural invariant: A implies B"
  - Bug + fix → §8 Errors and fixes
    Examples: "X crashed at line N because Y; fixed by Z"
  - Design decision / discussion outcome → §10 Design decisions
    Examples: "decided to use SSA over three-address form because…"; "rejected closure conversion for v0.1 because…"
  - Code/file ops → §6 Files and code sections
    Examples: "src/lexer.ts is the source of truth for token kinds"; "passes/cse.ts implements intra-block GVN"
  - Quote, unresolved question, side observation → §11 Open notes
    Examples: user-quoted reactions; deferred-to-v0.2 questions; "this reminds me of project X"
  - EXACT-FORM CONSTRAINT LITERAL (the user gave a precise value the agent must reproduce later) → §3 Directives (session) or MEMORY.md ## Rules, COPIED VERBATIM, never paraphrased.
    This covers: connection strings / DSNs, ports, hostnames, env var values, API tokens/keys, file paths, full command lines + their flags, IDs, seeds, version pins.
    Examples: `MC_DB_DSN=postgres://mc_ro@host:5433/exp_2026`; `--seed 2718281 --shard 1/3`; `/data/runs/2026-06-09/.../output.tsv`; `HF_TOKEN=hf_xxx`.
    Rule: preserve the literal byte-for-byte (backticks, punctuation, both ports when two DSNs differ only by port). Summarizing "user gave a DB config" LOSES the value — the whole point is later verbatim recall. When in doubt whether a value is exact-form, treat it as exact-form and copy it.
  - Decide each fragment's destination by content type

After deciding destinations, apply your judgment to every entry — even low-confidence ones. notes.md will be truncated to NOTES_TEMPLATE in the Turn 2 Edit pass; un-migrated content stays accessible via the conversation tail and can be re-routed at the next writer fire if it resurfaces.

For §3 Directives in checkpoint.md, scan content:
  - If a line matches `D\d+:` AND the same rule exists in MEMORY.md ## Rules,
    DELETE the §3 line (MEMORY.md is canonical, no need to duplicate)
  - If a line uses status language (X COMPLETE / X done / X partially complete),
    move that line's content into §5 Current work
  - Lines that are genuine session-only working preferences stay in §3

For §4 Task tree, pull from the task tool only:
  1. Call `task` tool with operation="list" — this is the authoritative source of truth (done/blocked/open/abandoned).

  Render: parent task with task-tool status icon (🔵 open / 🔄 in_progress / 🟡 blocked / ✅ done / ❌ abandoned), use task summary for one-line body. Indent sub-tasks two spaces. Suffix the line as follows:
    - If the SUBAGENT PROGRESS block listed this task as NEW or CHANGED: `(progress: tasks/<id>/progress.md, last-reconciled-written-at: <the written-at from the block>)`
    - If this task already has a `last-reconciled-written-at: <n>` marker on its previous-checkpoint line AND was NOT in the SUBAGENT PROGRESS block: preserve that previous marker line verbatim.
    - Otherwise: no suffix.

  HARD CONSTRAINT: Do NOT include any task ID or status that doesn't appear in the `task` tool's response. If a section is empty, render it empty — never invent.

  NAMING RULE: Use ONLY the IDs returned by `task` tool. Put the human-friendly description from the task's `summary` in the body. If the agent's conversation refers to a task by a logical label (e.g., "T6.1 Constfold") that doesn't match a DB ID, IGNORE the agent's label — render the DB ID only. Never write `T6.1 (T7)` or `T7 — T6.1`. One canonical name per line.

(Then proceed to Turn 2 final Edit pass.)

Turn 2 - Issue Edits in parallel (single message), then stop:
  For checkpoint.md:
    For each of §1..§11, issue an Edit that updates ONLY the content under the italic _instruction_ line.
    NEVER modify "## §N <title>" headers.
    NEVER modify "_..._" italic instruction lines.
    Update the body text below each instruction.
  For MEMORY.md (only when warranted):
    Append entries to ## Rules / ## Architecture decisions / ## Discovered durable knowledge as you reconcile §3 and §7.
  For task content in main progress.md:

    Maintain task narrative as sub-sections inside the session-level progress.md
    you write. Organize by task ID (e.g., `### T1: <summary>` then a brief
    narrative of what's been done, blockers, decisions). The main agent's own
    tasks live ONLY as these sub-sections — there is no separate per-task file
    for them, and nothing derives one.

    DO NOT WRITE to tasks/<id>/progress.md from this prompt. Those files are
    written SOLELY by subagents about their own delegated work (the postStop
    hook ensures a subagent records its task there before terminating). Your job
    is to READ a subagent's tasks/<id>/progress.md when the SUBAGENT PROGRESS to
    integrate block above lists it, and EXTRACT its content up into your main
    progress.md. When integrating:
      - §4 (verbatim commands) from progress.md MUST be copied VERBATIM into main
        §5 Current work or §7 Discovered knowledge as appropriate (preserve
        backticks, exact tokens — that verbatim is the H6 driver).
      - §5 (outcome and discoveries) from progress.md integrate as condensed
        bullets in main §5 or §7.
      - After integration, update the matching main §4 task line to:
        🔵 <TID> <summary> (progress: tasks/<TID>/progress.md, last-reconciled-written-at: <written-at from the diff block>)
      - When no SUBAGENT PROGRESS block is present, do not read any tasks/*/progress.md
        on your own — there is nothing new to reconcile.
  For notes.md: Use Write tool to overwrite notes.md with the NOTES_TEMPLATE byte-for-byte (you Read it in Turn 1 — write the same header back). Rationale: every entry in notes.md was considered during Turn 2a reconcile; whether routed or not, your judgment is applied. Agent re-appends fresh entries in subsequent turns. Do NOT use Edit — use Write with the full template body. Do not invent template text — use what you Read in Turn 1 verbatim.

CRITICAL CONSTRAINTS:

1. §1 Active intent MUST contain at least one block-quoted verbatim user request:
   > "<exact user words>"

   This is the anchor. Without verbatim, the next-cycle agent will lose the user's actual words and may drift.

1.5. §1 Active intent — when to update vs preserve:

   Update §1 ONLY when the user's most recent prompt is COMMITMENT-style:
   - Verbs: implement, write, build, fix, run, create, refactor, add, remove, update, design, debug
   - Implies a new deliverable or work to do

   KEEP existing §1 unchanged when the user's prompt is INSPECTION-style:
   - Verbs: find, list, show, print, inspect, tell, describe, explain, what is, why, how does
   - Pure queries, no new commitment
   - Examples: "list every file matching X", "tell me the count", "show me the diff", "what does this mean"

   When unsure, default to KEEP. A stale §1 is recoverable; a wrong §1 erases user intent.

2. §2 Next concrete action SHOULD include a verbatim quote when the user explicitly stated a next step. Format:
   <description of action>
   > "<verbatim quote>"

3. §3 Directives is for THIS SESSION only. Project-wide rules (D1-D12-style) belong in MEMORY_PATH ## Rules - do not duplicate them in §3.

4. §7 Discovered knowledge is for cross-task session-level findings. If something is durable enough to outlive the session (e.g., a confirmed architecture invariant), ALSO append it to MEMORY_PATH ## Discovered durable knowledge.

5. {{SECTION_BUDGETS}}

   If a section is approaching budget, EXTRACT a coherent topic to <sid>/checkpoint-<topic>.md and replace the extracted lines in the main section with:

   - See checkpoint-<topic>.md (N items) - <one-line summary>

   The index line is preserved across all rebuilds; do not nest spillovers (don't spill from a spillover).

6. Do not call Read on source files (no /tmp/.../src/lexer.ts type reads). The conversation already contains everything you need. Reading source files wastes turns.

7. Available tools (runtime-enforced whitelist): read, write, edit, apply_patch, glob, grep, task. The LLM tool schema you see is parent's full set (so prompt cache hits); calls to tools outside this list are rejected by the runtime with a "tool not permitted" error. Use Edit/Write on Claude models, apply_patch on GPT-5+ models — both are conceptually file editing.

8. After turn 2's Edits, your response is complete. Do not summarize what you wrote.

EDGE CASES:

- If §1 already has a block-quoted user request that's still valid (user hasn't issued a new request since), keep it. Don't replace with a stale paraphrase.

- If a section legitimately has nothing to report (e.g., §8 with no errors this checkpoint), keep "(none)" or a neutral placeholder. Don't fabricate content.

- If a verbatim user request is very long (>200 chars), truncate with "..." and provide a brief paraphrase BELOW the quote:
  > "<first 200 chars>..."

  (Paraphrased: <short summary>)
```

### 8.2 Dream — weekly memory consolidation (`src/agent/prompt/dream.txt`, full)

```
# Dream: Memory Consolidation

You consolidate durable project memory from two sources:

1. Memory files under the data directory's memory tree.
2. Raw mimocode trajectory in the local SQLite database.

Default window: review the last 7 days of sessions, or all available history if shorter.

This command is manual. The user intentionally started it and is watching.
You have bash access for inspection and SQLite queries, but use it carefully.

## Data Source

Trajectory database: `<DATA>/mimocode.db` (SQLite, read-only)
Memory files root: `<DATA>/memory/`

## Ground Rules

- Raw trajectory is authoritative; memory files are a structured index/cache.
- Prefer read-only bash commands for discovery and SQLite queries.
- Do not modify the SQLite database or raw trajectory.
- Write final durable knowledge only to project memory files unless the task explicitly requires cleaning current session notes.
- Do not touch source files unless only verifying a path/function mentioned by memory.
- Keep the memory folder compact and high-signal. Information density matters more than completeness.
- Reuse existing memories instead of duplicating them. Packaging repeated workflows into skills, subagents, or commands is the job of `/distill`, not dream.
- `global/MEMORY.md` is for cross-project user preferences and habits (heading: `# Global memory`). Prefer the project's MEMORY.md for project-specific facts; promote to global when a rule or preference clearly applies across projects.

## Phase 0 - Locate Data

1. Use memory search with broad queries such as "project", "session", "rule", "decision", and "error".
2. Use Glob/Read to inspect the memory paths from the system memory instructions.
3. Use bash to locate the database:
   - Infer `<DATA>/mimocode.db` from the resolved memory root.
   - If `MIMOCODE_DB` is visible in the shell environment, account for its override behavior.
   - Treat the resolved database path as read-only.
4. If memory is empty and the database has no current project sessions, report "Nothing to consolidate - memory is empty" and stop.

## Phase 1 - Orient

- Read the current project's `MEMORY.md`.
- Read current session `notes.md` if it exists.
- Glob `memory/sessions/*/checkpoint.md` and identify recent checkpoints.
- Use bash/SQLite to list recent sessions for this project from `session`, newest first.
- Record the current `MEMORY.md` section structure before editing to avoid duplicates.

## Phase 2 - Gather From Memory Files

Extract candidate durable facts from recent memory artifacts:

1. Recent `checkpoint.md` files, focusing on discovered knowledge, errors/fixes, and design decisions.
2. `tasks/*/progress.md` when checkpoint content points to durable task history.
3. `notes.md` entries not already represented in project memory.

Do not read every file exhaustively. Prefer recent and repeated signals.

## Phase 3 - Verify Against Raw Trajectory

Use bash with SQLite read-only queries to check candidate facts against raw trajectory:

- `session`: project/session/directory/title/time metadata.
- `message`: user and assistant turns.
- `part`: text parts, tool calls, tool results, checkpoint parts.
- `task` and `task_event`: task state and progress events.
- `actor_registry`: subagent/background actor history.

Schema notes:

- `message(id, session_id, agent_id, time_created, data JSON with $.role)`
- `part(id, message_id, session_id, time_created, data JSON)`
- Each assistant turn can produce multiple `part` rows.
- Part types include:
  - `{"type":"text","text":"..."}` - agent text output.
  - `{"type":"tool","tool":"...","state":{"input":...,"output":...}}` - tool call and result.
  - `{"type":"step-start"}` / `{"type":"step-finish","tokens":...}` - step boundaries and token stats.
- Empty `agent_id` means main agent; non-empty `agent_id` means subagent.

Query template for a session's assistant tool execution chain:

```sql
SELECT m.id, m.agent_id,
       json_extract(p.data, '$.type') as part_type,
       json_extract(p.data, '$.tool') as tool,
       substr(p.data, 1, 800) as preview
FROM message m
JOIN part p ON p.message_id = m.id
WHERE m.session_id = '<SESSION_ID>'
  AND json_extract(m.data, '$.role') = 'assistant'
ORDER BY m.time_created, p.time_created;
```

Useful searches include user statements containing English keywords like:

- "always", "never", "remember", "rule"
- "decision", "decided", "tradeoff", "reason"
- "repeat", "again", "every time", "workflow"

Also search equivalent keywords in the user's language when the trajectory shows the user working in another language.
Also search for repeated error text, failed commands, and recurring file paths.

Promote a fact only when supported by an explicit user statement, a clear design decision, or repeated evidence across sessions.

Drill into full trajectories when:

- A session produced code files or architecture decisions but memory lacks detail; inspect write/edit tool calls.
- A session involved debugging and gotchas may need promotion; inspect bash tool output for errors.
- `agent_id` is non-empty; group by `agent_id` to inspect each subagent execution chain.
- A session has many turns, for example more than 10 assistant messages, but memory only has a short summary.

## Workflow Packaging

If you notice a repeated manual workflow worth packaging, leave it to the
`/distill` command, which is dedicated to that. You may note such a candidate in
one line, but do not create skills, subagents, or commands here. Stay focused on
memory consolidation.

## Phase 4 - Consolidate

Edit the current project's `MEMORY.md` using these sections when useful:

- `## Rules` - project-level rules explicitly stated by the user.
- `## Architecture decisions` - decision + absolute date + rationale.
- `## Discovered durable knowledge` - cross-session durable facts.
- `## Patterns` - repeated problems and solutions.
- `## Gotchas` - easy-to-miss traps.

Principles:

- Merge duplicates instead of appending.
- Convert relative dates like "yesterday" to YYYY-MM-DD.
- Remove contradicted or obsolete entries when newer trajectory or code proves them stale.
- Keep each entry to 1-3 lines.
- Preserve source session ids at the end of entries, for example `[ses_xxx]`.

## Phase 5 - Prune And Verify

- Keep `MEMORY.md` under 200 lines and 10KB when possible. Prefer fewer, denser entries over exhaustive notes.
- Remove entries superseded by newer decisions.
- Remove details that mattered only to one session.
- Remove low-signal memory files or entries that are redundant with stronger project memory.
- Clear current `notes.md` entries only when fully integrated.
- Verify mentioned file paths with Glob.
- Verify mentioned function/class names with Grep.
- Mark unverifiable-but-plausible claims `[unverified]`.

## Output Format

Return a brief summary:

- Consolidated: new memory entries added.
- Updated: existing entries changed.
- Deleted: stale entries removed.
- Skipped: reason if no changes were made.
- Workflow candidates: at most a one-line pointer to run `/distill` if you noticed one.
- Health: project memory line count / 200 and size / 10KB.
```

### 8.3 Distill — monthly workflow packaging (`src/agent/prompt/distill.txt`, abridged headers; full text is in the cloned repo)

Full prompt structure (verbatim section headers and key rules):

```
# Distill: Workflow Packaging

You look back over recent work, identify repeated manual workflows worth
packaging, and turn only the high-confidence ones into reusable assets:
skills, custom subagents, commands, or recurring playbooks.

Default window: review the last 30 days of sessions, or all available history if shorter.
...
## Ground Rules
- Raw trajectory is authoritative; memory files are a structured index/cache.
- ...
- If nothing has actually been repeated, create nothing. Doing zero packaging is
  a valid and expected outcome; just say so in the summary rather than
  manufacturing an asset to justify the run.

## Phase 0 - Locate Data          (memory search: "workflow","repeat","every time","rule","decision")
## Phase 1 - Inventory Existing Assets   (Glob {skill,skills}/**/SKILL.md, {command,commands}/**/*.md,
                                          {agent,agents}/**/*.md under .mimocode/ and home external dirs
                                          .claude/.agents/.codex/.opencode — reuse/extend, don't duplicate)
## Phase 2 - Discover Repeated Workflows From Memory   (checkpoint.md, tasks/*/progress.md, notes.md, MEMORY.md ## Patterns / ## Rules)
## Phase 3 - Confirm Against Raw Trajectory
   Query template to find repeated tool/command usage across recent sessions:
   SELECT json_extract(p.data, '$.tool') as tool,
          substr(json_extract(p.data, '$.state.input'), 1, 200) as input_preview,
          count(*) as n
   FROM message m JOIN part p ON p.message_id = m.id
   WHERE json_extract(m.data, '$.role') = 'assistant'
     AND json_extract(p.data, '$.type') = 'tool'
     AND m.time_created > <CUTOFF_MS>
   GROUP BY tool, input_preview ORDER BY n DESC LIMIT 50;
   "A candidate is only real when it occurred at least twice, or is clearly likely to recur and costly to repeat."
## Phase 4 - Shortlist        (workflow / evidence + dates [ses_xxx] / frequency-confidence / recommended form / why)
## Phase 5 - Choose The Smallest Form   (Skill → .mimocode/skills/<name>/SKILL.md; Subagent → .mimocode/agent/<name>.md;
                                          Command → .mimocode/command/<name>.md with $ARGUMENTS; Automation → command or
                                          plugin hook, "Do not invent a scheduler"; Extend existing; Skip)
## Phase 6 - Create And Validate   (project .mimocode/ unless global; verify paths with Glob, names with Grep;
                                    no irreversible external actions)
## Output Format   (Shortlist / Created or extended / Skipped / Needs more evidence;
                    "Created nothing - no repeated workflow worth packaging" is a complete, successful result)
```

## 9. Evolution mechanics (confirmed)

- **Dream** (auto, default ON, every ≥7 days — `dream.auto`, `dream.interval_days`) and **Distill** (auto, default ON, every ≥30 days — `distill.*`) are spawned at step 1 of the first prompt of a new top-level session (`src/session/prompt.ts` ~2255), each in its own fresh session titled `"Auto Dream"` / `"Auto Distill"` (the last-run timestamp is recovered by querying the `session` table for that title — no extra state). Skipped if the project is younger than the interval. Both also exist as manual `/dream` and `/distill` commands (`src/command/index.ts`). Agent definitions (`src/agent/agent.ts`): `native: true, hidden: true, mode: subagent`, tool allowlist `[read, write, edit, glob, grep, memory, bash]`, with `external_directory` permission for `<data>/memory/**`.
- **Dedup/merge**: dream's Phase 4 "Merge duplicates instead of appending"; writer prompt dedups §3 directives against MEMORY.md ## Rules (MEMORY.md canonical).
- **Promotion between layers**: notes.md → checkpoint §§ / MEMORY.md (writer, every checkpoint); checkpoint §7/§10 → MEMORY.md ## Discovered / ## Architecture decisions "when proven cross-session-durable" (writer + dream); project MEMORY.md → global/MEMORY.md "when a rule or preference clearly applies across projects" (dream); repeated workflows → skills/agents/commands (distill).
- **Forgetting/decay**: no algorithmic decay. Forgetting is LLM-judged at dream time ("Remove contradicted or obsolete entries", "Remove details that mattered only to one session") plus hard size pressure: MEMORY.md target <200 lines / 10KB; per-section token budgets enforced by validators with spillover extraction to `checkpoint-<topic>.md` / `memory-<topic>.md` index lines. notes.md is wiped to template at every checkpoint (its content having been judged/routed). Raw history is never deleted ("Raw trajectory is authoritative; memory files are a structured index/cache").
- **Conflict resolution**: newest evidence wins (dream removes entries "when newer trajectory or code proves them stale"); recall side treats memory as "CLAIMS about a point in time... Verify before acting"; unverifiable claims marked `[unverified]`; entries carry source session ids `[ses_xxx]` and absolute dates.

## 10. Config surface (confirmed, `src/config/config.ts`)

```jsonc
{
  "checkpoint": {
    "thresholds": ["40%", "100K"],        // default: window-size-dependent (see §5.1)
    "reserved": 20000,                     // doc default 20000; code constant 13000
    "max_writer_failures": 3,
    "fork": false,                         // prefix-cache fork of parent into writer
    "push_caps": { "tasks_ledger": 2000, "focus_task": 4000, "actor_ledger": 500,
                   "memory_titles": 500, "global": 6000, "checkpoint": 11000,
                   "memory": 10000, "notes": 6000, "design_decisions": 3000, "open_notes": 800 },
    "task_archive_days": 7,
    "memory_reconcile_on_search": true,
    "memory_search_score_floor": 0.15
  },
  "memory":  { "cc_index": false },        // index ~/.claude/projects/*/memory as scope "cc"
  "history": { "kinds": ["user_text","assistant_text","tool_input","tool_error"] },
  "dream":   { "auto": true, "interval_days": 7 },
  "distill": { "auto": true, "interval_days": 30 }
}
```

Env vars: `MIMOCODE_HOME` (relocates all four base dirs: data/cache/config/state), `MIMOCODE_DB` (DB path override). Memory files: global, under `<data>/memory/` — per-project separation is by `projects/<pid>` subdir (pid = 12-hex sha256 of repo path), per-session by `sessions/<sid>`. The DB is global and shared across all projects/channels.

## 11. Re-implementation checklist for Pi (synthesis)

1. One SQLite DB (per-user), `unicode61 remove_diacritics 1` tokenizer, external-content FTS5 tables kept in sync by AFTER-triggers using the `('delete', rowid, body)` command form; integer AUTOINCREMENT PK as content_rowid.
2. Markdown files are the source of truth for curated memory; the FTS table is a disposable index reconciled by directory walk + size-mtime fingerprints (lazy, before each search and each rebuild).
3. Four layers: session checkpoint (11 structured sections, machine-validated), project MEMORY.md (4 sections), global MEMORY.md, raw trajectory + FTS.
4. Separation of duties: main agent appends to notes.md only (plus exceptional MEMORY.md edits for explicit user rules), a background writer subagent owns all structured files, enforced by a path guard at the file-write tool layer and a preStop validator with reflection-retry.
5. Read = (a) system-prompt instructions teaching the layout, (b) budgeted layered dump injected only at threshold-crossing rebuild (never delete history; insert synthetic boundary message), (c) `memory` search tool (BM25, OR-join, relative score floor) with escalation ladder to (d) `history` search/around tool over raw trajectory.
6. Write triggers = context-fill percentage thresholds firing a background writer mid-turn; pressure nudges near overflow; subagent postStop progress journals.
7. Evolution = periodic LLM passes over files + raw DB: dream (7d, consolidate/dedupe/prune/promote, size caps) and distill (30d, package repeated workflows into skills/commands/agents), auto-triggered at session start, last-run tracked by session title.

## 12. Not found / uncertain

- The blog's "~20%, 45%, 70%" thresholds and "~65K token" rebuild budget do not match shipped code (20/40/60/80% defaults; caps summing ~40K + 10–20K tail). Blog likely describes an earlier internal build.
- Blog phrase "History... stored without indexing" predates the `history_fts` migration (2026-06-09); code does index it.
- Exact verbatim blog text: WebFetch returns model-summarized content; quotes in §1 are as returned by the fetch model, not screenshot-verified.
- Benchmark numbers are reproduced from the blog only; no evaluation harness was found in the repo (not searched exhaustively).
- `STATS.md`, `docs/superpowers/specs/*` design docs referenced in code comments were not all read; spec filenames are cited in comments (e.g. `2026-05-22-checkpoint-v8-design.md`, `2026-06-03-checkpoint-threshold-density-design.md`) but the `docs/` dir in the shallow clone contains only a stub.
- The `task` tool / task registry and `actor` system are load-bearing for §4 Task tree reconciliation but were documented here only as far as the memory system touches them.
