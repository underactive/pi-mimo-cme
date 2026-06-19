# Pi-mimo-cme: User-Facing Commands & UI Reference

This directory contains comprehensive documentation of all user-facing surfaces in pi-mimo-cme: commands, tools, toasts, status bar updates, and custom message types.

## Documents

### [QUICK-REFERENCE.md](./QUICK-REFERENCE.md)
**At a glance** — One-page visual guide with ASCII diagrams, state machines, and emoji glossary.

**Contains**:
- Command hub map (`/memory` + subcommands, `/dream`, `/distill`)
- Tool signatures (`memory` tool, `history` tool)
- Status bar footer format & update triggers
- Toast notifications (info/warning examples)
- Dialog confirmations
- Custom message types with example output
- Data flow diagrams
- Config flag impact table
- Emoji reference

**Use this when**: You need a quick lookup or visual overview of UI surfaces.

---

### [COMMANDS-UI-ANALYSIS.md](./COMMANDS-UI-ANALYSIS.md)
**Deep dive** — Comprehensive reference documenting every command, tool, notification, and UI element with source file locations and line numbers.

**Contains**:
- Commands (7 entry points):
  - `/memory` (hub with 6 subcommands: status, search, metrics, validations, dream, distill, clear)
  - `/dream` (alias)
  - `/distill` (alias)
  - Full handler signatures, preconditions, output types, and content templates
- Tools (2 registered):
  - `memory` tool (BM25 search + reconciliation)
  - `history` tool (raw conversation search + around context)
  - Parameter specifications, execution modes, zero-hit escalations
- UI Elements:
  - Toast notifications (13 distinct messages, 60s throttle on errors)
  - Status bar footer (live counter updates, ANSI color codes)
  - Dialog confirmations (`/memory clear` preview + confirm flow)
  - Custom message types (7: status, search, metrics, validations, clear-preview, clear-result, rebuild, nudge)
- Automatic notifications (auto-dream, auto-distill background feedback)
- Summary table (28 distinct UI touch points)
- Data flows for key operations (/memory status, memory search, /memory clear)
- Config impact documentation

**Use this when**: You need exact line numbers, full implementation details, or complete message text for documentation/testing.

---

## Quick Navigation

### Looking for...

| Need | Location | Quick Link |
|---|---|---|
| Command syntax | Quick Reference | [Command map](./QUICK-REFERENCE.md#one-page-command-map) |
| Tool parameters | Deep Analysis | [Tool 1: memory](./COMMANDS-UI-ANALYSIS.md#tool-1-memory--bm25-full-text-search), [Tool 2: history](./COMMANDS-UI-ANALYSIS.md#tool-2-history--raw-conversation-search) |
| Toast messages | Both | [Toasts (Quick)](./QUICK-REFERENCE.md#toast-notifications-temporary-alerts), [Toasts (Deep)](./COMMANDS-UI-ANALYSIS.md#1-toast-notifications) |
| Status bar format | Quick Reference | [Status bar](./QUICK-REFERENCE.md#status-bar-footer-always-visible) |
| Custom message types | Both | [Messages (Quick)](./QUICK-REFERENCE.md#custom-messages-display-types), [Messages (Deep)](./COMMANDS-UI-ANALYSIS.md#4-custom-message-types) |
| `/memory clear` flow | Quick Reference | [Clear state machine](./QUICK-REFERENCE.md#state-machine-memory-clear) |
| Implementation locations | Deep Analysis | Any section (all include file paths + line numbers) |
| Config flags | Quick Reference | [Config impact](./QUICK-REFERENCE.md#configuration-flags--their-ui-impact) |

---

## Key Concepts

### The `/memory` Hub
All memory-related commands flow through the single `/memory` entry point, with subcommands:
- **status** (default) — Display index counts, file paths, auto-pass timestamps
- **search** — BM25 full-text over memory layers (also callable as a tool)
- **metrics** — Writer cost analysis (Phase 3 instrumentation)
- **validations** — Checkpoint quality histogram (Phase 1 observation)
- **dream** — Manual consolidation pass (alias: `/dream`)
- **distill** — Manual workflow packaging (alias: `/distill`)
- **clear** — Wipe project memory with preview + confirmation

### Two Tools for the Model
- **`memory`** — Auto-called by the model for curated memory (BM25, should be first escalation)
- **`history`** — Fallback for raw conversation search (AND-joined, only after memory fails)

### Status Bar Live Counters
```
󰍛 42 idx · 287 hist
```
- Updated every turn (message_end, turn_end, dream/distill, subagent events)
- Cached in-memory, zero SQL per-turn
- Seeded once per session

### Context Fill-Up Nudges
At 70% and 85% usage, injected as hidden system reminders (display: false) to encourage writing to memory before potential context reset.

### `/memory clear` Safety
- Preview → Confirm → Execute pattern
- Files move to trash (recoverable), DB rows are deleted
- Current session + global memory always preserved
- Headless mode requires `--yes` flag

---

## File Locations in Source

All commands & tools registered in:
- **`src/commands.ts`** — `/memory` hub handler + subcommands, `registerCommands()`
- **`src/tools.ts`** — `memory` and `history` tool registration + formatting
- **`src/index.ts`** — Event handlers (session_start, message_end, turn_end, before_agent_start)
- **`src/checkpoint.ts`** — Nudge logic (`nudgeFor` method), checkpoint save notifications
- **`src/clear.ts`** — Clear plan + execute (two-phase wipe)
- **`src/footer-counts.ts`** — Status bar counter cache (zero per-turn SQL)

---

## Testing & Validation

### To verify all commands work:
```bash
# Status readout (idle only)
/memory

# Search (triggers reconciliation + BM25)
/memory search "architecture"

# Metrics (Phase 3 readout)
/memory metrics

# Validations (Phase 1 histogram)
/memory validations

# Dream (immediate or queued)
/dream
/memory dream

# Distill (immediate or queued)
/distill
/memory distill

# Clear (preview + confirm or --yes)
/memory clear --yes  # (testing only!)
```

### To verify tools:
```
# The model should auto-call these:
memory(query="my search term", scope="projects", limit=5)
history(operation="search", query="exact phrase")
history(operation="around", message_id="<sid>#<seq>", before=10, after=10)
```

### Toast visibility:
- Error toast (throttled): Any handler failure
- Memory indexed: After search with reconciliation + changes
- Checkpoint saved: After writer succeeds
- Dream/distill result: After pass completion
- Context nudge: At 70% and 85% (hidden, context-only)

---

## Configuration Reference

```json
{
  "checkpoint": {
    "thresholds": "auto",           // or [20, 40, 60, 80]
    "scoreFloor": 0.15,             // BM25 relative floor
    "reconcileOnSearch": true,      // Walk file tree on /memory search?
    "reconcileDebounceMs": 4000,    // Skip if walked < 4s ago
    "maxWriterFailures": 3          // Give up after N consecutive failures
  },
  "dream": {
    "auto": true,
    "intervalDays": 7
  },
  "distill": {
    "auto": true,
    "intervalDays": 30
  }
}
```

---

## Log File

All operations logged to:
```
~/.pi/cme/logs/extension.log
```

Throttled error notifications point users here for full details.

---

## Further Reading

- **Architecture**: `docs/design/ARCHITECTURE.md` — System overview
- **SPEC**: `docs/design/SPEC.md` — Behavioral spec
- **Memory System**: `docs/research/mimo-memory-system.md` — Design context
- **README**: `README.md` — User-facing overview

---

**Last Updated**: 2026-06-18  
**Analysis Scope**: Branch `main`, commit `7c843e1`  
**Files Indexed**: 19 source files in `src/`
