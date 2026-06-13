# Scaling & Retention Plan

Status: phase 1 shipped ✅ · phases 2–4 proposed · Target: post-v1 hardening · Owner: TBD

This plan addresses the four growth/latency vectors identified in the capacity
review of pi-mimo-cme's storage. None are urgent for a single project in normal
use — but they are the parts of the design with **no lifecycle**, and they
degrade as *latency* (the per-turn footer) well before they degrade as *disk*.

The four are tackled **sequentially**, in dependency order:

| # | Phase | Kind | Why this order | Schema change | Default behavior |
|---|-------|------|----------------|---------------|------------------|
| 1 ✅ | Cached footer counters | Perf, DB-only | Independent; highest-value; establishes the counter infra phases 2–3 must keep in sync | none | identical output, no per-turn `COUNT(*)` |
| 2 | `history_fts` retention prune | Data size, DB-only | Establishes retention config + dream-completion prune hook + FTS-delete discipline that phase 3 reuses | none | **OFF** (unlimited) |
| 3 | GC consolidated session folders | Data size, file + DB | Reuses phase 2's retention infra + reconcile's existing vanished-file prune; riskiest (deletes files) so it follows the proven DB-only prune | none | **OFF** (keep all) |
| 4 | Scope/cache reconcile's walk | Perf, file scan | Pure optimization, no data semantics; benefits compound once phases 2–3 manage session count | none | identical output, fewer `statSync`s |

## Shared invariants (apply to every phase)

These are non-negotiable; a phase that violates one is wrong even if its tests pass.

1. **Files are the source of truth; the DB is derived.** Deleting `memory.db`
   must still lose zero *curated* memory. Phase 3 deletes markdown — that is the
   one exception, and it is gated on consolidation (see phase 3).
2. **FTS5 external-content trigger contract** (`db.ts:29-42`, `:63-72`). Deletes
   and updates on the **base** tables (`memory_fts`, `history_fts`) are safe —
   the `*_ad` / `*_au` triggers emit the `('delete', rowid, body)` magic command
   that removes the old tokens. **Never** issue `DELETE FROM *_idx` directly, and
   never delete a base row without its body available to the trigger (don't
   `DROP`/bulk-bypass the triggers). Every prune in phases 2–3 is a plain
   `DELETE FROM <base_table> WHERE …`.
3. **Default behavior is unchanged.** All new pruning/GC defaults to OFF or
   no-op. A user upgrading must never silently lose data; retention is strictly
   opt-in via `config.json`, with recommended values documented, not defaulted.
4. **Counter reseed discipline (post phase 1).** Any batch op that mutates row
   counts (`reconcile`, history prune, session GC) must reseed the cached footer
   counters before returning. Per-turn paths only ever do integer arithmetic.
5. **`tsc --noEmit` clean + `node --test` green** at the end of every phase. Each
   phase ships its own tests and is independently revertable.

---

## Phase 1 — Decouple the footer from table size (cached counters) ✅ COMPLETE

> **Status: complete.** Shipped as `src/footer-counts.ts` (the `FooterCounts`
> class) + `test/footer-counts.test.ts`. `refreshStatus` now reads the cached
> struct and issues zero SQL per turn; counters are seeded at `session_start`,
> incremented by `addHistory` on the live-index/backfill paths, and reseeded via
> `reseedMemory` after every reconcile — including the in-turn reconcile in
> `reconcileAndNotify` (the third call site, required by invariant #4 so the
> `turn_end` backstop footer stays exact). `reseedHistory` exists but is unused
> until phases 2–3 prune. `tsc --noEmit` clean, full suite green (53 tests).

### Problem
`refreshStatus` (`src/index.ts:142-147`) runs two `COUNT(*)` on **every**
`message_end` and `turn_end`:

```js
const countMemoryRows = db.prepare("SELECT COUNT(*) AS n FROM memory_fts");
const countProjectHistoryRows = db.prepare(
  "SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ?");
```

`memory_fts` is small, but `history_fts WHERE project_id = ?` is an index range
scan over **this project's** rows (`history_fts_project_idx`). At hundreds of
thousands of rows this adds measurable per-turn latency — the classic "fine
until it isn't" footgun, scaling with table size while everything else stays
fast.

### Approach
Maintain an in-memory `FooterCounts { memIdx: number; projHist: number }`,
seeded once per session with a single `COUNT(*)` each, then mutated
incrementally. The deltas are **already returned** by existing code:

- `indexer.indexMessage(...)` returns rows added (`src/index.ts:364`).
- `backfillProject(...)` returns `stats.rows` (`src/index.ts:304`).
- `reconcile(...)` returns `ReconcileStats` — but `indexed` counts upserts
  (inserts *and* updates), so it cannot derive an exact count. Since reconcile is
  **infrequent** (never per-turn), simply **reseed** `memIdx` with one
  `COUNT(*) FROM memory_fts` after each reconcile. Exact, and off the hot path.

Net result: `memIdx` only ever changes on reconcile (reseed); `projHist` is
seeded once and incremented by `added`/`stats.rows`; `refreshStatus` reads two
integers and runs zero SQL.

### Code changes
- New tiny module `src/footer-counts.ts` (or a closure in the factory): holds the
  struct + `seed(db, pid)`, `addHistory(n)`, `reseedMemory(db)`,
  `reseedHistory(db, pid)`.
- `src/index.ts`:
  - Seed at `session_start` (alongside the existing `refreshStatus(ctx)` at `:317`).
  - `refreshStatus` reads the cached struct instead of executing the two
    prepared statements; drop `countMemoryRows` / `countProjectHistoryRows` from
    the per-turn path (keep them only inside the seed/reseed helpers).
  - On the live index path (`:364`), `counts.addHistory(added)` then
    `refreshStatus`.
  - After backfill (`:304`), `counts.addHistory(stats.rows)`.
  - Inside `reportPassResult`'s dream branch, after `reconcile`,
    `counts.reseedMemory(db)` (and `reseedHistory` once phases 2–3 prune).

### Migration / config
None.

### Tests (`test/footer-counts.test.ts`)
- After a sequence of `indexMessage` calls, cached `projHist` == `COUNT(*) …
  WHERE project_id`.
- After `reconcile` adds/prunes files, `reseedMemory` == `COUNT(*) FROM
  memory_fts`.
- Seed → increments → reseed round-trips to the same value (no drift).

### Risks & mitigations
- **Counter drift** if an insert path is missed → every `session_start` reseeds
  from `COUNT(*)`, so drift self-heals each session; per-turn is pure arithmetic.
- **Multi-session writers to one DB** (the shared machine-wide `memory.db`):
  another session inserting history rows won't update *this* session's cached
  `projHist`. Acceptable — the footer is a live hint for the current session, and
  the next `session_start` reseeds. Document this explicitly.

### Done when
Footer shows identical numbers, `refreshStatus` issues no SQL, tests green.

---

## Phase 2 — `history_fts` retention prune (inside dream completion)

### Problem
`history_fts` is **insert-only** (`src/history.ts` — `indexMessage` /
`backfillProject` only `INSERT OR IGNORE`; `src/db.ts` has no retention). It is
the dominant data-size vector and is machine-wide (one shared `memory.db`).
Bodies are capped (2 KB tool_input, 8 KB tool_output/error) and the default
`kinds` exclude the two big ones (`reasoning`, `tool_output`), but nothing ever
removes a row.

### Approach
Add **opt-in** retention config and run a prune at dream completion (dream
already gates on `intervalDays` and already runs `reconcile` there, so prune
piggybacks on a proven, infrequent, project-scoped cadence).

```jsonc
// config.json (defaults shown; absent ⇒ unlimited, current behavior)
"history": {
  "kinds": ["user_text", "assistant_text", "tool_input", "tool_error"],
  "retention": {
    "maxAgeDays": null,        // e.g. 180 — drop rows older than N days
    "maxRowsPerProject": null  // e.g. 200000 — keep newest N per project
  }
}
```

Prune logic (`src/retention.ts`), run per current `pid`:

- **Age:** `DELETE FROM history_fts WHERE project_id = ? AND time_created < ?`
  (cutoff = `now − maxAgeDays·86_400_000`).
- **Count:** keep newest N per project —
  `DELETE FROM history_fts WHERE project_id = ? AND id NOT IN
   (SELECT id FROM history_fts WHERE project_id = ? ORDER BY time_created DESC LIMIT ?)`.
- Both deletes flow through `history_fts_ad` → FTS tokens removed correctly
  (invariant 2). Run inside one `BEGIN`/`COMMIT`, matching the existing
  transactional style.
- After pruning, emit an FTS optimize to merge tombstoned segments (deletes leave
  them behind): `INSERT INTO history_fts_idx(history_fts_idx) VALUES('optimize')`.
  This is the *only* legal write to the vtab here and is the documented FTS5
  maintenance command (not a row delete).
- Optional, gated: `PRAGMA wal_checkpoint(TRUNCATE)` (already used pre-dream-spawn
  at `:263`) to keep the WAL bounded after a large prune. `VACUUM` is **not** run
  automatically — it locks and rewrites the whole file; mention as a manual op.

### Code changes
- `src/config.ts`: extend `CmeConfig.history` with optional `retention`; parse in
  `mergeConfig` (validate numbers, treat `null`/absent as unlimited).
- `src/retention.ts`: `pruneHistory(db, pid, cfg): { deleted: number }`.
- `src/index.ts` `reportPassResult` dream branch: after `reconcile`, call
  `pruneHistory`, then `counts.reseedHistory(db, pid)` (phase 1), log the count,
  and fold it into the existing dream notification (`:200-207`), e.g.
  `"… , 1.2k history rows pruned"`.

### Migration
None (config-only; behavior identical until a user sets a limit).

### Tests (`test/retention.test.ts`)
- Age prune removes only rows older than cutoff; count prune keeps exactly newest N.
- Pruned rows no longer returned by `historySearch` (proves FTS idx stayed
  consistent — guards the war story).
- `retention` absent ⇒ zero deletions (no-op default).
- Prune is project-scoped: rows of other `project_id`s untouched.

### Risks & mitigations
- **Irreversible deletion** → opt-in only; document recommended conservative
  values; log counts before/after; never default a limit.
- **FTS index corruption** if the `_idx` is touched directly → only base-table
  `DELETE` + the `'optimize'` command; covered by the search-after-prune test.

### Done when
With a limit configured, dream prunes the project's history to the bound, search
reflects it, footer count updates, and the default (no limit) is a strict no-op.

---

## Phase 3 — GC consolidated session folders (+ their `memory_fts` rows)

### Problem
One `sessions/<sid>/` folder is created per session and **never removed**; each
contributes a `checkpoint.md` (+ `notes.md`) row to `memory_fts`. Small per
session, unbounded in count.

### Approach — safety first
A session folder may only be GC'd when its content has had a chance to be folded
into the durable layers, and never if it's still useful for resume. A folder is
**GC-eligible** iff *all* hold:

1. It is **not** the current/live session.
2. Its `checkpoint.md` is non-empty (`isCheckpointEmpty` is false — empty
   sessions carry nothing; they can be removed under a separate, even safer rule
   or left alone).
3. A **dream has run after the session's last checkpoint write** — i.e. its
   content had a consolidation opportunity. Track this with the existing dream
   watermark: `last_dream_at:<pid>` (`maybeAutoPass`, `:231-240`) compared to the
   session checkpoint's mtime.
4. It falls **outside the keep window** — preserve the most recent sessions for
   resume regardless of consolidation.

Config (opt-in; absent ⇒ keep everything):

```jsonc
"sessions": {
  "retention": {
    "keepLastN": null,   // e.g. 50 — always keep the N most recent session folders
    "keepDays": null     // e.g. 30 — always keep folders touched within N days
  }
}
```

GC action — **delete the folder, let reconcile clean the index**:

- `fs.rmSync(sessionDir(sid, root), { recursive: true, force: true })`.
- The very next `reconcile` (dream already runs one right after) prunes the now
  -vanished `checkpoint.md`/`notes.md` rows from `memory_fts` via its **existing**
  vanished-file path (`src/reconcile.ts:160-171`), which uses correct trigger
  semantics. So GC needs **no** bespoke index code — order it *before* the
  reconcile in `reportPassResult`, or call reconcile again after.

### Layer boundary (document prominently)
Phase 3 GCs **our markdown session layer** (`pi-mimo-cme/sessions/<sid>/`) and
its `memory_fts` rows. It does **not** touch `history_fts` — those rows are the
layer-4 firehose backfilled from **pi's own** session JSONL
(`~/.pi/agent/sessions/…`, see `sessionsJsonlDir`), which we don't own. History
size is **phase 2's** job. Deleting our folder is durable: backfill only writes
`history_fts`, never re-creates a checkpoint, so a GC'd session stays GC'd.

### Code changes
- `src/config.ts`: add optional `sessions.retention`; parse + validate.
- `src/retention.ts`: `gcSessions(db, root, pid, currentSid, cfg, dreamWatermark):
  { removed: string[] }` — pure-ish (takes `fs`-touching helpers), returns the
  sids removed for logging/tests.
- `src/index.ts` `reportPassResult` dream branch: run `gcSessions` before/with
  the reconcile; reseed `memIdx` (phase 1); fold count into the dream notice.

### Migration
None.

### Tests (`test/gc-sessions.test.ts`, using a temp `root`)
- Eligible (old, consolidated, non-current, outside keep window) sessions removed;
  current/recent/unconsolidated preserved.
- After GC + reconcile, the removed sessions' `memory_fts` rows are gone and the
  kept ones remain (search reflects it).
- `keepLastN`/`keepDays` floors honored; `retention` absent ⇒ zero removals.
- A session whose checkpoint mtime is **newer** than `last_dream_at` is never
  removed (not yet consolidated).

### Risks & mitigations
- **Deleting un-consolidated work** → triple-gated (post-dream watermark +
  keep-window + non-empty); opt-in; logs every removed sid.
- **Resume regression** → keep window guarantees the most recent N / D-days
  sessions survive, so `pi --resume` of anything recent still finds its
  checkpoint (see ONBOARDING — cross-session behavior).
- **Index/file race** → GC then reconcile within the same dream-completion path,
  no concurrent writer (dream child has exited).

### Done when
With limits set, dream removes only safely-consolidated old sessions, reconcile
drops their index rows, recent sessions remain resumable, default is a no-op.

---

## Phase 4 — Scope/cache reconcile's tree walk

### Problem
`reconcile` → `walkMemoryTree` (`src/reconcile.ts:75-115`) walks
`root/sessions/*` across **all projects** (`readdir` + `statSync` per `.md`) on
the first `/memory search` per session and after each dream. Cost is
O(total machine-wide sessions). `reconcileDebounceMs` (`config.ts:27`) collapses
*repeats* within a session but does not cheapen the walk itself. The authors
already flag this in the config comment.

### Approach — incremental, mtime-gated descent
Session folders are **not** keyed by project in the path (`sessions/<sid>/` has no
pid), so we cannot filter the walk by project directory. Instead, skip
**unchanged** session subtrees:

- Record `last_reconcile_walk_at` in `meta` (a single timestamp).
- When walking `sessions/`, `statSync` each `<sid>/` dir and **descend only if**
  `dir.mtimeMs > last_reconcile_walk_at`. On APFS/ext4 a file create/delete/edit
  bumps the parent dir's mtime, so a changed session is always visited.
- `global/` and `projects/` are small — always walk them fully.
- The cc scope (`~/.claude/projects/*/memory`) gets the same dir-mtime gate.
- **Correctness is still owned by the per-file fingerprint** (`size-mtimeNs`,
  `:145-147`). The dir-mtime gate may only *skip*; it is never the authority on
  whether a file changed. To bound skew, run a **full** (un-gated) walk
  periodically — e.g. once per session (first reconcile of the session) or on an
  explicit `force` flag — and gate only the rapid in-session repeats.

This turns the steady-state walk from "every session dir, every project" into
"only dirs touched since the last walk."

### Code changes
- `src/reconcile.ts`: `ReconcileOptions` gains `since?: number` (gate threshold)
  and `force?: boolean`; `walkMemoryTree` applies the dir-mtime gate when `since`
  is set and `!force`.
- Callers (`src/commands.ts:55-61` `reconcileAndNotify`; `src/index.ts:199`):
  pass `since = metaGet('last_reconcile_walk_at')` for in-session repeats, `force`
  for the first reconcile of a session and after dream; update the meta timestamp
  after a successful walk.

### Migration / config
None (uses existing `meta`). Optionally expose a `reconcileFullWalkEverySession`
boolean if we want it tunable.

### Tests (`test/reconcile.test.ts`, extend)
- A session dir whose file changed (mtime bumped) is re-indexed under a gated walk.
- An untouched dir is skipped under a gated walk but its row remains valid.
- A new file in a session bumps the dir mtime → picked up.
- `force` walk re-examines everything regardless of `since`.

### Risks & mitigations
- **Filesystem mtime semantics vary** → gate may *miss* on exotic FS; the
  periodic full walk + per-file fingerprint backstop guarantee eventual
  consistency (a skipped change is caught at the next full walk). Document the FS
  assumption.
- **Interaction with phase 3** → GC deletes a dir; the *next* (possibly gated)
  walk must still prune its row. The vanished-file prune (`:160-171`) iterates
  **all** `memory_fts` rows, not just walked dirs, so it catches deletions even
  under a gated walk. Verify with a test combining GC + gated reconcile.

### Done when
A gated reconcile visits only changed dirs, full walks still pick up everything,
search results unchanged, and the GC-then-gated-reconcile combination still
prunes removed sessions.

---

## Cross-phase validation
- After each phase: `npm run typecheck` and `npm test` green; the real-pi smoke
  path (`pi -e ./src/index.ts`, exercise `/memory`, `/memory search`, `/memory
  dream`) behaves identically with defaults.
- Add a coarse growth assertion to the test suite: index N synthetic sessions and
  confirm (a) the footer cost is constant per turn (phase 1), (b) configured
  limits bound `history_fts` / session-folder counts (phases 2–3), (c) a gated
  reconcile's `statSync` count scales with *changed* dirs, not total (phase 4).

## Out of scope (deliberately)
- `VACUUM` automation (heavy, locking) — leave as a documented manual op.
- Moving to a per-project DB — `history_fts.project_id` scoping + phase 2
  retention keep the shared DB tenable; sharding is a larger architectural change.
- Compressing/archiving GC'd sessions — phase 3 deletes; archive-to-tarball could
  be a later opt-in if users want recoverability.
