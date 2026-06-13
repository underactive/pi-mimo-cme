
## What this is

`pi-mimo-cme` is an **extension for the [pi](https://pi.dev) coding agent** (not a standalone app) that re-implements
[MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code)'s cross-session memory system. The default export of
`src/index.ts` is the extension factory `piMimoCme(pi)`; pi loads the TypeScript directly via **jiti** (no build step).

The pi package is published as **`@earendil-works/pi-coding-agent`** (NOT `@mariozechner/pi`); all extension types
import from it. Pinned to **v0.79.1** — its `types.d.ts`, `docs/`, and ~80 bundled examples are the API ground truth.

## Authoritative in-repo docs (read before large changes)

- `docs/ONBOARDING-DEVS.md` — the developer/agent guide: module-by-module detail, event wiring, invariants, with
  Mermaid diagrams. **Start here when modifying the extension.**
- `docs/ONBOARDING-USERS.md` — what the system does from a user's perspective.
- `design/SPEC.md` — the build spec (section numbers cited in comments).
- `design/ARCHITECTURE.md` — the high-level architecture of the extension, including how the memory pipeline,
  handlers, and pi integration fit together.
- `research/mimo-memory-system.md` — MiMoCode's schemas and **verbatim prompts** (the source the checkpoint/dream/
  distill prompts were adapted from). The **"how it works"** reference.
- `research/opencode-mimocode-fork-delta.md` — the **structural diff** between upstream OpenCode and the MiMoCode
  fork: which dirs/files/migrations/hooks are MiMoCode inventions vs inherited OpenCode, the ~8 session-loop
  integration seams, and a symptom→reference table. **The "what changed from upstream / debugging baseline" reference.**
- `research/pi-extension-api.md` — the pi v0.79.x extension API and its gotcha checklist.


The README documents the user-facing config (`config.json`), tools, session flow, and the deliberate divergences from
MiMoCode.

## Commands

Requires **Node ≥ 24** (uses `node:sqlite` with FTS5/bm25, and runs `.ts` directly via Node's native type-stripping).

```sh
npm install            # dev deps only — there are no runtime dependencies
npm run typecheck      # tsc --noEmit  (type-check only; nothing is emitted/bundled)
npm test               # node --test 'test/*.test.ts'  — runs over raw TS via type-stripping
node --test test/reconcile.test.ts   # run a single test file
pi -e ./src/index.ts   # load the extension live in a one-off pi session (manual smoke test)
```

There is **no build, lint, or bundle step.** Tests cover the pure / pure-ish modules only (the `pi`-coupled wiring in
`index.ts` is exercised by manual `pi -e` smoke tests, not unit tests).

## Invariants & gotchas that will bite you

- **Erasable TypeScript only.** Node 24 type-strips `src/` and `test/` at runtime, so **no enums, namespaces, or
  parameter-properties** (`tsconfig` sets `erasableSyntaxOnly`). Use `import type` for type-only imports.
- **`safe(name, fn)` wraps every handler** (SPEC §9.5): a memory failure must never break the host session. It logs to
  `pi-mimo-cme/logs/extension.log`, shows at most one throttled toast (60s window), and swallows the error. Keep new
  handlers inside this wrapper.
- **Recursion guards differ by worker.** The checkpoint **writer** runs in-process (`runWriter` in `index.ts`): its
  session is built with `DefaultResourceLoader({ noExtensions: true })`, so pi-mimo-cme never binds to it — that is
  what stops it recursing or tripping our own path guard / history indexer / `turn_end` thresholds (the
  `PI_MIMO_CME_CHILD` env belt only stops *subprocesses*, and in-process that var is unset). It uses
  `SessionManager.inMemory()`, so no session JSONL is persisted (nothing for the layer-4 backfill to re-index). Model
  + auth come from the live `ctx` via the `latestCtx` shim, never a captured ctx. **Dream/distill** still run as
  subprocesses (`pi --no-extensions --no-session -p` with `PI_MIMO_CME_CHILD=1`, set via `/usr/bin/env` because pi's
  `ExecOptions` has no `env` field); the factory returns immediately when it sees that env var, and `--no-session` is
  mandatory there — else the child's JSONL gets backfilled as layer-4 history (the memory system indexing its own
  transcripts).
- **FTS5 external-content deletes use the magic command:** `INSERT INTO ..._idx(..._idx, rowid, body) VALUES('delete',
  OLD.id, OLD.body)`, **never a plain `DELETE FROM` the vtab** (that's contentless-mode syntax; misapplied here it
  leaks tokens until the vtab corrupts). See the preserved war-story comment in `db.ts`. The `_ai`/`_ad`/`_au` triggers
  already do this correctly — match the pattern for any new FTS table.
- **Async UI after `await` uses the `latestCtx` shim, never a captured `ctx`.** The writer/dream/distill results
  resolve outside any handler scope, and pi invalidates a `ctx` once the user switches/forks the session. Post-await
  code must use the live `notify` shim for UI and a plain captured `cwd` string for project identity.
- **`before_agent_start` chains:** multiple handlers may register; each returns its own `{ systemPrompt }` /
  `{ message }`. **Always append** to `event.systemPrompt` (`event.systemPrompt + "\n\n" + appendix`), never replace.
- **No memory-write tool.** Memory is written via ordinary `write`/`edit` calls; `guard.ts` (wired on `tool_call`)
  blocks everything under the memory root except `sessions/<sid>/notes.md` and `projects/<pid>/MEMORY.md`.