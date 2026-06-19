# Senior Developer Review — Audit Green-Light

**Date:** 2026-06-18
**Reviewed findings:** 28

## Greenlit Issues

1. **[HIGH] performance** — `src/history.ts:222`
   - What: `backfillProject` prepares INSERT statement inside per-file loop — 50 redundant prepares for 50 files
   - Fix: Hoist the `db.prepare()` outside the for-loop; it doesn't depend on per-file state

2. **[HIGH] performance** — `src/reconcile.ts:183`
   - What: `SELECT id, path FROM memory_fts` loads ALL rows into memory for prune pass
   - Fix: Use LEFT JOIN anti-pattern or batch UPDATE + DELETE unmarked in a single pass

3. **[HIGH] performance** — `src/history.ts:209`
   - What: `backfillProject` uses `readFileSync` + `split('\n')`, allocating full line array at once
   - Fix: Use streaming readline interface instead of `readFileSync` + `split` to reduce peak memory

4. **[MEDIUM] maintainability** — `src/checkpoint.ts:39`
   - What: `clip()` duplicated across 3 files (checkpoint.ts:39, actors.ts:81, tasks.ts:40)
   - Fix: Extract `clip`, `oneLine`, and `capLines` into a shared `src/text-utils.ts` utility module

5. **[MEDIUM] maintainability** — `src/checkpoint-validator.ts:62`
   - What: `estimateTokens()` re-implemented locally instead of importing from budget.ts
   - Fix: Import `estimateTokens` from `./budget.ts` and remove the local duplicate

6. **[MEDIUM] maintainability** — `src/clear.ts:92`
   - What: `TAGGED_TABLES` interpolated into SQL via `${table}` — safe only because it's compile-time constant
   - Fix: Add a comment: 'TAGGED_TABLES is compile-time constant; never interpolate user-derived strings'

7. **[MEDIUM] performance** — `src/history.ts:213`
   - What: `JSON.parse` called per-line for all lines, most discarded immediately after parse
   - Fix: Add early rejection: check line length/content before parsing; or use streaming JSON parser

8. **[MEDIUM] performance** — `src/reconcile.ts:140`
   - What: `selectFp.prepare()` used in per-file loop — N individual index lookups inside transaction
   - Fix: For large trees (>1K files), batch fingerprint checks with `WHERE path IN (...)` in chunks

9. **[LOW] performance** — `src/clear.ts:98`
   - What: `linkedSessionIds` runs 8 separate queries across 4 tagged tables
   - Fix: Combine into a single `UNION ALL` query to reduce round-trips from 8 to 1

10. **[LOW] maintainability** — `src/index.ts:1`
    - What: `index.ts` at 631 lines contains loosely coupled functions (writer setup, auto-pass)
    - Fix: Extract `runWriter`, `assetSnapshot`, `maybeAutoPass` into dedicated modules

11. **[LOW] maintainability** — `src/history.ts:211`
    - What: Nested try/catch with 3 levels of nesting and multiple `continue` statements
    - Fix: Extract inner per-file logic into `backfillFile()` helper to flatten nesting

12. **[LOW] performance** — `src/inject.ts:92`
    - What: WeakMap caches 2 prepared statements per DB handle; pattern should be documented
    - Fix: Document the WeakMap caching pattern as standard for new per-turn prepared statements

13. **[LOW] maintainability** — `src/inject.ts:96`
    - What: WeakMap cache key built from 10+ string-joined fields — fragile when adding fields
    - Fix: Add a comment listing every field in the key and why each matters for cache invalidation

14. **[LOW] performance** — `src/actors.ts:175`
    - What: `ActorLedger.exists()` runs `SELECT 1` before every non-created event
    - Fix: Cache in `activeIds` Map — if actor is in `activeIds`, it exists; only query DB on miss

15. **[LOW] maintainability** — `src/config.ts:80`
    - What: `mergeConfig` uses long chain of if/typeof guards; adding a field requires 3-place lockstep update
    - Fix: Add a comment block listing: when adding a config field, update interface, `DEFAULT_CONFIG`, and `mergeConfig`

## Deferred Issues

None

## Rejected Issues

1. **[INFO] performance** — `src/checkpoint.ts:224`
   - Reason: No change needed — DELTA_CAP bounds output at 100K chars (~25K tokens)

2. **[INFO] performance** — `src/checkpoint.ts:280`
   - Reason: No change needed — single parse per session, result cached in memory

3. **[INFO] performance** — `src/db.ts:145`
   - Reason: No change needed — FTS5 tokenizers configured at schema creation

4. **[INFO] performance** — `src/db.ts:423`
   - Reason: No change needed — data volume bounded by checkpoint frequency

5. **[INFO] performance** — `src/fts.ts:93`
   - Reason: No change needed — standard overfetch+floor pattern, bounded allocation

6. **[MEDIUM] performance** — `src/inject.ts:161`
   - Reason: Current design is acceptable (~0.1ms); stat caching with short TTL is premature optimization