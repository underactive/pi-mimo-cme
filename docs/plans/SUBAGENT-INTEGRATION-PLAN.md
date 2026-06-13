# Subagent integration plan — in-process writer + tasks/actor layer

Research + plan for three related questions raised against divergences **#5 (subprocess
writer)** and **#6 (no task registry)** in `README.md`:

1. Can we make `@tintinweb/pi-subagents` a required dependency (like `@juicesharp/rpiv-pi`
   does) and run the checkpoint writer as an **in-process subagent**?
2. Does that fix the consequence *"no prefix-cache reuse; the delta is condensed and fed
   as a file"*?
3. Does it fix *"headless pi has no access to parent session state"* (`checkpoint.ts`
   `fireCheckpoint`, lines 182–222)?
4. Can we re-introduce the dropped **tasks/ layer** (task/actor registry, progress memory
   type)?

The short version: **the premise that pi can't spawn in-process is outdated**, the
prefix-cache win is **mostly a myth** for this use case, the parent-state limitation is
**genuinely fixable**, and the tasks layer is **fixable but is a separate, larger piece of
work** that is the *real* reason to depend on pi-subagents.

---

## 0. Premise correction (read this first)

The divergence text in `README.md` §5 says *"pi has no subagent machinery."* That was true
when written but is **false on pi v0.79.1**. The package we already depend on,
`@earendil-works/pi-coding-agent`, exports the full in-process session SDK:

```
createAgentSession, createAgentSessionFromServices, AgentSession,
SessionManager (+ .inMemory()), DefaultResourceLoader,
createReadTool, createWriteTool, createEditTool, createBashTool,
createCodingTools, createReadOnlyTools
                                        — dist/index.d.ts lines 3, 15, 16, 17
```

`@tintinweb/pi-subagents` is a **wrapper** over precisely these primitives
(`agent-runner.ts` calls `createAgentSession({ sessionManager: SessionManager.inMemory(cwd),
resourceLoader: new DefaultResourceLoader(...), tools, model, ... })`). It adds: a registry,
a concurrency queue, a `/agents` widget, completion notifications, worktree isolation,
scheduling, custom agent types, and a cross-extension RPC.

**Consequence:** running the writer in-process needs **zero new dependencies** — just the
SDK we already have. pi-subagents buys us nothing for the *writer* that we can't do
first-party, and it costs us a fork/rename seam (see §5). pi-subagents earns its keep only
for the **tasks layer** (§4), where we observe the *user's* subagents.

---

## 1. How the dependency-requirement mechanism actually works (Q1)

`@juicesharp/rpiv-pi/package.json` declares:

```jsonc
"peerDependencies": {
  "@earendil-works/pi-coding-agent": "*",
  "@tintinweb/pi-subagents": "*",        // <-- the "requirement"
  ...
}
```

When the user runs `pi install npm:@juicesharp/rpiv-pi`, **pi's package manager resolves the
peerDependencies**, so pi-subagents is installed and loaded too. rpiv-pi then talks to it
**purely over `pi.events`** (the cross-extension RPC, §2) — it never `import`s the package.

So "make it a requirement" = **declare `@tintinweb/pi-subagents` in `peerDependencies` and
load via `pi install`**. Two caveats for *this* repo specifically:

- pi-mimo-cme is currently `"private": true`, has **no runtime deps**, and is loaded by a
  **symlink** into `~/.pi/agent/extensions/`, not via `pi install`. A symlinked extension
  doesn't get peerDependency resolution. To make pi-subagents a true hard requirement we'd
  either (a) publish/install pi-mimo-cme as a pi package, or (b) document "also run
  `pi install npm:@tintinweb/pi-subagents`" and **degrade gracefully** when it's absent.
- **Recommendation: make it a *soft* (optional) dependency**, detected at runtime via the
  `subagents:ready` event / `subagents:rpc:ping`. The memory system must never hard-fail
  because an optional collaborator isn't loaded (SPEC §9.5 failure posture). Hard-requiring
  it would regress that.

---

## 2. The pi-subagents cross-extension contract (verified from source)

Everything is over `pi.events`; no import. Reply envelopes: `{success:true,data?}` /
`{success:false,error}`. Protocol version 2.

| Channel | Payload | Reply |
|---|---|---|
| `subagents:ready` (emitted on load) | `{}` | — |
| `subagents:rpc:ping` | `{requestId}` | `data:{version}` |
| `subagents:rpc:spawn` | `{requestId, type, prompt, options}` | `data:{id}` |
| `subagents:rpc:stop` | `{requestId, agentId}` | `data?` |

Lifecycle events we can *observe* (this is the tasks-layer surface, §4):

| Event | Payload |
|---|---|
| `subagents:created` | `{id, type, description, ...}` |
| `subagents:started` | `{id, type, description}` |
| `subagents:completed` | `{id, type, description, result, error, status, toolUses, durationMs, tokens}` |
| `subagents:failed` | same shape as completed |
| `subagents:steered` | `{id, message}` |
| `subagents:compacted` | `{id, type, description, reason, tokensBefore, compactionCount}` |

`spawn` options of interest: `description`, `model` (Model **or** `"provider/modelId"`
string — resolved at the RPC boundary), `maxTurns`, `isolated`, `inheritContext`,
`thinkingLevel`, `isBackground`, `isolation:"worktree"`. **`spawn` returns only the `id`** —
to await a result you subscribe to `subagents:completed|failed` and match on `id`.

Discovery pattern (handles either load order):

```ts
let subagentsReady = false;
pi.events.on("subagents:ready", () => { subagentsReady = true; });
// also ping once at startup in case they loaded before us:
const rid = crypto.randomUUID();
const off = pi.events.on(`subagents:rpc:ping:reply:${rid}`, (r) => {
  off(); if (r.success) subagentsReady = true;
});
pi.events.emit("subagents:rpc:ping", { requestId: rid });
```

---

## 3. The writer: in-process verdicts (Q2, Q3, Q4)

### 3.1 Can the writer run in-process? — **YES**

Two routes:

- **Route A — pi-subagents RPC.** `spawn` a `type:"general-purpose"` (or a custom type)
  with `options.isolated:true`, feeding the writer prompt as `prompt`. **`isolated:true` is
  mandatory** — otherwise `agent-runner.ts` calls `session.bindExtensions()` and **our own
  extension binds to the writer's session**: the path guard would block the writer's
  `checkpoint.md` write, the history indexer would index the writer's transcript, and
  `turn_end` thresholds would recurse. `isolated:true` ⇒ `noExtensions:true` ⇒ no binding,
  which is the in-process equivalent of today's `--no-extensions`.
- **Route B — first-party SDK (recommended).** Build the writer session ourselves:

  ```ts
  import { createAgentSession, SessionManager, DefaultResourceLoader,
           createReadTool, createWriteTool, createEditTool, createBashTool }
    from "@earendil-works/pi-coding-agent";

  const loader = new DefaultResourceLoader({
    cwd, agentDir, noExtensions: true, noSkills: true,
    noContextFiles: true, noPromptTemplates: true,
    systemPromptOverride: () => writerSystemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir,
    sessionManager: SessionManager.inMemory(cwd),   // never persisted → solves --no-session
    settingsManager, modelRegistry: ctx.modelRegistry, model: ctx.model,
    tools: ["read", "write", "edit", "bash"],
    resourceLoader: loader,
  });
  // We do NOT call session.bindExtensions() → our handlers never fire on it.
  await session.prompt(writerTaskPrompt);   // contains delta inline, no temp file
  ```

  **Route B is recommended for the writer** because: no new dependency; same module
  instance as running pi (no fork/rename seam, §5); no `/agents` widget noise or completion
  notifications for what should be a silent memory daemon; full control of tools, prompt,
  and lifecycle; the existing `CheckpointManager` queue (depth-1, newest-wins, `waitForIdle`)
  is reused almost verbatim — we just swap the `exec(...)` call for `session.prompt(...)`.

What in-process **wins**, regardless of route:

- No `node` process startup per checkpoint (hundreds of ms).
- **No `delta-<n>.md` temp file** — the delta is passed in-memory as the prompt string.
- `SessionManager.inMemory()` is never written to disk → **natively solves** the
  `--no-session` concern (today's flag exists only to stop the writer's JSONL from being
  re-indexed by the layer-4 backfill; an in-memory session produces no JSONL).
- One auth/model context (no child re-auth).

What it does **not** lose: the current `pi.exec(...)` is already *awaited*, not detached, so
the writer is already tied to the parent's lifetime — in-process changes nothing there.

### 3.2 Does it fix "no prefix-cache reuse"? — **NO (this is the key correction)**

Provider prompt caching is keyed on the **exact token prefix of one conversation**. The
writer is a **different conversation** with a **different system prompt** and a **different
tool schema**, so its prefix cannot match the parent's. Specifically:

- pi-subagents `inherit_context` does **not** reuse the parent cache. `context.ts:
  buildParentContext()` re-serializes the parent branch into `[User]:/[Assistant]:` text
  (and **drops tool results entirely**) and prepends it to a fresh, differently-prompted
  session → a fresh cache **write**, arguably *worse* than today's delta file (which at
  least keeps clipped tool I/O).
- MiMoCode's prefix-cache reuse is the `checkpoint.fork=true` mode (research §5.2 line 192),
  which literally **forks the parent's full prompt prefix + matching tool schema** so the
  provider cache hits. **MiMo ships `fork=false` by default** and cold-starts with the delta
  — i.e. MiMo's default behaviour is *the same as ours today*. The thing the divergence note
  mourns is an opt-in optimization MiMo itself doesn't use by default.
- True `fork=true` *is* theoretically replicable with Route B (seed the writer's
  `SessionManager` with the parent's exact entries + identical system prompt + identical
  tool schema, then append the writer instruction). But it's heavy and fragile: the writer
  pays input/cache-read tokens for the *entire* parent context, and any drift in system
  prompt or tool list silently busts the cache. **Not worth it for v1** — defer behind a
  config flag if ever.

So: in-process removes the **file** and the **process**, not the **condensation**. The
delta is still a condensed text handoff because the writer is a separate agent. Honest
framing for the README: *"in-process removes the subprocess and the temp file; the
prefix-cache reuse would require forking the parent's full prefix (MiMo `fork=true`), which
even MiMo leaves off by default."*

### 3.3 Does it fix "no access to parent session state"? — **YES, genuinely (this is the real win)**

`fireCheckpoint` (`checkpoint.ts:182–222`) serializes a delta **to a file** for one reason:
the headless `pi --no-extensions -p` child is a separate process that cannot see the
parent's live `ctx.sessionManager.getBranch()`. An in-process writer is spawned *from our
extension*, which **already holds** `ctx` and the live `args.messages`. So:

- We hand the writer state **directly, in-memory** — no file hop, and we can include
  **richer** context than the 500-char-clipped, 100KB-capped file (we still budget for
  tokens, but we choose the budget, not a filesystem cap).
- We can keep our own `serializeDelta` (which preserves clipped tool I/O — better than
  `inherit_context`'s tool-result-dropping) and pass its output as the prompt.
- We still need `last_checkpoint_seq` bookkeeping to know the **delta range**, but the
  `delta-<n>.md` file, its `delta_n` counter, and the eviction/cleanup of stale delta files
  all **go away**.

Caveat: it's still a *forward-a-snapshot* model — the writer gets a serialized view, not a
live handle to the parent's session object. But the file boundary that motivated the
divergence is removed. **This question gets a clean yes.**

---

## 4. The tasks/ layer — task/actor registry + progress memory type (Q5)

This is the **real** reason to depend on pi-subagents, and it is **independent of the writer
change** (you can ship §3 without §4 and vice-versa).

### 4.1 What MiMoCode had (research / fork-delta §5)

- `task/` — user task graph (`task` + `task_event` tables); the **source of truth for
  checkpoint §4 Task tree** (the writer is forbidden to invent task IDs).
- `actor/` — subagent/background-actor registry (`actor_registry` table); spawn/turn/
  waiter/return-header. The checkpoint-writer/dream/distill are themselves actors here.
- `sessions/<sid>/tasks/<TID>/progress.md` — **per-task progress journal**, written *by the
  subagent* (a `postStop` hook forces 5 exact sections before a task-bound subagent may
  terminate). The writer **reads** these and reconciles them into checkpoint §4.
- Rebuild dump sections `## Active actors` (cap 500) and the tasks ledger.

We dropped all of this: checkpoint §4 is pinned to `(no task registry)` and the SUBAGENT
PROGRESS machinery is gone.

### 4.2 What pi-subagents gives us

The `AgentManager` *is* an actor registry (records: type, description, status ∈
queued/running/completed/error/stopped/aborted, toolUses, tokens, timestamps, result), and
the `subagents:*` lifecycle events are an actor event stream. That covers the **actor**
half. It does **not** give us the **task graph** (`task`/`task_event`) — pi-subagents has no
user-facing task tool; rpiv ships its own `@juicesharp/rpiv-todo` for that. So:

| MiMo piece | pi-subagents provides? | We must build |
|---|---|---|
| Actor registry + lifecycle | ✅ (events + records) | persistence to our DB/files |
| Per-actor progress journal | ⚠️ partial (it has agent-memory + result) | the `progress.md` convention + reconcile |
| User task graph (§4 source of truth) | ❌ | optional: depend on a todo extension, or derive a lighter "actor ledger" instead |

### 4.3 Plan for the tasks layer (additive, pi-subagents = soft dep)

1. **New memory type `progress`** in `paths.ts` type-from-key regex (`progress*` → progress),
   and a new layer path `sessions/<sid>/tasks/<actorId>/progress.md`.
2. **Observe** `subagents:created|started|completed|failed|compacted` via `pi.events`;
   persist an **actor ledger** row per actor into the `meta`/a new `actor` table (id, type,
   description, status, tokens, started/completed, result-summary), keyed by session + pid.
   This is pure event-consumption of **serializable payloads** — no dual-copy object seam.
3. **Progress journals**: on `subagents:completed`, write/append a
   `tasks/<actorId>/progress.md` from the event's `result` + `description` (we can't run a
   `postStop` hook inside *their* subagent, so we synthesize the journal from the completion
   payload instead of forcing the subagent to write it — a deliberate, documented
   simplification vs MiMo's hook).
4. **Path guard**: extend the allowlist so the writer may write `sessions/<sid>/tasks/**`
   (it already owns checkpoint.md); keep blocking the main agent from that subtree.
5. **Checkpoint writer prompt**: re-introduce §4 Task-tree machinery and a SUBAGENT PROGRESS
   block built from the actor ledger (`buildProgressDiff` equivalent), replacing the current
   `(no task registry)` pin. Add `## Active actors` to the rebuild dump (`inject.ts`).
6. **Reconcile** picks up `progress.md` files (they're under the memory root) so they become
   FTS-searchable like every other layer.
7. **Footer / `/memory` status**: surface active-actor counts (reuses `footer-counts.ts`).

Degrade gracefully: if pi-subagents is absent, the actor ledger stays empty, §4 falls back
to `(no task registry)`, and nothing breaks.

---

## 5. Risks & caveats

- **Fork/rename module seam (Route A only).** pi-subagents bundles its own
  `@mariozechner/pi-coding-agent` and imports the SDK from the *pre-rename* scope, so a spawn
  runs two copies of pi's core at once, operating on our `@earendil-works` `ctx` by
  structural compatibility. It works in production (rpiv), but it's a real seam. **Route B
  (first-party SDK) avoids it entirely** — another reason to keep the writer first-party.
- **Soft vs hard dependency.** Hard-requiring pi-subagents would regress the "memory never
  breaks the session" posture and clashes with the symlink install. Keep it soft, gated on
  `subagents:ready`.
- **Recursion guard.** The `PI_MIMO_CME_CHILD=1` env guard exists for the *subprocess*. The
  in-process writer (Route B, no `bindExtensions`) can't recurse, so the guard becomes
  unnecessary **for the writer** — but **keep it for dream/distill**, which should stay
  subprocesses (long-running, fire-and-forget, benefit from outliving the session and
  process isolation; the user only asked about the writer).
- **Lifetime.** In-process work dies if the user quits pi mid-write. Today's `pi.exec` is
  awaited (not detached), so this is already the case — no regression. `session_before_compact`
  still awaits with a timeout via `waitForIdle`.
- **Headless `pi -p`.** A single-shot run may exit before a spawned writer finishes; same as
  today. The `waitForIdle` path in `session_before_compact` is the backstop.

---

## 6. Recommended phasing

- **Phase 1 — In-process writer via first-party SDK (Route B).** Swap the `ExecFn` in
  `CheckpointManager` for an in-process `runWriter(session-state)` that builds an in-memory
  `createAgentSession`, passes the delta inline, and awaits `session.prompt`. Delete
  `delta-<n>.md` plumbing (`deltaPath`, `delta_n`, eviction). Keep queue/`waitForIdle`/
  failure-count logic. Drop `--no-session`/`--no-extensions`/env-guard *for the writer*.
  Fixes Q3 (parent state) and the file/process overhead; **honestly does not fix Q2's
  prefix cache** — update README §5 accordingly. **No new dependency.**
- **Phase 2 — Tasks/actor layer (soft pi-subagents dep).** §4 above. Declare
  `@tintinweb/pi-subagents` in `peerDependencies`, detect via `subagents:ready`, add the
  `progress` memory type + actor ledger + checkpoint §4 re-activation + rebuild `## Active
  actors`. Fixes Q5. Update divergence #6.
- **Phase 3 (optional, deferred) — true prefix-cache fork.** A `checkpoint.fork` config flag
  that seeds the writer session with the parent's exact prefix + tool schema (MiMo parity).
  Only if profiling shows the writer's cold-start token cost actually matters.

  **STATUS (2026-06-13): "measure first" prerequisite SHIPPED; the fork itself remains
  unbuilt — and an SDK investigation argues it should stay that way.** Two findings drove
  this:

  1. **Feasibility (SDK archaeology).** A real provider cache-READ for the writer is
     *POSSIBLE-BUT-FRAGILE → effectively blocked*. The deep (conversation-level) Anthropic
     cache breakpoint includes the **tools block**, so a hit requires the writer to send a
     byte-identical tool schema — i.e. the parent's *full* tool set, which includes
     **this extension's own** memory/history tools. Reproducing those under the writer's
     `noExtensions` loader is impossible without re-binding the extension to the writer
     session — exactly the recursion Phase 1 eliminated. Add the live `Current date:` /
     `Current working directory:` suffix baked into every system prompt (`system-prompt.js`),
     OAuth-vs-API-key tool-name casing, and the 5-min cache TTL, and the byte-match is
     unreachable in the general case. Even if forced, the writer would carry the **entire**
     parent context (tens-to-hundreds of K tokens) as input every checkpoint vs. today's
     small condensed delta — a likely **net cost regression**, not a win.
  2. **Decision gated on data, not theory.** Rather than build or kill on the above alone,
     the writer is now **instrumented** (the gate the plan itself names). Each run records,
     into a `writer_metrics` table (DB `SCHEMA_V3`): its own token usage
     (`input/output/cacheRead/cacheWrite/total/cost`, from the writer session's
     `getSessionStats()`), the condensed delta size it received, and the **parent context
     size at fire time** (`ctx.getContextUsage().tokens` — what a `fork=true` writer would
     have to carry). `/memory metrics` aggregates these and prints a build-vs-skip verdict:
     it pits the parent context billed at the ~10% cache-read rate (a fork's impossible-best
     case) against the writer's full-price input today; if even that best case loses, the
     fork is not worth building. `cacheRead` here doubles as the fork's acceptance signal —
     ~0 today (no reuse); a working fork would make it > 0.

  **Next step:** run real sessions past the 20/40/60/80% thresholds, then `/memory metrics`.
  Build the `checkpoint.fork` flag only if the data overturns finding #1 (it is not expected
  to). Wiring already in place to make that cheap: `WriterResult.metrics`, the parent-context
  capture in `CheckpointManager`, and the per-run row.

Tests: extend `checkpoint.test.ts` for the in-memory writer path (mock `createAgentSession`),
add an actor-ledger test, a `progress`-type regex test in `paths.test.ts`, and a path-guard
case allowing `tasks/<id>/` for the writer and denying it for the main agent.

---

## 7. Addendum (2026-06-13): closing the **user-task-graph** gap via `@juicesharp/rpiv-todo` (Option A)

§4.2 left the **user task graph** (MiMoCode's `task`/`task_event`, the source of truth for
checkpoint §4 "Task tree") as an open ❌: "optional — depend on a todo extension, or derive a
lighter actor ledger instead." This addendum resolves that row. We **can** fill it with the
community extension `@juicesharp/rpiv-todo` (v1.19.1, installed at
`~/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo`), but the integration shape is **not** the
event-bus pattern §4.3 assumed — and that distinction is the whole design.

### 7.1 The contract correction (why this isn't the actor pattern)

The actor layer (§4.3) works because pi-subagents **emits serializable lifecycle events** on
`pi.events` (`subagents:created|…|completed`) that we observe without importing it. **rpiv-todo
emits nothing on any bus and writes nothing to disk** (verified against its source — grep for
`pi.events`/`emit`/`publish`/`saveJsonConfig`: zero matches). Its only `pi.*` surface is
`registerTool("todo")`, `registerCommand`, and *listeners*. So the `tasks:*` subscription §4.3
sketched **has no emitter to subscribe to** — building a push-fed `TaskLedger` would wire to a
dead channel.

What rpiv-todo *does* expose is a different, equally serializable seam: **every `todo`
tool-result message carries the complete task snapshot in its `details` field.**

- Data model (`rpiv-todo/tool/types.ts:26-39`): `Task { id:number; subject; description?;
  activeForm?; status; blockedBy?:number[]; owner?; metadata? }`, `status ∈ pending |
  in_progress | completed | deleted`. It is a **flat list + a `blockedBy` dependency DAG**
  (`state/task-graph.ts` rejects cycles), **not** a parent/child tree, and carries **no
  timestamps**.
- Persistence (`tool/response-envelope.ts:79-93`): each successful `todo` call returns
  `details: { action, params, tasks: Task[], nextId }`. rpiv-todo itself reconstructs live state
  after `/reload`/compaction by **replaying the branch** — `state/replay.ts:24-38` walks
  `ctx.sessionManager.getBranch()` and takes the **last** `toolResult` whose `toolName==="todo"`
  and whose `details` matches `isTaskDetails` (`Array.isArray(tasks) && typeof nextId==="number"`).
  Last-write-wins; the latest snapshot is the complete state.

⇒ **VERDICT: serviceable via the conversation tool-call stream.** Any extension holding `ctx`
can run the identical ~12-line scan over the shared branch and reconstruct the live task graph —
no import, no second copy of pi core.

### 7.2 Why Option A is nearly free here

pi-mimo-cme **already fetches the exact branch entries** this needs:
`branchMessages(ctx)` (`index.ts:241-245`) is `getBranch().filter(type==="message").map(e =>
e.message)` — the same `e.message` objects rpiv-todo reads `.details` off. Those branch messages
already flow into the checkpoint writer's delta (`index.ts:522,538` → `serializeDelta`). The only
reason the task snapshot isn't already reaching the writer is that **`serializeDelta`
(`checkpoint.ts:76-83`) reads `toolResult` `m.content` (the human text) and ignores `m.details`.**
Option A is therefore "scan the branch messages we already hold for the last todo snapshot, render
it." No new `getBranch()` call, **no DB table, no migration, no event subscription, no path-guard
change** (rpiv-todo writes nothing to disk).

### 7.3 Option A design (read-time snapshot → checkpoint §4 + rebuild)

Purely additive; soft-gated under the **existing** `config.tasks.enabled` flag (no new gate).

1. **New pure module `src/tasks.ts`** (mirrors `src/actors.ts`'s *pure* half — no DB):
   - `TodoTask` type + `isTaskDetails(v)` discriminator (copy of rpiv-todo's, byte-compatible).
   - `readTaskSnapshot(messages: unknown[]): TodoTask[]` — last-write-wins scan over the
     `branchMessages`-shaped array for `role==="toolResult" && toolName==="todo" &&
     isTaskDetails(details)`, returns `details.tasks` (non-deleted unless asked).
   - `buildTaskTree(tasks, cap)` — renders `[status] #id subject (activeForm) ⛓ #dep,…` lines
     grouped in_progress → pending → completed, budget-clipped; returns `""`/placeholder when
     empty. Style mirrors `buildSubagentProgress` (`actors.ts:370`).
2. **Checkpoint §4 becomes two sub-sections.** `templates.ts:24-26` §4 header gains
   `### Task tree` + `### Subagents`; the writer prompt (`prompts/checkpoint-writer.ts`) gets a
   parallel **TASK GRAPH** inlined block + a §4 reconcile paragraph mirroring the SUBAGENT
   PROGRESS one ("reconcile the TASK GRAPH block; use task IDs exactly as given; never invent").
   A new `taskTree` closure is injected at `index.ts:226-228` beside `subagentProgress`, threaded
   through `CheckpointManager` like the existing optional dep (`checkpoint.ts:180,336`). §4 budget
   (`templates.ts:84`, currently `1000`) is split/bumped to cover both halves.
3. **Rebuild dump** (`inject.ts`): add a `## Task tree` (or `## Tasks ledger`) section built from
   `buildTaskTree` immediately **before** `## Active actors` (`inject.ts:259-263`) — the task graph
   is the broader frame, subagents are leaves. `isCheckpointEmpty` (`inject.ts:224`) already
   tolerates a tasks placeholder.
4. **Config:** add one push cap `pushCaps.tasks` (default ~2000) for the ledger section
   (`config.ts:7-15` interface + `:60-67` defaults; the merge loop at `:97-102` auto-picks it up).
   Reader is soft: rpiv-todo absent ⇒ no `todo` results ⇒ snapshot empty ⇒ §4 Task tree renders
   "(no tasks this session)", identical to the actor-absent path. **`config.tasks.enabled` already
   exists and already gates the task side** — the reader hangs off the same flag.

### 7.4 Honest fidelity gaps vs MiMoCode (what Option A does NOT close)

| MiMoCode `task`/`task_event` | rpiv-todo via Option A | Status |
|---|---|---|
| Task **tree** (parent/children) | flat list + `blockedBy` DAG | relabel §4 "Task tree" → still a graph, just edges-not-tree |
| `task_event` append-log (history) | snapshots only | event log derivable only by diffing snapshots — **deferred**, not built |
| created/updated/completed **timestamps** | none in the `Task` type | **`task_archive_days` is unfillable from this source** — drop that key |
| Cross-session task registry | current session's branch only | snapshot is session-scoped (matches our actor ledger's per-session scope) |

These are inherent to rpiv-todo's model, not the integration; the **core** of the gap (live task
state surfaced into checkpoints + rebuild) closes cleanly. Option B (a `task`/`task_event` table
fed by observing `tool_execution_end` for `toolName==="todo"`) would add cross-session history but
is deferred — not needed for the §4/rebuild use case.

### 7.5 Confirmation gate (run before implementing)

The whole design hinges on one empirical fact: **does the `todo` tool-result `details` payload
actually survive in the branch messages pi-mimo-cme reaches via `getBranch()`?** Static evidence is
strong (rpiv-todo reads `e.message.details` from the same API in production), but this is gated on a
live check: a throwaway probe extension runs the exact `branchMessages` + replay scan in a real
headless `pi -e probe.ts -p "<create two todos>"` run with rpiv-todo installed (isolated agent dir,
harness modeled on `scripts/smoke-subagents.sh`).

> **GATE RESULT: ✅ PASS (2026-06-13, `scripts/smoke-todo-branch.sh` against rpiv-todo@1.19.1,
> pi 0.79.3).** A real headless run made 3 `todo` calls (create/create/update); the probe ran the
> exact `branchMessages` + replay scan over `getBranch()` and found **all 3 tool-results carried a
> valid `TaskDetails` payload**, with the last-write-wins snapshot correctly reconstructing 2 tasks
> (incl. `#1` flipped to `in_progress` with its `activeForm`). The branch toolResult message keys are
> `[role, toolCallId, toolName, content, details, isError, timestamp]` — `details = {action, params,
> tasks, nextId}` is present in-process. Proceeding to implement §7.3. (Probe + harness:
> `scripts/probe-todo-branch.ts`, `scripts/smoke-todo-branch.sh` — throwaway, not part of the
> shipped extension.)

Tests (on PASS): `tasks.test.ts` for `readTaskSnapshot` (last-write-wins, deleted-filtering,
empty/garbage `details`) + `buildTaskTree` (grouping, budget clip, empty placeholder); an
`inject.test.ts` case for the `## Open tasks` section; a `checkpoint.test.ts` case for the
inlined TASK GRAPH block; a `config.test.ts` case for `pushCaps.tasks`.

### 7.6 IMPLEMENTATION STATUS — ✅ SHIPPED (2026-06-13, branch `notify-memory-transformations`)

Option A is built, green, and live-verified. **99/99 tests, tsc clean.** One refinement vs the
§7.3 sketch, made during implementation and strictly better:

- **§4 is RESTORED to MiMoCode's name "§4 Task tree"** (not "two `###` sub-sections under a new
  title"). The body is the user task graph (one line per todo); subagents move under a
  `### Subagents` sub-block *within* §4. This keeps a single editable body (compatible with the
  writer's per-section Edit discipline) AND **closes the audit's "§4 renamed Task tree → Subagents"
  divergence** — §4's title and its `1000` budget are now byte-identical to MiMoCode again. The
  budget key was renamed `"§4 Subagents"` → `"§4 Task tree"` (value unchanged).
- **Source of truth = the branch snapshot, not a DB.** `src/tasks.ts` is a *pure* module
  (`readTaskSnapshot` + `buildTaskTree`, no DB, no pi imports) — the todo snapshot is already
  persisted in the conversation, so unlike the actor ledger there is nothing to store. No
  `task`/`task_event` table, no migration, no event subscription, no path-guard change.
- **Files touched (7 + 1 new):** `src/tasks.ts` (new pure module); `config.ts` (`pushCaps.tasks`
  default 2000 + `tasks` block doc); `templates.ts` (§4 → "Task tree" + budget key); `prompts/
  checkpoint-writer.ts` (TASK GRAPH block + §4 reconcile instructions + arg); `checkpoint.ts`
  (`buildTaskTree?` dep → `WriterJob.taskTree` from the FULL branch → prompt); `inject.ts`
  (`## Open tasks` rebuild section + new placeholders); `index.ts` (import + the §4 closure +
  the rebuild open-tasks computation). Both closures gated on the existing `config.tasks.enabled`.
- **Live-verified end-to-end** via `scripts/smoke-todo-branch.sh` (rpiv-todo@1.19.1, pi 0.79.3):
  the *shipped* `src/tasks.ts` renders the real §4 block from a live branch —
  `- [in_progress] #1 probe task alpha (probing task alpha)` / `- [pending] #2 probe task beta`.
- **Smoke + probe are KEPT** as permanent regression tooling (parallel to `scripts/smoke-subagents.sh`),
  superseding the "throwaway" note in the §7.5 gate box. `scripts/probe-todo-branch.ts` imports the
  shipped `src/tasks.ts` so the smoke exercises real code, not a copy.
- **Still open (Option B / fidelity):** no `task_event` history log, no timestamps ⇒
  `task_archive_days` intentionally not added, snapshot is session-scoped. Documented in README
  divergence #6.
