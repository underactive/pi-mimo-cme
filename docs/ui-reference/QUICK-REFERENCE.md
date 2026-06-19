# Pi-mimo-cme: Quick Reference — Commands & UI at a Glance

## One-Page Command Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                      /memory (Hub Command)                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  /memory [status]      → 🔍 View memory index counts & file paths    │
│  /memory search <q>    → 🔎 BM25 search (top 10 + escalation)       │
│  /memory preview      → 👁  Show injected content (appendix + rebuild)│
│  /memory metrics       → 📊 Checkpoint-writer cost analysis         │
│  /memory validations   → ✅ Output quality histogram (Phase 1)       │
│  /memory dream         → 💭 Consolidate memory (queued if busy)     │
│  /memory distill       → 📦 Package workflows (queued if busy)      │
│  /memory clear [--yes] → 🗑️  Wipe project memory (safe, reversible) │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘

Aliases:
  /dream              ↔ /memory dream
  /distill            ↔ /memory distill

Tools (Model-facing):
  memory(query, scope?, limit?)  → BM25 search memory layers
  history(op, query?, filters)   → Full-text raw conversation history
```

---

## UI Elements at Runtime

### Status Bar Footer (Always Visible)
```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                        │
│  ... other extensions ...  󰍛 42 idx · 287 hist   (dark gray text)   │
│                                                                        │
│  Left: icon + memIdx = memory_fts row count (all scopes)             │
│  Right: projHist = history_fts row count (this project)              │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

**Updates**:
- Every session_start (seeded)
- After every message_end (history+)
- After every turn_end (backstop)
- After dream pass (if changed)
- After subagent lifecycle events

---

### Toast Notifications (Temporary Alerts)

#### Info Level (Blue/Green)
```
ℹ  🔄 mimo-cme: memory indexed — 3 indexed, 2 removed
ℹ  🧠 mimo-cme: dream — 12 consolidated, 1 pruned, 1 to global
ℹ  ✨ mimo-cme: distilled — packaged 2 assets (SKILL.md, …)
ℹ  💾 mimo-cme: checkpoint saved — session memory written
ℹ  🌙 mimo-cme: dream consolidation running in background
ℹ  📦 mimo-cme: distill pass running in background
ℹ  mimo-cme: dream queued — runs after the current turn
```

#### Warning Level (Yellow/Orange)
```
⚠  mimo-cme: a memory operation failed (see ~/.pi/cme/logs/extension.log)
⚠  mimo-cme: agent is busy — run that again when idle
⚠  mimo-cme: agent is busy — run /memory clear when idle
⚠  usage: /memory search <query>
⚠  mimo-cme: no interactive UI — re-run `/memory clear --yes` to execute
```

#### Info with Empty Result
```
ℹ  mimo-cme: nothing to clear for project <pid>
ℹ  mimo-cme: clear cancelled
ℹ  🧠 mimo-cme: dream complete — no memory changes
ℹ  ✨ mimo-cme: distill complete — nothing worth packaging
```

---

### Dialog Confirmation

```
┌─────────────────────────────────────────────────────────────────────┐
│ mimo-cme: clear this project's memory?                              │
├─────────────────────────────────────────────────────────────────────┤
│ Project <pid>: curated files move to trash, derived DB rows are     │
│ deleted. The current session is preserved. Proceed?                 │
│                                                                      │
│ [Yes]  [No]  [Cancel]                                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Custom Messages (Display Types)

#### `mimo-cme:status`
From: `/memory` (default)
```
mimo-cme memory status

memory files indexed: global=2 projects=1 sessions=3
history rows: 1234 total, 287 this project
subagents (this session): none
db: /Users/esison/.pi/cme/memory.db (156.3 KB)
last dream: 2026-06-18T10:23:45Z (auto=true, every 7d)
last distill: 2026-06-17T14:50:22Z (auto=true, every 30d)

session  <sid>
  checkpoint: /Users/esison/.pi/cme/sessions/<sid>/checkpoint.md
  notes:      /Users/esison/.pi/cme/sessions/<sid>/notes.md
project  <pid>
  memory:     /Users/esison/.pi/cme/projects/<pid>/MEMORY.md
global   /Users/esison/.pi/cme/global/MEMORY.md
```

#### `mimo-cme:search`
From: `/memory search <query>`
```
memory search "<query>"

0.78  /Users/esison/.pi/cme/projects/<pid>/MEMORY.md
      scope=projects/<pid> type=memory score=0.78
      ...extracted snippet matching query...

0.61  /Users/esison/.pi/cme/sessions/<sid>/checkpoint.md
      scope=sessions/<sid> type=checkpoint score=0.61
      ...snippet...

A hit here is authoritative: these are your own memory files. 
If you need the FULL body (snippets are truncated), Read the path.
```

#### `mimo-cme:metrics`
From: `/memory metrics`
```
mimo-cme writer metrics (Phase 3 "measure first")

this project (<pid>): 15 run(s), 14 ok
  writer tokens/run:   input≈340  output≈85  total≈425
  cache tokens/run:    read≈0  write≈0   (read≈0 = no prefix reuse today)
  cost/run:            $0.0028
  delta fed/run:       ≈280 tok
  parent ctx at fire:  ≈8,200 tok   (what a fork=true writer would carry)
  wall-clock/run:      240 ms

verdict: fork MIGHT help: best case ~820 cache-read tok/run < 340 
         full-price input now → worth deeper measurement
```

#### `mimo-cme:validations`
From: `/memory validations`
```
mimo-cme checkpoint validations (Phase 1 "measure first")

this project (<pid>): 15 checkpoint(s) validated
  clean (no error/extract):  12 (80%)
  with error:                2 (13%)
  with extract-required:     1 (7%)
  with warn:                 3 (20%)
  avg violations/run:        error≈0.13 extract≈0.07 warn≈0.20
  worst budget overrun:      8%
  code histogram (runs):
    CHECKPOINT_SECTION_MISMATCH: 2
    TOKEN_BUDGET_EXCEEDED: 1

Phase 2 (retry + revert) is gated on this data — see docs/FUTURE-IMPROVEMENTS.md.
```

#### `mimo-cme:clear-preview`
From: `/memory clear` (before confirmation)
```
mimo-cme: clear memory for project <pid>
(current session <sid> is preserved)

Will delete:
  project memory:   /Users/esison/.pi/cme/projects/<pid>/MEMORY.md
  session files:    2 directories (sessions: <sid2>, <sid3>)
  DB rows:          history=287, actor=5, writer_metrics=15, validations=12
  timestamps:       last_dream_at, last_distill_at

Will preserve:
  global memory, current session, pi transcripts, cc index
```

#### `mimo-cme:clear-result`
From: `/memory clear --yes` (after execution)
```
mimo-cme: project <pid> memory cleared.
  moved 2 director(ies) → /Users/esison/.pi/cme/trash/<timestamp>/
```

#### `mimo-cme:rebuild` (After Resume / Fork / Compaction)
From: `before_agent_start` (one-shot, ~26k cap)
```
⚠️  MEMORY SUMMARY — Resume directly. Do not acknowledge this dump, do not recap.

## Active intent
<from checkpoint.md § Active intent>

## Open tasks
... <from rpiv-todo snapshot, if present>

## Active actors
... <from actor ledger, if present>

[truncation marker if hit cap]

For full details, see: /Users/esison/.pi/cme/sessions/<sid>/checkpoint.md
```

#### `mimo-cme:nudge` (Context Fill-Up Warning)
From: `before_agent_start` at 70% / 85% usage (hidden, display: false)
```
<system-reminder>Context is filling up (78% used). If you have important 
learnings or decisions from this session, consider writing them to memory 
now before context may be reset.</system-reminder>
```

---

## Data Flow Diagram: `/memory search` → Memory Tool

```
┌─────────────────────────────────────────────────────────┐
│ User runs: /memory search "my_term"                     │
│     OR                                                  │
│ Model calls: memory(query="my_term", scope?, limit?)    │
└─────────────────────────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ Check config.reconcileOnSearch       │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ IF true: Walk file tree (mtime-size │
        │ fingerprints), reconcile vs index   │
        │ → reseed footer cache if changed    │
        │ → notify "🔄 memory indexed"        │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ BM25 FTS5 search:                   │
        │ memory_fts WHERE (query matches)    │
        │ AND (score ≥ floorRatio × top)      │
        │ LIMIT 10                            │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ Format results:                     │
        │ <path>                              │
        │   scope=<s> type=<t> score=<score>  │
        │   <snippet (500 char cap)>          │
        └─────────────────────────────────────┘
                          ↓
        ┌─────────────────────────────────────┐
        │ IF 0 hits: escalation ladder        │
        │ 1. Retry with fewer terms           │
        │ 2. Grep the memory dir              │
        │ 3. Use history tool                 │
        │ 4. Widen scope                      │
        └─────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Return to model / display as custom message             │
│ customType: "mimo-cme:search"                           │
└─────────────────────────────────────────────────────────┘
```

---

## State Machine: `/memory clear`

```
Start
  ↓
[Idle?] ──NO→ warn "agent is busy" → exit
  │
  YES
  ↓
planClear() [DRY RUN]
  ↓
showReadout("mimo-cme:clear-preview", plan)
  ↓
[--yes flag?] ──YES→ execute = true
  │
  NO
  ├→ [has UI?] ──NO→ warn "re-run with --yes" → exit
  │    │
  │    YES
  │    ↓
  │   confirm dialog ──NO→ notify "clear cancelled" → exit
  │    │
  │    YES
  │    └→ execute = true
  ↓
executeClear(db, plan)
  ├─ Move files to trash
  ├─ Delete DB rows
  └─ counts.seed() [reseed footer cache]
  ↓
showReadout("mimo-cme:clear-result", result)
  ↓
Done
```

---

## Configuration Flags & Their UI Impact

```json
{
  "checkpoint": {
    "reconcileOnSearch": true,
    // → After /memory search, checks if index is stale (walk file tree)
    //   and notifies 🔄 if changed (false = skip walk, faster but stale)

    "reconcileDebounceMs": 4000,
    // → Skip reconcile if one ran < 4s ago in THIS session
    //   (zero = disable debounce; burst searches still walk once)

    "maxWriterFailures": 3
    // → After 3 consecutive checkpoint failures, give up with a log message
  },

  "dream": {
    "auto": true,        // Auto-pass on first prompt of session?
    "intervalDays": 7    // Min 7 days between auto-passes
  },

  "distill": {
    "auto": true,        // Auto-pass on first prompt of session?
    "intervalDays": 30   // Min 30 days between auto-passes
  }
}
```

---

## Notification Throttling & Limits

| Notification | Throttle | Limit | Trigger |
|---|---|---|---|
| Error toast | 60s | 1 per 60s | Any handler failure |
| Memory indexed | None | All | reconcileAndNotify() |
| Search result | N/A | Idle only | /memory search |
| Checkpoint saved | None | Each success | Writer ✓ |
| Dream/distill result | None | Each pass | Pass completion |
| Context nudge | Per-level | 2 per session (70%, 85%) | % threshold cross |

---

## File Locations Referenced in UI

```
~/.pi/cme/
  ├─ memory.db                          ← Indexed FTS5 + tables
  ├─ config.json                        ← Settings (optional)
  ├─ logs/
  │  └─ extension.log                   ← All operations logged
  ├─ projects/<pid>/
  │  └─ MEMORY.md                       ← Project-scoped memory
  ├─ sessions/<sid>/
  │  ├─ checkpoint.md                   ← Session state (11 sections)
  │  ├─ notes.md                        ← Session scratchpad
  │  └─ tasks/<actor-id>/
  │     └─ progress.md                  ← Subagent journal
  ├─ global/
  │  └─ MEMORY.md                       ← User-level memory
  └─ trash/
     └─ <timestamp>/                    ← Recovered deletes here
```

All paths appear in `/memory status` readout.

---

## Emoji Glossary

| Emoji | Meaning | Context |
|---|---|---|
| 󰍛 | Memory index icon | Status bar footer |
| 🔍 | Search | Commands |
| 🔎 | Fine search | Search tool |
| 📊 | Metrics | Writer cost readout |
| ✅ | Validation | Quality histogram |
| 💭 | Dream | Consolidation pass |
| 📦 | Distill | Packaging pass |
| 🗑️ | Clear/delete | Wipe command |
| 🔄 | Reconcile | Index update |
| 🧠 | Dream result | Pass completion |
| ✨ | Distill result | Pass completion |
| 💾 | Save | Checkpoint success |
| 🌙 | Night/background | Auto-dream start |
| 📦 | Package | Distill start |
| ℹ️ | Info | Toast level |
| ⚠️ | Warning | Toast level |

