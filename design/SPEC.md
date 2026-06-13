# pi-mimo-cme — Design Specification

A Pi (pi.dev) extension implementing MiMoCode's cross-session memory system, organized
around MiMoCode's three principles:

- **Computation** — single-turn decision quality: give the model the right memory at the
  right time (system-prompt injection, BM25 recall tools, escalation ladder).
- **Memory** — multi-turn continuity: notes scratchpad, threshold-driven checkpoints,
  compaction-survival injection.
- **Evolution** — cross-session improvement: dream (consolidate, 7d) and distill
  (workflow packaging, 30d) passes.

Authoritative references (READ BOTH BEFORE WRITING CODE):
- `research/mimo-memory-system.md` — what to build (schemas, templates, prompts — copy
  the verbatim artifacts from here, adapted only where noted below).
- `research/pi-extension-api.md` — how to build it on Pi v0.79.1 (exact API signatures,
  gotchas checklist §12, skeleton example §11).

Hierarchy principle (from MiMoCode): "the upper layers are more refined, more persistent,
and smaller; the lower layers are more complete, larger, and slower."

---

## 1. Storage layout

Root: `path.join(getAgentDir(), "memory")` → `~/.pi/agent/pi-mimo-cme/` (respects
`PI_CODING_AGENT_DIR`).

```
~/.pi/agent/pi-mimo-cme/
├── memory.db                      # SQLite: FTS index over files + history layer + meta
├── config.json                    # optional user overrides (see §8)
├── logs/                          # headless writer/dream/distill run logs
├── global/MEMORY.md               # layer 3
├── projects/<pid>/MEMORY.md       # layer 2; pid = sha256(absolute cwd hex)[:12]
└── sessions/<sid>/                # layer 1; sid = ctx.sessionManager.getSessionId()
    ├── checkpoint.md              # 11 sections — written ONLY by the in-process writer session
    └── notes.md                   # main agent's only legal scratchpad, append-only
```

Layers 1–3 are markdown files = source of truth. The DB is a derived index plus the
native layer-4 history store. Deleting memory.db must lose no curated memory.

## 2. SQLite schema (node:sqlite, DatabaseSync)

Copy MiMoCode's final-form schema verbatim from research §3 (memory_fts + memory_fts_idx,
history_fts + history_fts_idx):
- external-content FTS5 (`content='...'`, `content_rowid='id'`),
  `tokenize='unicode61 remove_diacritics 1'`
- AFTER INSERT/DELETE/UPDATE triggers using the **`('delete', rowid, body)` command form**
  (plain DELETE corrupts the vtab — preserve MiMoCode's war-story comment in our schema).
- `memory_fts.fingerprint` = `"${size}-${mtimeMs}"`.
- history_fts columns per research §3.2; `kind` ∈ user_text | assistant_text | tool_input
  | tool_error | reasoning | tool_output. Default indexed kinds: first four.
- Add a `meta(key TEXT PRIMARY KEY, value TEXT)` table for: per-session
  `last_checkpoint_seq:<sid>`, crossed-thresholds, `last_dream_at:<pid>`,
  `last_distill_at:<pid>`, backfill file fingerprints (`backfill:<file>` = size-mtime).
- Schema versioning: `PRAGMA user_version`; simple sequential migrations.

`scope` ∈ `global | projects | sessions | cc`. `type` detected from key by regex like
MiMoCode (`memory*`→memory, `checkpoint*`→checkpoint, `notes*`→notes, else `free`); `cc`
scope reads `metadata.type` from YAML frontmatter (feedback/project/reference/user).

## 3. Computation — read path

### 3.1 System prompt injection (`before_agent_start`, every prompt)

Append to `event.systemPrompt` (return `{ systemPrompt: event.systemPrompt + ... }`,
never replace — chaining rule):

1. **Memory-system instructions** — adapt MiMoCode's `buildMemoryInstructions` (research
   §7) with pi paths substituted. Keep: the four-layer description with absolute paths,
   "When to Edit MEMORY.md directly", the notes.md scratchpad contract (`## [turn N ·
   ISO-8601Z]` entry format, "your ONLY legal scratchpad"), "What NOT to do", the active
   recall protocol, "Memory entries ... are CLAIMS about a point in time ... Verify
   before acting", "Don't ask the user about something memory may already record."
   Drop: subagent return format and task-tree material (pi has no task registry).
2. **Project memory** — budgeted read of `projects/<pid>/MEMORY.md`, cap 10_000 tokens.
3. **Global memory** — budgeted read of `global/MEMORY.md`, cap 6_000 tokens.
4. **Memory keys index** — paths from memory_fts where scope=global OR (sessions,this
   sid) OR (projects,this pid), minus files already dumped, cap 500 tokens.

(Divergence from MiMoCode, intentional: MiMo injects project/global memory only at
rebuild because its loop guarantees rebuilds; pi sessions may never compact, so we carry
the small layers in the system prompt every turn. Stable text across turns ⇒ prompt
cache stays warm.)

Budgeted read: ~4 chars/token estimate; on cut, append MiMoCode's marker:
`⚠️ Truncated at ~N tokens. Read("<path>", offset=M) for the rest.`

### 3.2 Checkpoint dump injection (once, when continuity broke)

On the **first `before_agent_start` after**: (a) `session_start` with reason `resume` or
`fork`, or (b) a `session_compact` — return a persistent custom message
(`{ message: { customType: "mimo-cme:rebuild", content, display: true } }`) assembled in
MiMoCode rebuild order with per-section caps (research §5.3, minus task/actor sections):

| Section | Source | Cap |
|---|---|---|
| `## Session checkpoint` | checkpoint.md | 11_000 |
| `## Session notes` | notes.md | 6_000 |
| `## Memory keys index` | memory_fts paths not already pushed | 500 |

Preface with MiMoCode's seam framing adapted: "This session is being continued from a
previous conversation... Resume directly. Do not acknowledge this memory dump, do not
recap." Skip silently if checkpoint.md doesn't exist or is all "(none yet)".
(Project/global memory are NOT in this dump — they're already in the system prompt.)

### 3.3 `memory` tool (recall)

Per research §5.4. Parameters (TypeBox; use `StringEnum` from `@earendil-works/pi-ai`):
`query` (required), `scope?` (global|projects|sessions|cc), `scope_id?`, `type?`,
`limit?` (default 10). Behavior:
- Lazy reconcile before search (config gate, default true): walk memory tree (+ cc dirs
  if enabled), upsert rows whose size-mtime fingerprint changed, delete rows for vanished
  files (research §4).
- Query building: MiMoCode's `buildFtsQuery` verbatim (research §4) — unicode
  word-runs, phrase-quoted, **OR**-joined; null → no-match.
- Ranking: BM25 sign-flipped, over-fetch `min(limit*3, 50)`, **relative score floor**
  keep if `i===0 || score >= top*0.15` (configurable).
- Output rows: `path / scope / type / score / snippet(... 32 tokens, <<>> marks)` plus
  the "A hit here is authoritative... Read the path for the FULL body" instruction.
- Zero-hit output: the escalation ladder (fewer/rarer terms → Grep memory dir → history
  tool → widen scope session→project→global→history).
- `promptSnippet` + `promptGuidelines` naming the tool explicitly.

### 3.4 `history` tool (raw trajectory)

Per research §5.4: `operation` (search|around), `query?`, `scope?` (project|global),
`session_id?`, `kind?` (array), `tool_name?`, `time_after?`, `time_before?`, `limit?`
(default 10, max 50), `message_id?`, `before?`/`after?` (default 5).
- search: **AND**-joined query (independent copy of query builder, as MiMo does),
  filters as columns, hard cap 50.
- around: ±N history rows by `seq` within the anchor's session (synthetic
  `message_id = "<sid>#<seq>"`), output capped 20KB, overflow note.
- Tool description: MiMoCode's verbatim header ("USE ONLY WHEN MEMORY SEARCH RETURNS
  NOTHING USEFUL... memory is your curated notebook... history is the unindexed
  firehose...").

## 4. Memory — write path

### 4.1 Continuous history indexing (`message_end`)

- user → kind `user_text` (handle `string | parts[]` content).
- assistant → text parts joined → `assistant_text`; each toolCall part → `tool_input`
  (`tool_name` + JSON.stringify(input) preview ≤2KB).
- toolResult with `isError` → `tool_error` (and `tool_output` only if opted in).
- Skip custom/bash/branch-summary roles. Maintain per-session `seq` counter.
- **Backfill** on `session_start` (background, idempotent): parse current project's
  session JSONL files (`~/.pi/agent/sessions/<escaped-cwd>/*.jsonl`), skip files whose
  size-mtime fingerprint matches `meta`, batch inserts in a transaction.

### 4.2 notes.md (main agent, taught not enforced-by-code)

Created from MiMoCode's template verbatim (research §6) on session first-write. The
system prompt teaches the append contract. Guard (§4.4) allows it.

### 4.3 Checkpoint writer (threshold-driven, in-process)

- On `turn_end`: read `ctx.getContextUsage()` (inspect the real `ContextUsage` type in
  `<pkg>/dist/core/extensions/types.d.ts`). Thresholds default `[20,40,60,80]` percent
  (window-size-dependent tiers like MiMo are overkill here; keep flat default,
  configurable). Track crossed set per session in memory + meta. On first crossing:
  1. Serialize the conversation **delta** (entries after `last_checkpoint_seq`) from
     `ctx.sessionManager.getBranch()` — role-labeled markdown; tool calls condensed to
     `tool(name): <input ≤500 chars>`; tool results ≤500 chars; cap the inlined delta
     text ~100KB (`DELTA_CAP`, truncate head, keep tail). The delta is carried **inline**
     in the writer prompt, not written to disk.
  2. Ensure checkpoint.md / MEMORY.md / notes.md exist from templates (research §6
     verbatim: 11 sections with italic instruction lines, 4-section MEMORY.md, notes
     template).
  3. Run **one at a time** (queue depth 1, newest wins) via the injected `runWriter`
     dependency: an **in-process pi SDK session** (`createAgentSession` with
     `model`/`modelRegistry` from the live ctx, `tools: ["read","write","edit"]`, a
     `DefaultResourceLoader({ noExtensions: true, ... })`, and
     `SessionManager.inMemory(cwd)`), then `await session.prompt(prompt)` and
     `session.dispose()`. Writer prompt = MiMoCode's checkpoint-writer prompt
     (research §8.1) adapted: absolute-path table (CHECKPOINT_PATH / MEMORY_PATH /
     NOTES_PATH "USE THESE VERBATIM"); the conversation source is the delta inlined
     between `===== BEGIN CONVERSATION DELTA =====` / `===== END CONVERSATION DELTA =====`
     markers at the end of the prompt instead of live history (no tool needed to obtain
     it); drop §4 task-tree machinery and SUBAGENT PROGRESS blocks (render §4 as
     "(no task registry)"); keep all 11 sections, the §1 verbatim-quote anchor,
     COMMITMENT vs INSPECTION rule, EXACT-FORM CONSTRAINT LITERAL rule, section budgets
     `{{SECTION_BUDGETS}}` substituted (research §6 budgets), spillover-extraction rule,
     notes.md wipe-to-template rule.
  4. On success (writer mirrors pi's print mode: no thrown error and a final assistant
     message whose `stopReason` is not `error`/`aborted` — the writer is told to stay
     silent after its Edits, so non-empty final text is NOT required): advance
     `last_checkpoint_seq`, log to `logs/`. On failure: log, give up after 3 consecutive
     failures (like MiMo).
- Also fire (best-effort, fire-and-forget) in `session_before_compact` so state is
  captured before pi compacts — inspect that event's type first; if it can be awaited,
  await with a hard timeout (~60s like MiMo's rebuild wait).
- **Memory-flush nudge**: when usage ≥70% and ≥85%, inject once per level via
  `before_agent_start` message: MiMoCode's "Context is filling up..." reminder text.
- Recursion guard: the in-process writer session never binds pi-mimo-cme because its
  `DefaultResourceLoader({ noExtensions: true })` loads zero extensions, and
  `SessionManager.inMemory()` writes no JSONL (so the layer-4 backfill can't index a
  writer transcript — this replaces the writer's old `--no-session` flag). The factory's
  `process.env.PI_MIMO_CME_CHILD === "1"` early-return guard now applies ONLY to the
  dream/distill subprocesses (§5).

### 4.4 Path guard (`tool_call` event)

Adapt MiMoCode's memory-path-guard: intercept `write` / `edit` tool calls whose resolved
path is under the memory root; allow ONLY (a) `sessions/<current sid>/notes.md`,
(b) `projects/<current pid>/MEMORY.md`; block everything else (checkpoint.md, global
MEMORY.md, other sessions/projects) with `{ block: true, reason }` quoting MiMoCode's
rules ("checkpoint.md is the writer's domain", "no learning.md, no scratch.md — use
notes.md"). Use `isToolCallEventType` guards. The in-process writer session (no
extensions loaded) and the dream/distill subprocesses run without the extension, so they
are unaffected.

## 5. Evolution

### 5.1 Dream (consolidation, default auto every 7 days)

Prompt: MiMoCode's dream.txt (research §8.2) adapted — `<DATA>` paths → our memory root;
trajectory DB → our `memory.db` with **our** history_fts schema documented in the prompt
(the Phase-3 SQL templates rewritten for `history(seq, session_id, project_id, kind,
tool_name, body, time_created)` — read-only, query via `sqlite3` CLI in bash); keep all
ground rules, phases, keyword lists, the 200-line/10KB cap, `[unverified]` marks,
`[ses_xxx]` provenance, "merge duplicates instead of appending", absolute dates.

- Auto: on `session_start` (reason startup|new), if project has history and
  `now - last_dream_at >= 7d` (meta), spawn background
  `pi --no-extensions -p "<dream prompt>"` (env guard set), update `last_dream_at`,
  `ctx.ui.notify("🌙 mimo-cme: dream consolidation running in background", "info")`,
  log output to `logs/`.
- Manual `/dream`: `pi.sendUserMessage(<dream prompt>)` in the current session
  (MiMoCode: "This command is manual. The user intentionally started it and is
  watching.").

### 5.2 Distill (workflow packaging, default auto **off** — divergence, noted in README)

Same dual mode with MiMoCode's distill.txt structure (research §8.3): inventory existing
assets under `~/.pi/agent/skills/`, `~/.pi/agent/extensions/`, project `.pi/`; "at least
twice or clearly likely to recur"; smallest-form ladder retargeted to pi assets (pi
skills / slash commands as extensions / playbook in MEMORY.md ## Patterns); "Created
nothing ... is a complete, successful result". Interval 30d. Manual `/distill`.

### 5.3 Promotion ladder & forgetting

Encoded in prompts, not code (faithful to MiMo): notes → checkpoint §7/§10 → project
MEMORY.md → global MEMORY.md / skills. No algorithmic decay — LLM-judged forgetting
under hard size budgets (validators are out of scope for v1; the writer prompt's budget
text + dream's prune phase carry the pressure).

## 6. Commands & UI

- `/memory` — no args: status (counts per layer/scope from DB, db size, last dream/
  distill, current sid/pid paths) via `ctx.ui.notify` or a dumped text message;
  `search <q>`: run the same search, notify top hits. Argument completions for
  `search|status|dream|distill`.
- `/dream`, `/distill` — manual evolution passes (§5).
- `ctx.ui.setStatus("mimo-cme", ...)` on session_start: e.g. `🧠 <n> memories` (guard
  `ctx.hasUI`).

## 7. Module plan

```
package.json        # name pi-mimo-cme; "pi": {"extensions": ["./src/index.ts"]};
                    # devDeps: @earendil-works/pi-coding-agent@0.79.1, typebox; NO runtime deps
tsconfig.json       # types-only checking; erasableSyntaxOnly so `node` runs files directly
src/index.ts        # factory: env guard, open DB, wire events/tools/commands, close on session_shutdown
src/config.ts       # defaults + config.json overlay (see §8)
src/paths.ts        # memory root, pid/sid resolution, layer paths, type-from-key regex
src/db.ts           # open/migrate (user_version), schema SQL, meta helpers
src/fts.ts          # buildFtsQuery (OR + AND variants), memorySearch (floor), historySearch/around
src/reconcile.ts    # tree walk + fingerprint upsert/prune (+ cc scope when enabled)
src/budget.ts       # token estimate, budgetedRead with truncation marker
src/templates.ts    # checkpoint/MEMORY/notes templates + section budgets (verbatim from research §6)
src/inject.ts       # system-prompt assembly + rebuild dump assembly
src/history.ts      # message_end indexing, seq counters, JSONL backfill
src/checkpoint.ts   # usage thresholds, delta serialization, in-process writer (runWriter dep), nudges
src/guard.ts        # tool_call path guard
src/tools.ts        # memory + history tool definitions
src/commands.ts     # /memory /dream /distill
src/prompts/checkpoint-writer.ts  # adapted prompt as exported template fn
src/prompts/dream.ts
src/prompts/distill.ts
test/*.test.ts      # node:test, runs with plain `node --test` (erasable TS)
README.md           # what/why, CME mapping, four layers, install, config, divergences from MiMoCode
```

## 8. Config (`~/.pi/agent/pi-mimo-cme/config.json`, all optional)

```jsonc
{
  "checkpoint": { "thresholds": [20, 40, 60, 80], "scoreFloor": 0.15,
                  "reconcileOnSearch": true, "maxWriterFailures": 3,
                  "pushCaps": { "checkpoint": 11000, "memory": 10000, "global": 6000,
                                 "notes": 6000, "memoryKeys": 500 } },
  "history": { "kinds": ["user_text", "assistant_text", "tool_input", "tool_error"] },
  "memory":  { "ccIndex": false },     // index ~/.claude/projects/*/memory as scope "cc"
  "dream":   { "auto": true,  "intervalDays": 7 },
  "distill": { "auto": false, "intervalDays": 30 }
}
```

## 9. Engineering constraints

1. **Erasable TypeScript only** (no enums/namespaces/parameter-properties) so Node 24
   type-stripping runs src and tests directly; pi loads via jiti either way.
2. Honor every item in research §12 gotchas: imports from `@earendil-works/pi-coding-agent`,
   DB close in `session_shutdown` + open in factory, systemPrompt chaining, FTS MATCH
   sanitization, sequential `executionMode` on the memory tool is unnecessary
   (DatabaseSync is sync) but set it anyway for write-ordering clarity, truncate tool
   output, throw-to-fail, ExperimentalWarning is cosmetic, StringEnum for enums.
3. All DB writes in transactions where multi-statement.
4. Never delete user markdown except notes.md wipe-by-writer (which is prompt-driven,
   performed by the in-process writer session, not our code).
5. Failure posture: memory failures must never break the session — wrap event handlers
   in try/catch, log to `logs/extension.log`, `ctx.ui.notify` on first error only.

## 10. Acceptance checks (builder must run all)

1. `npx tsc --noEmit` clean.
2. `node --test test/` green: cover buildFtsQuery (OR/AND, punctuation, CJK-ish, empty),
   score floor, fingerprint reconcile (add/change/delete file), history kind extraction,
   around-windowing, budgetedRead truncation marker, path guard allow/deny matrix,
   pid hashing, delta serialization caps. Use temp dirs (`fs.mkdtempSync`) and
   `PI_CODING_AGENT_DIR` override so tests never touch the real `~/.pi`.
3. Smoke (real pi, cheap): `PI_CODING_AGENT_DIR=$(mktemp -d) pi --no-extensions -e ./src/index.ts -p "Reply with exactly: ok"`
   exits 0; then a second run asking the model to call the memory tool
   (e.g. `-p "Call the memory tool with query 'anything' and report its output"`)
   to prove tool registration + FTS round-trip. If pi auth/model is unavailable, report
   that instead of faking it.
4. Verify schema by inspecting the temp DB with `sqlite3` after the smoke run.
