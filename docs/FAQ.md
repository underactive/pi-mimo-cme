# pi-mimo-cme FAQ — Cross-Session Memory for pi

> **Document version:** 1.0 (June 2026)
> **Repository:** `pi-mimo-cme` — an extension for the [pi](https://pi.dev) coding agent
> **Core concept:** Persistent memory that survives across coding sessions, inspired by [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code)

---

## Executive Summary

### What is pi-mimo-cme?

pi-mimo-cme is an **extension** for the pi coding agent that gives it persistent memory across sessions. Every time you open pi in the same project folder, it already remembers what you discussed, decided, and discovered in previous sessions.

### How does it work in one sentence?

It injects curated memory into every prompt (so the agent is never fully cold), automatically takes checkpoints as context fills (so long sessions are preserved), runs weekly consolidation passes (so knowledge compounds across sessions), and indexes everything in SQLite FTS5 for BM25 search.

### What problems does it solve?

| Problem | How CME addresses it |
|---------|---------------------|
| Agent forgets past decisions | Project/global memory is injected every turn; `memory` tool searches checkpoints |
| Long sessions lose early context | Automatic checkpoints at context thresholds (20%/10%/5%) save structured snapshots |
| Each session starts from scratch | Resume/fork injects a full checkpoint dump so the agent picks up where it left off |
| Lessons never compound across sessions | **Dream** pass (weekly) consolidates and deduplicates; **Distill** pass (monthly) packages repeated workflows into reusable skills |

### Where is my memory stored?

All memory lives under `~/.pi/cme/` (or wherever `PI_CODING_AGENT_DIR` points). Layers 1–3 are **plain Markdown files** — the source of truth. The SQLite database (`memory.db`) is a **derived index** plus the raw history store. **Deleting `memory.db` loses no curated memory** — it rebuilds from the Markdown files on the next search.

---

## For Programmers / Engineers

### Q: How is the codebase structured?

The extension is a single TypeScript file (`src/index.ts`) that wires everything together. Logic lives in focused pure modules under `src/`:

| Module | Responsibility | Pure? |
|--------|---------------|-------|
| `index.ts` | Factory: env guard, open DB, wire events/tools/commands, close on shutdown | No (pi-coupled) |
| `config.ts` | `DEFAULT_CONFIG` + `config.json` overlay | Yes |
| `paths.ts` | Memory root, pid/sid → file paths | Yes |
| `db.ts` | SQLite open/migrate (PRAGMA user_version), schema SQL, meta helpers | No (SQLite) |
| `fts.ts` | BM25 query building (OR/AND), memory search with score floor, history search/around | Pure-ish |
| `reconcile.ts` | Tree walk + size-mtime fingerprint upsert/prune | No (SQLite) |
| `checkpoint.ts` | Context-usage thresholds, delta serialization, in-process writer queue | No (SQLite) |
| `inject.ts` | System-prompt appendix + rebuild-dump assembly | No (filesystem) |
| `history.ts` | `message_end` extraction, per-session seq counter, JSONL backfill | No (SQLite) |
| `guard.ts` | Path guard for write/edit under memory root | Yes |
| `tools.ts` | `memory` (BM25) + `history` (AND + around) tool definitions | No (pi-coupled) |
| `commands.ts` | `/memory`, `/dream`, `/distill` commands | No (pi-coupled) |
| `actors.ts` | Subagent (actor) ledger from `pi.events` bus | Yes |
| `tasks.ts` | `@juicesharp/rpiv-todo` task-graph reader | Yes |
| `clear.ts` | `/memory clear` — two-phase project wipe | No (SQLite) |
| `budget.ts` | Token estimation (~4 chars/token) + budgeted file reads with truncation markers | Yes |
| `templates.ts` | 11-section checkpoint template, 4-section MEMORY template, notes template | Yes |
| `prompts/` | `checkpoint-writer.ts`, `dream.ts`, `distill.ts` — adapted MiMoCode prompts | Yes |

**Pure modules** (no pi imports) are unit-testable under plain `node --test`. See `src/index.ts:1-55` for the import map and `docs/design/ARCHITECTURE.md` for the full module map.

### Q: What's the schema of `memory.db`?

The database uses `node:sqlite` (Node ≥ 24, no native build step) with WAL mode. Key tables (`src/db.ts`):

| Table | Purpose | Derived from |
|-------|---------|--------------|
| `memory_fts` | Index of all markdown memory files (layers 1–3) | File tree via `reconcile.ts` |
| `memory_fts_idx` | FTS5 index over `memory_fts.body` (BM25 searchable) | Auto via triggers |
| `history_fts` | Per-message conversation fragments (layer 4) | `message_end` events + JSONL backfill |
| `history_fts_idx` | FTS5 index over `history_fts.body` (AND-joined search) | Auto via triggers |
| `meta` | Key-value store for timestamps, fingerprints, crossed thresholds | Code |
| `actor` | Subagent (actor) ledger from `pi.events` bus | `src/actors.ts` |
| `writer_metrics` | Per-checkpoint token usage profiling | `src/checkpoint.ts` |
| `checkpoint_validations` | Phase 1 checkpoint quality scores | `src/checkpoint.ts` |

**Important:** All tables except `meta` are derived. Delete any of them and they rebuild from the Markdown files on the next reconcile.

### Q: How does the checkpoint writer work?

The checkpoint writer runs **in-process** as a throwaway pi SDK session (`src/index.ts:160-260`). When context usage crosses a threshold:

1. The conversation delta (messages since last checkpoint) is serialized into role-labeled markdown, tool calls/results condensed to 500 chars, capped at ~100KB — newest content kept.
2. An in-process session is created with `DefaultResourceLoader({ noExtensions: true, ... })` — **no extensions load**, so pi-mimo-cme never binds to itself. `SessionManager.inMemory()` ensures no JSONL is persisted.
3. The writer receives a single prompt with the delta, task graph, and subagent progress inlined. It uses `read`/`write`/`edit` tools to update `checkpoint.md`, `MEMORY.md`, and `notes.md`.
4. Token usage is recorded into `writer_metrics` for the `/memory metrics` readout.
5. Queue depth is 1 — newest pending request wins, no backlog.

Key files: `src/checkpoint.ts` (thresholds, delta serialization, queue), `src/prompts/checkpoint-writer.ts` (the 11-section prompt), `src/index.ts:160-260` (the `runWriter` function).

### Q: How does the reconcile work?

`reconcile.ts` walks the memory tree (`global/`, `projects/`, `sessions/`, optionally `~/.claude/projects/*/memory/`) and for each `.md` file:

1. Reads its `size-mtimeNs` fingerprint (bigint stat, detects same-size edits within the same millisecond — APFS/ext4).
2. Compares against the stored fingerprint in `memory_fts`.
3. If changed: reads the body (capped at 256KB), re-indexes into `memory_fts` + triggers FTS5 re-index.
4. If file gone: deletes the row (FTS5 `'delete'` magic command — never plain `DELETE FROM` the vtab, see the war-story comment in `db.ts`).

The walk is **lazy** — it fires on each `memory` tool call, with a per-session debounce window (default 4 seconds) so rapid repeat searches don't re-walk the tree. This is the invariant enforcer: **Markdown files are source of truth; the DB is always derived.**

### Q: How does the path guard work?

`src/guard.ts` intercepts every `write`/`edit` tool call. Under the memory root, only two paths are writable by the main agent:

- `sessions/<sid>/notes.md` — the free-form scratchpad
- `projects/<pid>/MEMORY.md` — editable for explicit user rules

Everything else is blocked with a specific reason:
- `checkpoint.md` → "the checkpoint writer's domain"
- `tasks/` subtree → "subagent progress journals, synthesized by the extension"
- `global/MEMORY.md` → "read-only; dream pass promotes entries"
- Other sessions' files → "belongs to another session"
- Ad-hoc files like `learning.md`, `scratch.md` → "no ad-hoc files; notes.md is your only scratchpad"

The checkpoint writer (in-process, `noExtensions` loader), dream, and distill all run **without** this guard bound, so they write freely.

### Q: What's the token budget system?

Per-section token budgets for injection (`src/config.ts:PushCaps`):

| Section | Default cap | Purpose |
|---------|------------|---------|
| `checkpoint` | 11,000 | Session checkpoint dump on resume |
| `memory` | 10,000 | Project MEMORY.md injected every turn |
| `global` | 6,000 | Global MEMORY.md injected every turn |
| `notes` | 6,000 | Session notes injected on resume |
| `memoryKeys` | 500 | Index of searchable files |
| `actors` | 2,000 | Subagent ledger in §4 / rebuild dump |
| `tasks` | 2,000 | Task graph in §4 / rebuild dump |

Files exceeding budget get a truncation marker: `⚠️ Truncated at ~N tokens. Read("<path>", offset=L) for the rest.` — the agent can then fetch the tail on demand.

### Q: How are context-usage thresholds determined?

By default (`"thresholds": "auto"`), the checkpoint schedule scales with the model's context window (`src/checkpoint.ts:defaultThresholdsFor`):

| Context window | Checkpoint every |
|---------------|-----------------|
| ≤ 200K | 20% (schedule: 20, 40, 60, 80) |
| 200K–500K | 10% (schedule: 10, 20, 30, 40, 50, 60, 70, 80, 90) |
| > 500K | 5% (schedule: 5, 10, ..., 95) |

Pin a flat array like `[20, 40, 60, 80]` in `config.json` to opt out of auto-scaling.

### Q: How do I debug the extension?

1. **Check the log:** `~/.pi/cme/logs/extension.log` records every operation, failure, and background pass.
2. **Run `/memory status`** — shows index counts, history rows, DB size, last dream/distill times, and exact file paths.
3. **Run `/memory preview`** — dumps the exact system-prompt appendix + rebuild dump text.
4. **Run `/memory metrics`** — shows the checkpoint writer's token cost per run, with the "fork best case vs. delta" verdict.
5. **Run `/memory validations`** — shows how each checkpoint scored against the 11-section spec.
6. **Inspect the files directly:** `cat ~/.pi/cme/sessions/<sid>/checkpoint.md`, `cat ~/.pi/cme/projects/<pid>/MEMORY.md`.
7. **Query the DB:** `sqlite3 ~/.pi/cme/memory.db ".tables"` and `SELECT ...` for raw data.

### Q: Can I extend or modify the extension?

Yes. The codebase is designed for modification:

- **Pure modules** (`paths.ts`, `budget.ts`, `config.ts`, `fts.ts`, `actors.ts`, `tasks.ts`, `guard.ts`, `templates.ts`) have no pi imports — testable under `node --test`.
- **Prompts** live in `src/prompts/` as template functions — modify the writer/dream/distill behavior by editing the prompt text.
- **Schema migrations** use `PRAGMA user_version` in `src/db.ts` — add new tables as sequential migration strings.

See `docs/ONBOARDING-DEVS.md` and `docs/design/ARCHITECTURE.md` for the full developer guide.

### Q: What invariants must I preserve?

From `AGENTS.md`, the critical ones:
1. **Markdown files (layers 1–3) are the source of truth.** Any new write path must write markdown, not just the DB.
2. **`safe(name, fn)` wraps every handler** (`src/index.ts:140-160`). A memory failure must never break the host session.
3. **No memory-write tool.** Memory is written via ordinary `write`/`edit` calls, constrained by `guard.ts`.
4. **History rows keyed by `(session_id, seq)`** with synthetic `message_id = "<sid>#<seq>"`.
5. **FTS5 external-content deletes use the magic command:** `INSERT INTO ..._idx(..._idx, rowid, body) VALUES('delete', OLD.id, OLD.body)`, never plain `DELETE FROM` the vtab.
6. **Async UI after `await` uses the `latestCtx` shim**, never a captured `ctx` (pi invalidates ctx after session switch/fork).

---

## For Claude/CLI Users

### Q: What commands are available?

| Command | What it does |
|---------|-------------|
| `/memory` or `/memory status` | Full status report: index counts, history rows, injection overhead, session/project/global paths |
| `/memory search <query>` | BM25 search over all memory files (same search the agent uses on every turn) |
| `/memory preview` | Shows the exact system-prompt appendix + any rebuild dump |
| `/memory system-prompt` | Dumps the full system prompt sent to the LLM (harness + extensions + CME) |
| `/memory system-prompt size` | Shows character and token count of the full system prompt |
| `/memory metrics` | Checkpoint writer cost readout — tokens, cost, fork-vs-delta verdict |
| `/memory validations` | How each checkpoint scored against the 11-section spec (Phase 1 quality log) |
| `/memory clear` | Wipe this project's memory (moves to `trash/` — recoverable). Requires confirmation |
| `/memory dream` / `/dream` | Manual consolidation pass — you watch it tidy memory |
| `/memory distill` / `/distill` | Manual workflow-packaging pass — packages repeated workflows into skills |

Dream and distill auto-runs are **both on by default** (dream weekly, distill monthly). Set `"dream": { "auto": false }` or `"distill": { "auto": false }` in `config.json` to disable.

### Q: What tools does the agent use?

Two tools are registered for the model:

1. **`memory`** — BM25 search over curated memory layers (checkpoints, project MEMORY.md, global MEMORY.md). OR-joined tokens. Top hit always kept; weaker hits dropped below a relative score floor (default 0.15). The agent is instructed to try this **first** before asking the user. Zero hits return an escalation ladder.

2. **`history`** — AND-joined raw conversation search. Filters: scope (project/global), `session_id`, `kind[]`, `tool_name`, `time_after`/`time_before`. Plus `operation=around` (±N rows around a `message_id` from a search hit, output capped at 20KB). Described to the model as the "unindexed firehose" — use only when `memory` returns nothing useful.

There is **no memory-write tool**. The agent writes memory through ordinary `write`/`edit`, constrained by `guard.ts` to only `notes.md` and `MEMORY.md`.

### Q: What signals should I watch for in the UI?

| Signal | Meaning |
|--------|---------|
| `󰍛 12 idx · 240 hist` in footer | Extension alive; 12 memory files indexed, 240 history rows this project |
| `🧠 mimo-cme: memory active — 42 idx · 287 hist` (toast on session start) | Heartbeat — memory pipeline is armed |
| `💾 checkpoint saved — session memory written` | Context crossed a threshold; session snapshotted |
| `🔄 mimo-cme: memory indexed — N indexed` | Search index picked up a file that changed on disk |
| `🌙 mimo-cme: dream consolidation running in background` | Weekly consolidation pass started |
| `🧠 mimo-cme: dream — 3 consolidated, 1 pruned` | Dream finished; entries merged/pruned |
| `📦 / ✨ mimo-cme: distill …` | Workflow-packaging pass ran/created assets |
| `🧠 mimo-cme: session resumed — checkpoint (~8K tok) · notes (~3K tok)` | Memory re-hydrated on resume/fork/compact |

### Q: How does a session flow feel?

1. **Every prompt:** Memory instructions + project/global MEMORY.md + memory keys index are injected. Stable text keeps prompt cache warm.
2. **During session:** Every message is indexed into `history_fts`. When context crosses a threshold (20%/10%/5%), the delta is handed to an in-process writer which updates `checkpoint.md` and `MEMORY.md`.
3. **At 70%/85% usage:** A one-time nudge: "Context is filling up — write important learnings to memory now."
4. **On resume/fork/compact:** A one-shot persistent message — checkpoint + notes + tasks + actors — framed "Resume directly. Do not acknowledge this memory dump."
5. **Across sessions:** Past session JSONLs are backfilled into history (idempotent, fingerprint-gated). Dream/distill auto-runs fire in background when due.

### Q: How do I verify it's working?

1. **Check the footer:** `󰍛 <N> idx · <N> hist` > 0 means indexing is live.
2. **Watch history grow:** Exchange a few messages, run `/memory status` — the history count should increase.
3. **Search what you discussed:** `/memory search <distinctive-term>` — should return non-empty results.
4. **Look at the files:** `ls -R ~/.pi/cme/` — see the project/session/global structure.
5. **Check the logs:** `cat ~/.pi/cme/logs/extension.log` — see checkpoints, backfills, any errors.
6. **Resume a session:** `/clear` and resume — you should see the "session resumed" toast with token counts.

### Q: How do I configure the extension?

Create `~/.pi/cme/config.json`. All fields optional:

```jsonc
{
  "checkpoint": {
    "thresholds": "auto",                  // window-scaled, or [20,40,60,80]
    "scoreFloor": 0.15,                    // BM25 relative score floor (0 = keep all)
    "reconcileOnSearch": true,             // re-scan file tree before each search
    "reconcileDebounceMs": 4000,           // skip re-scan if one ran recently
    "maxWriterFailures": 3,                // give up after N consecutive failures
    "pushCaps": {
      "checkpoint": 11000, "memory": 10000, "global": 6000,
      "notes": 6000, "memoryKeys": 500, "actors": 2000, "tasks": 2000
    }
  },
  "history": {
    "kinds": ["user_text", "assistant_text", "tool_input", "tool_error"]
    // add "reasoning" / "tool_output" to capture more
  },
  "memory": { "ccIndex": false },          // index ~/.claude/projects/*/memory
  "tasks":  { "enabled": true },           // track subagents + rpiv-todo task graph
  "dream":   { "auto": true,  "intervalDays": 7 },
  "distill": { "auto": true, "intervalDays": 30 }
}
```

### Q: Does this slow pi down?

**No.** The per-turn prompt injection is stable text, so the prompt cache stays warm. The checkpoint writer runs as an in-process background session — it doesn't hold up your turn. Dream/distill run in separate background `pi` subprocesses. The per-turn footer reads two integers (no SQL). The reconcile tree walk is debounced and lazy.

### Q: Will it leak secrets between projects?

**No.** Project memory is keyed by `sha256(cwd)[:12]` — a 12-hex hash of the project's absolute path. Different checkouts get separate memory. Only *global* memory (user preferences) is shared, and that's curated conservatively by the dream pass.

### Q: Can I edit memory by hand?

**Yes.** `notes.md` and your project `MEMORY.md` are yours to edit. The next search re-indexes them automatically. `checkpoint.md` is written by the writer — hand-edits may be overwritten on the next checkpoint.

### Q: How do I wipe everything?

1. **Per-project:** `rm -rf ~/.pi/cme/projects/<pid>/` and `~/.pi/cme/sessions/<sid>/`
2. **Full wipe:** `rm -rf ~/.pi/cme/` — the whole memory tree. pi will recreate it on the next session.
3. **Just the index (keep markdown):** `rm ~/.pi/cme/memory.db` — the DB rebuilds from files on the next search.
4. **Safe wipe:** `/memory clear` — moves curated files to `trash/` (recoverable), deletes derived DB rows, previews blast radius first. `--yes` skips the confirm dialog.

### Q: A background pass seems stuck. What do I do?

Check `~/.pi/cme/logs/`. Each pass writes a log file (`dream-<timestamp>.log`, `distill-<timestamp>.log`) with exit code and output. The in-process writer gives up after 3 consecutive failures and logs the reason — restart pi to retry.

---

## For Managers

### Q: What value does this extension provide?

pi-mimo-cme solves the fundamental problem of **AI amnesia in daily coding work**. Without it, every pi session is a fresh start — the agent re-learns your project structure, re-encounters the same bugs, and re-discovers the same decisions. With CME:

- **Knowledge compounds.** Each session builds on the previous one. Architectural decisions, debugging discoveries, and user preferences persist.
- **Engineers save time.** No need to re-explain context, re-state decisions, or ask "remember what we did about X?" — the agent already knows.
- **Onboarding improves.** New team members working through pi sessions benefit from accumulated project memory.
- **Repeated workflows get automated.** The distill pass packages recurring manual sequences into reusable pi skills over time.

### Q: What's the adoption cost?

**Near-zero.** There is no:
- Infrastructure to set up (no server, no database to manage)
- Build step (pi loads TypeScript directly via jiti)
- Runtime dependencies (uses `node:sqlite`, built into Node ≥ 24)
- Configuration beyond a single optional JSON file
- Breaking changes to existing pi workflows

Install is a single symlink or settings.json entry. See `docs/ONBOARDING-USERS.md` §2 for install instructions.

### Q: What are the risks?

| Risk | Mitigation |
|------|-----------|
| Memory failure breaks the session | Every handler is wrapped in `safe()` — failures are logged, shown as a single throttled toast, and swallowed. The session never crashes. |
| Extension causes security issues | The path guard (`guard.ts`) constrains the agent to writing only `notes.md` and `MEMORY.md`. Global memory is read-only for the agent. Project memory is keyed by path hash — no cross-project leakage. |
| Background passes consume resources | The in-process writer is lightweight (one prompt, tool-limited). Dream/distill run as background subprocesses with `--no-extensions --no-session`. |
| Failed checkpoint loses data | Queue depth is 1 (newest wins). After 3 consecutive failures, the writer gives up gracefully and logs. Prior checkpoints are preserved. |
| Subagent/task integration breaks | Both are **soft dependencies** — no `import`, no runtime coupling. If `@tintinweb/pi-subagents` or `@juicesharp/rpiv-todo` are absent, the relevant sections simply stay empty. |

### Q: How does this compare to alternatives?

| Approach | Persistent? | Automatic? | Searchable? | Build step? |
|----------|------------|------------|-------------|-------------|
| **pi-mimo-cme** | ✅ Files + index | ✅ (auto checkpoint, dream, distill) | ✅ (BM25 FTS) | ❌ (zero) |
| Claude Projects memory files | ✅ Manual | ❌ | ❌ (grep only) | ❌ |
| Human notes/wiki | ✅ Manual | ❌ | Varies | ❌ |
| Prompt engineering ("remember that") | ❌ Per-session | ❌ | ❌ | ❌ |

### Q: How should a team adopt this?

1. **Individual engineers** install it via their `~/.pi/agent/settings.json` or symlink.
2. **Per-project** adoption: add the path to `.pi/settings.json` in the project repo so everyone on the project gets it.
3. **Set `"distill": { "auto": false }`** initially if you want to review what assets it would create before enabling auto-packaging.
4. **Monitor `extension.log`** during the first week to confirm checkpoints and dream passes are running.
5. **Review `/memory validations`** after a few sessions to understand checkpoint quality before enabling any enforcement (Phase 2).

---

## For Financial Traders

### Q: How can a trading team use cross-session memory?

Trading system development involves iterating on strategies, debugging production issues, and maintaining complex run books — exactly the kind of work where cross-session memory shines:

- **Strategy iteration:** The agent remembers your backtesting framework, parameter conventions, and data pipeline. Every session doesn't start from scratch explaining "we use vectorbt with 1-hour bars and a 20/50 EMA crossover as baseline."
- **Production post-mortems:** When a trading algorithm behaves unexpectedly, the agent can reference past sessions for context — previous parameter changes, known edge cases, and historical data quirks.
- **Run book persistence:** Configuration steps for data feeds, exchange API keys, and deployment targets can live in `MEMORY.md` rules. No more re-googling the same "how to restart the websocket adapter" every month.

### Q: Can it track trading algorithm evolution?

Yes. The **dream** consolidation pass is particularly useful here. It reviews all recent sessions, extracts durable facts (what worked, what didn't, parameter ranges to avoid), and writes them into `MEMORY.md`. Over weeks, the project memory becomes a living knowledge base of your strategy development:

```
## Architecture decisions
- Switched from SMA to Z-score mean reversion signals (2026-05-15) [ses_abc]
- Walk-forward validation window set to 6 months minimum (2026-05-22) [ses_def]

## Discovered durable knowledge
- Live data feed latency averages 200ms during US open — factor into position sizing [ses_ghi]
- TP/SL ratio of 2.5:1 performs better than 2:1 on hourly BTC-USD (backtested 2026-01 to 2026-05) [ses_jkl]
```

### Q: How does it handle sensitive trading data?

The path guard (`src/guard.ts`) prevents the agent from writing trading secrets, API keys, or production connection strings into global memory (which is shared across projects). Project memory is isolated by path hash — your `~/trading/strategies/` and `~/webapp/` get separate memory buckets. The **exact-form constraint** in the writer prompt tells the agent to preserve literal values (DSNs, ports, flags) verbatim in the appropriate section.

### Q: Can I run it in a headless/automated pipeline?

Yes. The extension works in all pi modes. The `-p` (prompt) mode skips UI toast notifications but still processes everything. Background passes log to `~/.pi/cme/logs/`. The `--yes` flag on `/memory clear` is required for headless operation. Use `showReadout` in commands to send structured output.

### Q: What about data retention?

The history index (`history_fts`) grows unboundedly by default. Future improvements include an opt-in retention prune (`docs/plans/SCALING-RETENTION-PLAN.md`). For now:

- `memory.db` can be safely deleted — curated memory (layers 1–3) survives in Markdown files.
- Old session JSONLs under `~/.pi/agent/sessions/` can be manually pruned.
- The `meta` table tracks checkpoint progress and auto-pass timestamps — resetting `meta` just means the next dream/distill runs on the next session start.

---

## Troubleshooting

### Q: I don't see the `🧠` footer.

The extension may not have loaded, or you're in a non-interactive mode (`-p`, JSON output). Check:
1. **Install method:** Did you symlink into `~/.pi/agent/extensions/`, add to `settings.json`, or use `-e`?
2. **Node version:** Node ≥ 24 required for `node:sqlite`.
3. **Log file:** `cat ~/.pi/cme/logs/extension.log` — any load errors appear here.
4. **`PI_MIMO_CME_CHILD`:** If this env var is `1`, the factory returns immediately (subprocess guard). Unset it for interactive sessions.

### Q: Checkpoints aren't firing.

1. Run a longer session — 10+ turns. Auto thresholds fire at specific context percentages (20/40/60/80 by default for ≤200K window).
2. Check `extension.log` for "giving up" messages (3 consecutive writer failures).
3. Verify the writer's model/auth: `getContextUsage()` must return `percent` for thresholds to work.
4. Run `/memory metrics` to see if writer runs are being recorded at all.

### Q: Dream/distill isn't auto-running.

The interval clock starts on the **first sighting** of a project. If the project is brand new:
- Dream won't fire for 7 days (default interval).
- Distill won't fire for 30 days (default interval).

Check `last_dream_at:<pid>` in the meta table:
```sh
sqlite3 ~/.pi/cme/memory.db "SELECT * FROM meta WHERE key LIKE '%dream%' OR key LIKE '%distill%';"
```

Run manually with `/dream` or `/distill` to force a pass.

### Q: Search finds nothing.

1. **Check index counts:** `/memory status` — if `idx` is 0, no files have been indexed yet.
2. **Not enough history:** Early in a session, only history is searchable. After a checkpoint, curated files appear.
3. **Tokens too specific:** BM25 OR-joins tokens. Try fewer or rarer terms.
4. **Score floor:** Default `0.15` drops weak hits. Set `"scoreFloor": 0` in config to keep everything.
5. **Reconcile not running:** Ensure `"reconcileOnSearch": true` in config (default).

### Q: How do I read the `extension.log`?

```sh
cat ~/.pi/cme/logs/extension.log
```

Lines are timestamped `[YYYY-MM-DDTHH:MM:SS.sssZ]`. Look for:
- `checkpoint: writer ok` — successful checkpoints
- `checkpoint: writer failed` — writer failures (with error details)
- `checkpoint: giving up` — 3 consecutive failures
- `actor *: wrote *` — subagent ledger updates
- `dream:` / `distill:` — background pass lifecycle
- `backfill:` — session JSONL backfill stats
- `* failed:` — any non-fatal error the `safe()` wrapper caught

### Q: I need to see exactly what the agent receives every turn.

Two options:
- **`/memory preview`** — shows only CME's contribution (system-prompt appendix + rebuild dump).
- **`/memory system-prompt`** — shows the **full** system prompt: pi's harness prompt + context files + skills + CME's appendix + any other extensions. This is the complete picture of what the LLM sees.

---

## Technical Reference

### Key files

| File | Purpose |
|------|---------|
| `~/.pi/cme/config.json` | User configuration (all optional) |
| `~/.pi/cme/memory.db` | SQLite database (derived index + layer 4) |
| `~/.pi/cme/global/MEMORY.md` | Global memory — user preferences, all projects |
| `~/.pi/cme/projects/<pid>/MEMORY.md` | Project memory — rules, architecture, durable knowledge |
| `~/.pi/cme/sessions/<sid>/checkpoint.md` | Session checkpoint — 11 sections |
| `~/.pi/cme/sessions/<sid>/notes.md` | Session scratchpad — agent's free-form notes |
| `~/.pi/cme/logs/extension.log` | Main extension log |
| `~/.pi/cme/logs/dream-<ts>.log` | Dream pass log |
| `~/.pi/cme/logs/distill-<ts>.log` | Distill pass log |

### Source code quick reference

| Query | File |
|-------|------|
| Extension factory (entry point) | `src/index.ts:57` |
| Config loading + defaults | `src/config.ts:5` |
| Path resolution (memory root, pid, sid) | `src/paths.ts:1` |
| SQLite schema + migrations | `src/db.ts:14-130` |
| BM25 search (memory + history) | `src/fts.ts:1` |
| File tree reconcile (lazy) | `src/reconcile.ts:1` |
| Writer prompt template | `src/prompts/checkpoint-writer.ts:1` |
| Dream prompt template | `src/prompts/dream.ts:1` |
| Distill prompt template | `src/prompts/distill.ts:1` |
| Path guard (memory write validation) | `src/guard.ts:1` |
| History indexing (per-turn + backfill) | `src/history.ts:1` |
| Checkpoint manager (thresholds, queue) | `src/checkpoint.ts:1` |
| System prompt injection | `src/inject.ts:1` |
| Subagent actor ledger | `src/actors.ts:1` |
| rpiv-todo task graph reader | `src/tasks.ts:1` |
| `/memory clear` (two-phase wipe) | `src/clear.ts:1` |

### Key docs

| Document | Audience |
|----------|----------|
| `README.md` | Everyone — overview, config, session flow, divergences from MiMoCode |
| `AGENTS.md` | Developers — invariants, gotchas, module structure |
| `docs/ONBOARDING-USERS.md` | Users — install, verify, use day-to-day |
| `docs/ONBOARDING-DEVS.md` | Developers — module-by-module detail, event wiring |
| `docs/design/ARCHITECTURE.md` | Developers — high-level architecture, module map |
| `docs/design/SPEC.md` | Developers — build spec (section numbers cited in code) |
| `docs/VISIBILITY-PLAN.md` | Everyone — visibility gaps and what signals to expect |
| `docs/research/mimo-memory-system.md` | Developers — MiMoCode's verbatim prompts and schemas |
| `docs/FUTURE-IMPROVEMENTS.md` | Everyone — deferred work, gates, design decisions |

---

*This FAQ was generated from analysis of the pi-mimo-cme codebase at commit on `main` branch. For the most up-to-date information, refer to the source files linked above.*
