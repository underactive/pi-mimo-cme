# Full Codebase Audit — pi-mimo-cme

**Date:** 2026-06-18
**Branch:** main (09547cc)
**Scope:** Entire codebase (55 files audited)
**Reviewers:** Code Quality Engineer, Performance Engineer

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 10 |
| Low | 9 |
| Info | 6 |
| **Total** | **28** |

### Codebase Strengths

- Exceptional documentation (onboarding guides, inline comments, design specs)
- Clean module separation — pure modules are truly pure and testable
- Consistent naming — no cryptic abbreviations, booleans read as questions
- The `safe()` wrapper pattern ensures memory failures never break the host session
- Zero `as any`, zero `@ts-ignore`, zero TODO/FIXME markers

---

## High Priority

### src/history.ts

  [high] performance — history.ts:222
    backfillProject prepares INSERT statement inside per-file loop — 50 redundant prepares for 50 files
    > Hoist the `db.prepare()` outside the for-loop; it doesn't depend on per-file state

  [high] performance — reconcile.ts:183
    SELECT id, path FROM memory_fts loads ALL rows into memory for prune pass
    > Use LEFT JOIN anti-pattern or batch UPDATE + DELETE unmarked in a single pass

  [high] performance — history.ts:209
    backfillProject uses readFileSync + split('\n'), allocating full line array at once
    > Use streaming readline interface instead of readFileSync + split to reduce peak memory

---

## Medium Priority

### src/checkpoint.ts

  [medium] maintainability — checkpoint.ts:39
    `clip()` duplicated across 3 files (checkpoint.ts:39, actors.ts:81, tasks.ts:40)
    > Extract `clip`, `oneLine`, and `capLines` into a shared `src/text-utils.ts` utility module

### src/checkpoint-validator.ts

  [medium] maintainability — checkpoint-validator.ts:62
    `estimateTokens()` re-implemented locally instead of importing from budget.ts
    > Import `estimateTokens` from `./budget.ts` and remove the local duplicate

### src/clear.ts

  [medium] maintainability — clear.ts:92
    TAGGED_TABLES interpolated into SQL via `${table}` — safe only because it's compile-time constant
    > Add a comment: 'TAGGED_TABLES is compile-time constant; never interpolate user-derived strings'

### src/history.ts

  [medium] performance — history.ts:209
    backfillProject uses readFileSync + split('\n'), allocating full line array at once
    > Use streaming readline interface instead of readFileSync + split to reduce peak memory

  [medium] performance — history.ts:213
    JSON.parse called per-line for all lines, most discarded immediately after parse
    > Add early rejection: check line length/content before parsing; or use streaming JSON parser

### src/reconcile.ts

  [medium] performance — reconcile.ts:140
    selectFp.prepare() used in per-file loop — N individual index lookups inside transaction
    > For large trees (>1K files), batch fingerprint checks with WHERE path IN (...) in chunks

### src/inject.ts

  [medium] performance — inject.ts:161
    appendixCacheKey calls statSync on both MEMORY.md files every turn (2 syscalls/turn)
    > Current design is acceptable (~0.1ms); consider stat caching with short TTL if profiling shows cost

---

## Low Priority

### src/clear.ts

  [low] performance — clear.ts:98
    linkedSessionIds runs 8 separate queries across 4 tagged tables
    > Combine into a single UNION ALL query to reduce round-trips from 8 to 1

### src/index.ts

  [low] maintainability — index.ts:1
    index.ts at 631 lines contains loosely coupled functions (writer setup, auto-pass)
    > Extract `runWriter`, `assetSnapshot`, `maybeAutoPass` into dedicated modules

### src/history.ts

  [low] maintainability — history.ts:211
    Nested try/catch with 3 levels of nesting and multiple `continue` statements
    > Extract inner per-file logic into `backfillFile()` helper to flatten nesting

### src/inject.ts

  [low] performance — inject.ts:92
    WeakMap caches 2 prepared statements per DB handle; pattern should be documented
    > Document the WeakMap caching pattern as standard for new per-turn prepared statements

  [low] maintainability — inject.ts:96
    WeakMap cache key built from 10+ string-joined fields — fragile when adding fields
    > Add a comment listing every field in the key and why each matters for cache invalidation

### src/actors.ts

  [low] performance — actors.ts:175
    ActorLedger.exists() runs SELECT 1 before every non-created event
    > Cache in activeIds Map — if actor is in activeIds, it exists; only query DB on miss

### src/config.ts

  [low] maintainability — config.ts:80
    mergeConfig uses long chain of if/typeof guards; adding a field requires 3-place lockstep update
    > Add a comment block listing: when adding a config field, update interface, DEFAULT_CONFIG, and mergeConfig

---

## Info

### src/checkpoint.ts

  [info] performance — checkpoint.ts:224
    serializeDelta builds large string via blocks.join(), truncated by DELTA_CAP
    > No change needed — DELTA_CAP bounds output at 100K chars (~25K tokens)

  [info] performance — checkpoint.ts:280
    crossedSet calls JSON.parse on first access per session, result cached
    > No change needed — single parse per session, result cached in memory

### src/db.ts

  [info] performance — db.ts:145
    FTS5 tokenizers configured at schema creation — correct and efficient
    > No change needed

  [info] performance — db.ts:423
    validationSummary runs 2 queries + JS histogram build; user-initiated only
    > No change needed — data volume bounded by checkpoint frequency

### src/fts.ts

  [info] performance — fts.ts:93
    memorySearch overfetches by limit*3 then applies score floor; creates new array
    > No change needed — standard overfetch+floor pattern, bounded allocation

---

## Reviewers

- **Code Quality Engineer**: 8 findings (3 medium, 5 low)
- **Performance Engineer**: 20 findings (3 high, 7 medium, 6 low, 4 info)
