/**
 * SQLite open/migrate (node:sqlite DatabaseSync), schema SQL, meta helpers.
 * The DB is a derived index over the markdown layers plus the native layer-4
 * history store — deleting it loses no curated memory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_V1 = `
CREATE TABLE memory_fts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  scope_id TEXT DEFAULT '' NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_indexed_at INTEGER NOT NULL
);
CREATE INDEX memory_fts_scope_idx ON memory_fts (scope, scope_id);
CREATE INDEX memory_fts_type_idx ON memory_fts (type);
CREATE VIRTUAL TABLE memory_fts_idx USING fts5(
  body,
  content='memory_fts',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);
-- MiMoCode war story, preserved: external content FTS5 vtab requires the 'delete'
-- magic command to remove OLD body's tokens, NOT a plain DELETE FROM the vtab.
-- The plain DELETE FROM pattern is contentless-mode syntax misapplied to
-- external-content mode, leaving stale tokens accumulating until vtab corrupts.
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', OLD.id, OLD.body);
END;
CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_fts BEGIN
  INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', OLD.id, OLD.body);
  INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;

CREATE TABLE history_fts (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  body TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX history_fts_session_idx ON history_fts (session_id, time_created);
CREATE INDEX history_fts_project_idx ON history_fts (project_id, time_created);
CREATE VIRTUAL TABLE history_fts_idx USING fts5(
  body,
  content='history_fts',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER history_fts_ai AFTER INSERT ON history_fts BEGIN
  INSERT INTO history_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER history_fts_ad AFTER DELETE ON history_fts BEGIN
  INSERT INTO history_fts_idx(history_fts_idx, rowid, body) VALUES('delete', OLD.id, OLD.body);
END;
CREATE TRIGGER history_fts_au AFTER UPDATE ON history_fts BEGIN
  INSERT INTO history_fts_idx(history_fts_idx, rowid, body) VALUES('delete', OLD.id, OLD.body);
  INSERT INTO history_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
END;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * Phase 2: the actor (subagent) ledger. A derived record of pi-subagents
 * lifecycle events (subagents:created|started|completed|failed|compacted),
 * consumed purely as serializable `pi.events` payloads — no object sharing with
 * the other extension. The checkpoint writer reconciles this into checkpoint
 * §4 Subagents; the rebuild dump surfaces in-flight actors. Keyed by
 * (session_id, id) because actor IDs are unique within a run but the DB is
 * machine-wide. Like every other table here it is a DERIVED index: dropping it
 * loses only the actor ledger, never a curated memory file (the progress.md
 * journals on disk are the durable artifact).
 */
const SCHEMA_V2 = `
CREATE TABLE actor (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  tool_uses INTEGER NOT NULL DEFAULT 0,
  compaction_count INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX actor_session_idx ON actor (session_id, updated_at);
`;

/**
 * Phase 3 prerequisite ("measure first"): per-checkpoint instrumentation for the
 * in-process writer. SUBAGENT-INTEGRATION-PLAN §6 gates the true `fork=true`
 * prefix-cache work on profiling showing the writer's cold-start token cost
 * actually matters — so we record that cost here before deciding to build it.
 *
 * Each row is one writer run: its OWN token usage (`writer_*` / `cache_*`, from
 * the writer session's getSessionStats) against the parent context size at fire
 * time (`parent_tokens` — what a fork would force the writer to carry every
 * checkpoint) and the condensed delta it actually received (`delta_*`). The
 * decision falls out of two columns: if `writer_input` (full-price cold start)
 * stays far below `parent_tokens`, a fork is strictly worse and Phase 3 stays
 * closed. `cache_read` here is also the Phase 3 acceptance signal: today it is
 * ~0 (no reuse); a working fork would make it > 0. A derived table like every
 * other here — dropping it loses only the profiling log.
 */
const SCHEMA_V3 = `
CREATE TABLE writer_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  writer_input INTEGER NOT NULL DEFAULT 0,
  writer_output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  writer_total INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  delta_chars INTEGER NOT NULL DEFAULT 0,
  delta_tokens_est INTEGER NOT NULL DEFAULT 0,
  parent_tokens INTEGER,
  parent_context_window INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX writer_metrics_session_idx ON writer_metrics (session_id, ts);
CREATE INDEX writer_metrics_project_idx ON writer_metrics (project_id, ts);
`;

/** Sequential migrations keyed by PRAGMA user_version. */
const MIGRATIONS: string[] = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 2000");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function metaGet(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function metaDelete(db: DatabaseSync, key: string): void {
  db.prepare("DELETE FROM meta WHERE key = ?").run(key);
}

/** One writer run's instrumentation row (see SCHEMA_V3). */
export interface WriterMetricsRow {
  sessionId: string;
  projectId: string;
  ts: number;
  ok: boolean;
  /** Writer session's own token usage (getSessionStats().tokens). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
  /** The condensed conversation delta the writer received. */
  deltaChars: number;
  deltaTokensEst: number;
  /** Parent context size at fire time — what a fork would force the writer to carry. */
  parentTokens: number | null;
  parentContextWindow: number;
  messageCount: number;
  durationMs: number;
}

export function recordWriterMetrics(db: DatabaseSync, row: WriterMetricsRow): void {
  db.prepare(
    `INSERT INTO writer_metrics
      (session_id, project_id, ts, ok, writer_input, writer_output, cache_read, cache_write,
       writer_total, cost_usd, delta_chars, delta_tokens_est, parent_tokens, parent_context_window,
       message_count, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.sessionId,
    row.projectId,
    row.ts,
    row.ok ? 1 : 0,
    row.input,
    row.output,
    row.cacheRead,
    row.cacheWrite,
    row.total,
    row.costUsd,
    row.deltaChars,
    row.deltaTokensEst,
    row.parentTokens,
    row.parentContextWindow,
    row.messageCount,
    row.durationMs,
  );
}

/** Aggregate of recorded writer runs — the Phase 3 "measure first" readout. */
export interface WriterMetricsSummary {
  /** Total runs recorded (ok + failed). */
  n: number;
  okCount: number;
  avgInput: number;
  avgOutput: number;
  avgTotal: number;
  avgCacheRead: number;
  avgCacheWrite: number;
  avgCostUsd: number;
  avgDeltaTokensEst: number;
  /** null when no run captured a parent context size. */
  avgParentTokens: number | null;
  avgDurationMs: number;
}

/**
 * Averages across recorded writer runs, optionally scoped to one project. AVG()
 * ignores NULL parent_tokens, so avgParentTokens reflects only runs that
 * captured a size; the cast to Number normalizes node:sqlite's null/real return.
 */
export function writerMetricsSummary(
  db: DatabaseSync,
  opts: { projectId?: string } = {},
): WriterMetricsSummary {
  const where = opts.projectId ? "WHERE project_id = ?" : "";
  const params = opts.projectId ? [opts.projectId] : [];
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         COALESCE(SUM(ok), 0) AS ok_count,
         AVG(writer_input) AS avg_input,
         AVG(writer_output) AS avg_output,
         AVG(writer_total) AS avg_total,
         AVG(cache_read) AS avg_cache_read,
         AVG(cache_write) AS avg_cache_write,
         AVG(cost_usd) AS avg_cost,
         AVG(delta_tokens_est) AS avg_delta_tok,
         AVG(parent_tokens) AS avg_parent_tokens,
         AVG(duration_ms) AS avg_duration
       FROM writer_metrics ${where}`,
    )
    .get(...params) as Record<string, number | null>;
  const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));
  return {
    n: num(row["n"]),
    okCount: num(row["ok_count"]),
    avgInput: num(row["avg_input"]),
    avgOutput: num(row["avg_output"]),
    avgTotal: num(row["avg_total"]),
    avgCacheRead: num(row["avg_cache_read"]),
    avgCacheWrite: num(row["avg_cache_write"]),
    avgCostUsd: num(row["avg_cost"]),
    avgDeltaTokensEst: num(row["avg_delta_tok"]),
    avgParentTokens: row["avg_parent_tokens"] == null ? null : Number(row["avg_parent_tokens"]),
    avgDurationMs: num(row["avg_duration"]),
  };
}
