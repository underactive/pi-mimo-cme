# Pi-mimo-cme: Complete User-Facing Commands & UI Elements Analysis

**Project**: pi-mimo-cme at `/Users/esison/Development/projects/pi/pi-mimo-cme`  
**Analysis Date**: 2026-06-18  
**Branch**: main  
**Commit**: 7c843e1

## Overview

pi-mimo-cme surfaces the memory system to users via:
1. **Commands** — seven command entry points (command palette: `/memory`, `/dream`, `/distill`)
2. **Tools** — two tools registered for the model (BM25 memory search + history search)
3. **UI Elements** — toast notifications, status bar footer, dialog confirmations, and special message types
4. **Automatic Notifications** — background task feedback (dream/distill passes, checkpoints)

---

## Commands (Entry Points)

All commands are registered in `src/commands.ts` via `registerCommands(pi, deps)` called from `src/index.ts` at session shutdown.

### 1. `/memory` — Main Memory Command Hub

**File**: `src/commands.ts` lines 323–374  
**Handler**: `handler(args, ctx)` dispatches to subcommands based on trimmed args

#### Subcommand: `/memory status`
- **Usage**: `/memory` (default when no argument)
- **Handler**: Calls `showReadout(ctx, "mimo-cme:status", statusText(...))`
- **Output**: Custom message with `customType: "mimo-cme:status"`
- **Content**: Text readout from `statusText()` (lines 99–127)
  - Memory files indexed (breakdown by scope: global, projects, sessions, cc)
  - History row counts (total + per project)
  - Subagent counts for current session (by status)
  - DB file size in KB
  - Last dream timestamp (auto flag + interval)
  - Last distill timestamp (auto flag + interval)
  - Session checkpoint, notes, project memory, and global memory file paths

#### Subcommand: `/memory search <query>`
- **Usage**: `/memory search <query>`
- **Handler**: Calls `showReadout(ctx, "mimo-cme:search", ...)`
- **Output**: Custom message with `customType: "mimo-cme:search"`
- **Precondition**: Requires idle state (queued as warning if busy)
- **Reconciliation**: If `config.checkpoint.reconcileOnSearch` is true, runs `reconcileAndNotify()` first
- **Search Logic**: `memorySearch(db, { query, limit: 10, floorRatio })` from `src/fts.ts`
- **Content**: Top 10 BM25 hits with score and snippet, or escalation ladder if zero hits
- **Escalation Ladder** (when no results):
  - Retry with fewer/rarer terms
  - Grep the memory dir for literals
  - Use history tool for verbatim content
  - Widen scope (session → project → global → history)

#### Subcommand: `/memory preview`
- **Usage**: `/memory preview`
- **Handler**: Calls `showReadout(ctx, "mimo-cme:preview", ...)`
- **Output**: Custom message with `customType: "mimo-cme:preview"`
- **Precondition**: Requires idle state
- **Content**: Two sections separated by `sectionHeader` dividers:
  - **System Prompt Appendix (every turn)**: The full text of `buildSystemPromptAppendix()` — memory instructions, project MEMORY.md, global MEMORY.md, and memory keys index.
  - **Rebuild Dump (last resume/fork/compaction)**: The full text of `buildRebuildDump()` — session checkpoint, notes, open tasks, active actors, keys index. Shows "(none — no checkpoint loaded this session)" when no resume has occurred.
- **Side effect**: Calls `buildRebuildDump()` which sets `setRebuildBreakdown()` counters. The appendix also updates `setAppendixBreakdown()`. Both are in-memory display state; no DB mutations.
- **Purpose**: Debugging / transparency — lets users see the exact text injected into the system prompt each turn.

#### Subcommand: `/memory metrics`
- **Usage**: `/memory metrics`
- **Handler**: Calls `showReadout(ctx, "mimo-cme:metrics", metricsText(...))`
- **Output**: Custom message with `customType: "mimo-cme:metrics"`
- **Precondition**: Requires idle state
- **Content**: From `metricsText()` (lines 129–181)
  - Phase 3 "measure first" readout
  - Per-project writer token usage breakdown (this project + all projects)
  - Cache hit analysis (read ≈ 10% of input price)
  - Cost per run in USD
  - Delta tokens per checkpoint
  - Parent context size at fire time (for fork=true comparison)
  - Wall-clock time per run
  - **Verdict**: Fork LOSES / MIGHT help (based on cache comparison)
  - Data is from `writer_metrics` table; "no runs" message if empty

#### Subcommand: `/memory validations`
- **Usage**: `/memory validations`
- **Handler**: Calls `showReadout(ctx, "mimo-cme:validations", validationText(...))`
- **Output**: Custom message with `customType: "mimo-cme:validations"`
- **Precondition**: Requires idle state
- **Content**: From `validationText()` (lines 183–219)
  - Phase 1 "measure first" histogram (CHECKPOINT-VALIDATOR-PLAN)
  - Per-project checkpoint count + validation results
  - Clean rate (percentage with no errors)
  - Code histogram of violations (error, extract-required, warn)
  - Average violations per run
  - Worst budget overrun percentage
  - Note: "Phase 2 (retry + revert) is gated on this data"
  - Data is from `checkpoint_validations` table; "no runs" message if empty

#### Subcommand: `/memory dream`
- **Usage**: `/memory dream`
- **Handler**: Calls `sendManualPass(ctx, buildDreamPrompt(...), "dream")`
- **Output**: Sends a user message with the dream prompt (inline with agent, not a separate command)
- **Delivery**: 
  - If idle: sent immediately via `pi.sendUserMessage(prompt)`
  - If busy: queued as follow-up with toast `"mimo-cme: dream queued — runs after the current turn"`

#### Subcommand: `/memory distill`
- **Usage**: `/memory distill`
- **Handler**: Calls `sendManualPass(ctx, buildDistillPrompt(...), "distill")`
- **Output**: Sends a user message with the distill prompt
- **Delivery**: Same as `/memory dream` (immediate or queued)

#### Subcommand: `/memory clear`
- **Usage**: `/memory clear [--yes | -y | force]`
- **Handler**: `runClear(ctx, rest)` (lines 268–306)
- **Precondition**: Requires idle state (warning if busy)
- **Flow**:
  1. `planClear()` from `src/clear.ts` — dry-run, no mutations
  2. Shows preview message with `customType: "mimo-cme:clear-preview"` from `describeClearPlan()`
  3. Asks for confirmation via `ctx.ui.confirm()` unless `--yes` flag or forced
  4. In headless mode without UI: warns to re-run with `--yes`
  5. If confirmed: `executeClear()` mutates the DB, moves files to trash
  6. Shows result message with `customType: "mimo-cme:clear-result"` from `describeClearResult()`
  7. Reseeds cached footer counters via `deps.counts?.seed()`
- **What Gets Cleared**:
  - Project memory file (`projects/<pid>/MEMORY.md`)
  - Linked session files (`sessions/<sid>/`)
  - DB rows tagged `project_id = <pid>` (history, actor, writer_metrics, checkpoint_validations)
  - Dream/distill timestamps in `meta` table
- **What's Preserved**:
  - Global memory
  - Current live session
  - PI's own session transcripts
  - CC index (if enabled)

#### Argument Completions for `/memory`
- **File**: Line 325–326
- **Values**: `["status", "search", "preview", "metrics", "validations", "dream", "distill", "clear"]`
- **Pattern**: Filters by prefix

---

### 2. `/dream` — Manual Consolidation Pass (Alias)

**File**: `src/commands.ts` lines 309–314  
**Description**: "mimo-cme: consolidate durable memory from recent sessions (manual dream pass)"  
**Handler**: `sendManualPass(ctx, buildDreamPrompt(...), "dream")`  
**Output**: Queues/sends dream prompt immediately  
**Note**: Alias for `/memory dream`

---

### 3. `/distill` — Manual Workflow Packaging (Alias)

**File**: `src/commands.ts` lines 316–321  
**Description**: "mimo-cme: package repeated workflows into skills/commands (manual distill pass)"  
**Handler**: `sendManualPass(ctx, buildDistillPrompt(...), "distill")`  
**Output**: Queues/sends distill prompt immediately  
**Note**: Alias for `/memory distill`

---

## Tools (Registered for the Model)

### Tool 1: `memory` — BM25 Full-Text Search

**File**: `src/tools.ts` lines 39–82  
**Registration**: `registerMemoryTool(pi, deps)`  
**Name**: `memory`  
**Label**: `Memory`

**Description**:
```
Search your persistent memory layers (session checkpoints, project memory, global memory) 
with BM25 full-text search over markdown bodies. Use this FIRST when past context might 
already record the answer — before asking the user or re-deriving it. Hits return path / 
scope / type / score / snippet; Read the path for the full body.
```

**Parameters**:
- `query` (required): Search query (BM25 over markdown bodies)
- `scope` (optional): `"global" | "projects" | "sessions" | "cc"`
- `scope_id` (optional): Session ID or 12-hex project ID hash
- `type` (optional): `"memory" | "checkpoint" | "notes" | "free"`
- `limit` (optional): Max results (default 10)

**Execution Mode**: Sequential  
**Precondition**: If `config.checkpoint.reconcileOnSearch` is true, calls `reconcileAndNotify(deps)` first

**Output Format**:
```
<path>
  scope=<scope>[/<scope_id>] type=<type> score=<score>
  <snippet (truncated)>

(repeats for each hit)

A hit here is authoritative: these are your own memory files. If you need the FULL 
body (snippets are truncated), Read the path.
```

**Zero-Hit Response**:
```
No hits.

Escalation ladder:
1. Retry with fewer or rarer terms (BM25 ranks by token rarity).
2. Grep the memory dir (<root>) for tokenizer-split literals (dotted.names, snake_case, CLI flags).
3. Use the history tool for verbatim past-conversation content.
4. Widen scope: session → project → global → history.
```

---

### Tool 2: `history` — Raw Conversation Search

**File**: `src/tools.ts` lines 84–151  
**Registration**: `registerHistoryTool(pi, deps)`  
**Name**: `history`  
**Label**: `History`

**Description**:
```
Search RAW conversation trajectory across past sessions. USE ONLY WHEN MEMORY SEARCH 
RETURNS NOTHING USEFUL. memory is your curated notebook — small, fast, semantically 
organized. ALWAYS try `memory` first. history is the unindexed firehose of your past 
sessions — use it for verbatim recall (exact error text, an old command, a specific tool 
output) when curated memory has no answer.
operation=search: AND full-text search with filters; returns message_ids.
operation=around: fetch ±N rows around a message_id from a previous search.
```

**Parameters**:
- `operation` (required): `"search" | "around"` (default: "search")
- `query` (optional): Search query (AND-joined tokens)
- `scope` (optional): `"project" | "global"` (default: "project")
- `session_id` (optional): Restrict to one session
- `kind` (optional): Array of row kinds (union of ALL_HISTORY_KINDS)
- `tool_name` (optional): Restrict to one tool
- `time_after` (optional): Epoch ms lower bound
- `time_before` (optional): Epoch ms upper bound
- `limit` (optional): Max results (default 10, hard cap 50)
- `message_id` (optional): Anchor for operation=around
- `before` (optional): Rows before anchor (default 5)
- `after` (optional): Rows after anchor (default 5)

**Execution Mode**: Sequential

**Output for operation=search**:
```
[<message_id>] <kind>[(<tool_name>)] <timestamp>
  <snippet (truncated)>

(repeats for each hit)

Use operation=around with a message_id to read the surrounding conversation.
```

**Output for operation=around**:
```
[<message_id>] <kind>[(<tool_name>)] <timestamp>
<full body (up to 20KB)>

(repeats for each row)

[output capped at 20KB bytes — narrow the window with smaller before/after]
```

---

## UI Elements

### 1. Toast Notifications

All notifications use `ctx.ui.notify(message, level)` or the `notify` shim in index.ts.

#### Error Notification (Throttled)
**File**: `src/index.ts` lines 93–108  
**Throttle**: 60 seconds (`ERROR_NOTIFY_THROTTLE_MS`)  
**Level**: `"warning"`  
**Message**:
```
mimo-cme: a memory operation failed (see ~/.pi/cme/logs/extension.log)
```
**Trigger**: Any handler failure (logged first, then surfaced once per 60s window)

#### Memory Reconcile Notification
**File**: `src/commands.ts` lines 63–79 (`reconcileAndNotify`)  
**Condition**: Only fires when actual reconciliation happens AND rows changed  
**Level**: `"info"`  
**Messages**:
```
🔄 mimo-cme: memory indexed — <count> indexed[, <count> removed]
```
**Trigger**: After search when `reconcileOnSearch` is true, or from memory tool

#### Manual Dream Pass Queuing
**File**: `src/commands.ts` line 248  
**Level**: `"info"`  
**Message**:
```
mimo-cme: dream queued — runs after the current turn
```
**Trigger**: When `/memory dream` or `/dream` runs while agent is busy

#### Manual Distill Pass Queuing
**File**: `src/commands.ts` line 248 (same handler)  
**Level**: `"info"`  
**Message**:
```
mimo-cme: distill queued — runs after the current turn
```
**Trigger**: When `/memory distill` or `/distill` runs while agent is busy

#### Agent-Busy Warnings
**File**: `src/commands.ts`  
**Level**: `"warning"`  
**Messages**:
- Line 261 (showReadout):
  ```
  mimo-cme: agent is busy — run that again when idle
  ```
- Line 274 (clear):
  ```
  mimo-cme: agent is busy — run /memory clear when idle
  ```
**Trigger**: When a read-only command runs while agent is streaming

#### Clear Command Flow Notifications
**File**: `src/commands.ts` lines 281–298

- **Nothing to clear**:
  ```
  mimo-cme: nothing to clear for project <pid>
  ```
  Level: `"info"`, Trigger: When plan.empty is true

- **No interactive UI** (headless):
  ```
  mimo-cme: no interactive UI — re-run `/memory clear --yes` to execute
  ```
  Level: `"warning"`, Trigger: When UI.confirm() is unavailable

- **Clear cancelled**:
  ```
  mimo-cme: clear cancelled
  ```
  Level: `"info"`, Trigger: When user declines confirmation

#### Invalid Usage
**File**: `src/commands.ts` line 354  
**Level**: `"warning"`  
**Message**:
```
usage: /memory search <query>
```
**Trigger**: When `/memory search` runs without a query

#### Background Pass Notifications
**File**: `src/index.ts` lines 394–397  
**Level**: `"info"`  
**Messages**:
```
🌙 mimo-cme: dream consolidation running in background
```
or
```
📦 mimo-cme: distill pass running in background
```
**Trigger**: Auto-scheduled dream/distill passes starting

#### Dream Pass Result Notifications
**File**: `src/index.ts` lines 352–357 (`reportPassResult`)  
**Level**: `"info"`  
**Messages**:

No changes:
```
🧠 mimo-cme: dream complete — no memory changes
```

With changes:
```
🧠 mimo-cme: dream — <count> consolidated[, <count> pruned][, <count> to global]
```

**Trigger**: After background or manual dream completes

#### Distill Pass Result Notifications
**File**: `src/index.ts` lines 365–370 (`reportPassResult`)  
**Level**: `"info"`  
**Messages**:

Nothing created:
```
✨ mimo-cme: distill complete — nothing worth packaging
```

Single asset:
```
✨ mimo-cme: distilled — packaged <asset_label>
```

Multiple assets:
```
✨ mimo-cme: distilled — packaged <count> assets (<asset_label>, …)
```

**Trigger**: After background or manual distill completes

#### Checkpoint Saved Notification
**File**: `src/checkpoint.ts` line 373 (`run` method)  
**Level**: `"info"` (default)  
**Message**:
```
💾 mimo-cme: checkpoint saved — session memory written
```
**Trigger**: After in-process checkpoint writer succeeds

---

### 2. Status Bar Footer

**File**: `src/index.ts` lines 278–297 (`refreshStatus`)  
**Implementation**: `ctx.ui.setStatus("mimo-cme", status_string)`  
**Updates**: Called at:
- `session_start` (initial seed)
- After backfill completes
- After every `message_end` (history adds)
- After every `turn_end` (backstop)
- After dream pass (if changed)
- After subagent lifecycle events

**Format**: Two counters with medium-gray ANSI color (256-palette #244)
```
󰍛 <memIdx> idx · <projHist> hist
```

Where:
- `memIdx` = count of rows in `memory_fts` (all scopes)
- `projHist` = count of rows in `history_fts` for this project
- Color: `\x1b[38;5;244m` (medium gray) with `\x1b[0m` reset

**Cached Counters**: In-memory `FooterCounts` class (`src/footer-counts.ts`)
- Seeded once per session via `counts.seed(db, projectId)`
- Updated per-turn via `counts.addHistory(n)` (pure arithmetic, no SQL)
- Reseeded after batch ops (`reconcile`, future prune) via `counts.reseedMemory(db)` / `reseedHistory(db, pid)`

---

### 3. Dialog Confirmations

**File**: `src/commands.ts` lines 292–295 (`runClear`)  
**Function**: `ctx.ui.confirm(title, body)`

**Title**:
```
mimo-cme: clear this project's memory?
```

**Body**:
```
Project <pid>: curated files move to trash, derived DB rows are deleted. 
The current session is preserved. Proceed?
```

**Returns**: Boolean (true = proceed, false = cancel)  
**Fallback**: Headless mode warns and requires `--yes` flag

---

### 4. Custom Message Types

Custom messages are injected into the conversation with `pi.sendMessage({ customType, content, display })`. These are distinct from regular messages and can carry structured UI rendering.

#### Type: `mimo-cme:status`
**Source**: `/memory` (default subcommand)  
**Content**: Plain text from `statusText()`  
**Display**: true (rendered to user)

#### Type: `mimo-cme:search`
**Source**: `/memory search <query>`  
**Content**: Plain text with hits + scores + snippets  
**Display**: true

#### Type: `mimo-cme:metrics`
**Source**: `/memory metrics`  
**Content**: Plain text metrics readout  
**Display**: true

#### Type: `mimo-cme:validations`
**Source**: `/memory validations`  
**Content**: Plain text validation histogram  
**Display**: true

#### Type: `mimo-cme:clear-preview`
**Source**: `/memory clear` (before confirmation)  
**Content**: Plain text from `describeClearPlan()`  
**Display**: true

#### Type: `mimo-cme:clear-result`
**Source**: `/memory clear` (after execution)  
**Content**: Plain text from `describeClearResult()`  
**Display**: true

#### Type: `mimo-cme:rebuild`
**Source**: Injected after `session_start` with reason `resume | fork`, or after `session_compact`  
**Content**: One-shot dump (checkpoint + notes + memory keys + open tasks + active actors)  
**Display**: true  
**Cap**: ~26k tokens total  
**Framing**: "Summary of previous conversation from checkpoint files"  
**Note**: Injected by `before_agent_start` event handler with instruction "Resume directly. Do not acknowledge this memory dump, do not recap."

#### Type: `mimo-cme:nudge`
**Source**: Injected at `before_agent_start` when context crosses 70% or 85% usage  
**Content**: System reminder (XML-like tag)  
**Display**: false (hidden from user, context-only)  
**Message**:
```
<system-reminder>Context is filling up (<percent>% used). If you have important 
learnings or decisions from this session, consider writing them to memory now before 
context may be reset.</system-reminder>
```
**Trigger**: Thresholds at 70% and 85%, once per level per session

---

## Automatic Background Notifications

### Auto-Dream Pass
**Condition**: `config.dream.auto` (default: true) + first session sighting of project + interval elapsed (default: 7 days)  
**Notification on Start**:
```
🌙 mimo-cme: dream consolidation running in background
```
**Notification on Complete**: See "Dream Pass Result Notifications" above

### Auto-Distill Pass
**Condition**: `config.distill.auto` (default: true) + first session sighting of project + interval elapsed (default: 30 days)  
**Notification on Start**:
```
📦 mimo-cme: distill pass running in background
```
**Notification on Complete**: See "Distill Pass Result Notifications" above

---

## Summary Table: All UI-Facing Surfaces

| Surface Type | Count | Key Locations |
|---|---|---|
| Toast Notifications | 13 | index.ts, commands.ts, checkpoint.ts |
| Status Bar Updates | 1 | index.ts `refreshStatus()` |
| Dialog Confirmations | 1 | commands.ts `runClear()` → `ctx.ui.confirm()` |
| Custom Message Types | 7 | `mimo-cme:status/search/metrics/validations/clear-preview/clear-result/rebuild/nudge` |
| Tools (Registered) | 2 | memory + history |
| Commands | 3 + 2 aliases = 5 | /memory (hub) + /memory search/dream/distill/clear, /dream, /distill |
| **Total Distinct UI Touch Points** | **~28** | — |

---

## Data Flow for Key UI Operations

### `/memory` Status Readout
```
User runs: /memory status
  ↓
Handler checks isIdle()
  ↓
showReadout(ctx, "mimo-cme:status", statusText(...))
  ↓
Queries live DB:
  - memory_fts scope breakdown (COUNT GROUP BY scope)
  - history_fts total + per-project (COUNT WHERE/without project_id)
  - actor statuses (COUNT GROUP BY status)
  - DB file size (fs.statSync)
  - meta table (last_dream_at, last_distill_at)
  ↓
pi.sendMessage({ customType: "mimo-cme:status", content, display: true })
  ↓
UI renders custom message
```

### Memory Search (Tool)
```
Model calls: memory tool with query="<term>"
  ↓
reconcileAndNotify() if config.checkpoint.reconcileOnSearch
  - Reconcile: file-tree walk (size-mtime fingerprints) vs memory_fts
  - If changed: reseed footer cache, notify "🔄 memory indexed"
  ↓
memorySearch(db, { query, limit, floorRatio })
  - BM25 FTS5 query
  - Filters by relative score floor
  - Returns top 10 with score + snippet
  ↓
formatMemoryHits(hits, root)
  - Formats as <path>, scope/type/score, snippet
  ↓
Return to model as tool result
```

### `/memory clear`
```
User runs: /memory clear [--yes]
  ↓
Handler checks isIdle()
  ↓
planClear(db, cwd, ...) — dry run, no mutations
  ↓
showReadout(ctx, "mimo-cme:clear-preview", describeClearPlan(plan))
  - Shows files/rows to delete
  ↓
IF not --yes flag:
  ctx.ui.confirm("mimo-cme: clear...", "Project <pid>...")
  - User chooses Yes/No
  ↓
IF confirmed:
  executeClear(db, plan, ...)
  - Moves curated files to trash
  - Deletes DB rows
  - Reseeds footer cache: counts.seed(db, pid)
  ↓
showReadout(ctx, "mimo-cme:clear-result", describeClearResult(result))
  - Shows what was moved/deleted
```

---

## Configuration Impact on UI

From `config.json`:

```jsonc
{
  "checkpoint": {
    "reconcileOnSearch": true,  // Controls if /memory search triggers index rebuild + toast
    "reconcileDebounceMs": 4000, // How long to wait before re-walking file tree
  },
  "dream": {
    "auto": true,     // Background dream notifications
    "intervalDays": 7 // How often
  },
  "distill": {
    "auto": true,      // Background distill notifications
    "intervalDays": 30
  }
}
```

---

## Logging

All memory system operations are logged to `~/.pi/cme/logs/extension.log` with timestamps.
This is the backstop when UI notifications are throttled or not visible.

---

## Summary for Users

**How to access memory status**:
- `/memory` → detailed status with file paths and counts
- Footer `󰍛 idx · hist` → live counters on status bar

**How to search memory**:
- Model auto-uses `memory` tool (BM25, should be first escalation)
- Manual: `/memory search <term>`
- Escalation: `history` tool (for verbatim past content)

**How to evolve memory**:
- Auto: dream every 7 days, distill every 30 days (background, with toasts)
- Manual: `/dream` or `/distill` (runs in current session, watched)
- See results: `/memory metrics` (writer cost) and `/memory validations` (quality)

**How to wipe memory**:
- `/memory clear` → preview + confirm → moves files to trash, deletes DB rows
- Safe: current session + global memory preserved
- Reversible: trash dir for file recovery

