/**
 * Phase 1 of SCALING-RETENTION-PLAN: cached footer counters.
 *
 * The live footer (`🧠 <idx> idx · <hist> hist`) used to run two COUNT(*)
 * queries on EVERY message_end and turn_end. `COUNT(*) FROM history_fts WHERE
 * project_id = ?` is an index range scan over this project's history rows —
 * cheap at first, but it scales with the table and becomes measurable per-turn
 * latency once history reaches hundreds of thousands of rows (the classic "fine
 * until it isn't" footgun).
 *
 * Instead we keep two integers in memory: seed them once per session with a
 * single COUNT(*) each, then mutate them incrementally from deltas the existing
 * insert paths already return (indexMessage / backfillProject). The per-turn
 * footer then reads two integers and runs ZERO SQL.
 *
 * Discipline (SCALING-RETENTION-PLAN shared invariant #4):
 *   - Per-turn paths only ever do integer arithmetic (`addHistory`).
 *   - Any INFREQUENT batch op that mutates row counts (reconcile, and the
 *     history/session prunes added in phases 2–3) reseeds the affected counter
 *     from COUNT(*) — exact, and off the hot path. reconcile can't derive an
 *     exact delta (its `indexed` counts inserts AND updates), which is precisely
 *     why it reseeds rather than increments.
 *   - Drift from a missed insert (e.g. `INSERT OR IGNORE` dropping a duplicate
 *     seq) self-heals: every session_start reseeds both counters from scratch,
 *     so any skew lives at most one session.
 *
 * Known limitation (documented, accepted): on the shared machine-wide
 * memory.db, another concurrent session inserting history rows won't bump THIS
 * session's cached `projHist`. The footer is a live hint for the current
 * session; the next session_start reseeds it.
 */
import type { DatabaseSync } from "node:sqlite";

export interface FooterCountsSnapshot {
  /** memory_fts rows: every indexed memory layer (global/project/session md). */
  memIdx: number;
  /** history_fts rows for THIS project: the layer-4 capture. */
  projHist: number;
}

export class FooterCounts {
  private memIdx = 0;
  private projHist = 0;

  /** Seed both counters from scratch — once per session_start. */
  seed(db: DatabaseSync, pid: string): void {
    this.reseedMemory(db);
    this.reseedHistory(db, pid);
  }

  /**
   * Apply a per-turn history insert delta — the row count indexMessage /
   * backfillProject already return. Pure arithmetic: no SQL on the hot path.
   */
  addHistory(n: number): void {
    this.projHist += n;
  }

  /** Exact reseed of memIdx after a batch op that touched memory_fts (reconcile). */
  reseedMemory(db: DatabaseSync): void {
    this.memIdx = (db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n;
  }

  /**
   * Exact reseed of projHist after a batch op that touched history_fts. Unused
   * in phase 1's per-turn paths (history is insert-only here, so `addHistory`
   * suffices); phases 2–3 call this after a history prune.
   */
  reseedHistory(db: DatabaseSync, pid: string): void {
    this.projHist = (
      db.prepare("SELECT COUNT(*) AS n FROM history_fts WHERE project_id = ?").get(pid) as {
        n: number;
      }
    ).n;
  }

  /** Read-only snapshot for the footer (the only per-turn read). */
  snapshot(): FooterCountsSnapshot {
    return { memIdx: this.memIdx, projHist: this.projHist };
  }
}
