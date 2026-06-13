/**
 * FTS query building (MiMoCode's buildFtsQuery, OR + AND variants), memory
 * search with the relative score floor, and history search / around.
 */
import type { DatabaseSync } from "node:sqlite";

/**
 * MiMoCode's buildFtsQuery, verbatim port. FTS5 MATCH grammar crashes on raw
 * user punctuation; each alphanumeric run becomes a phrase-quoted literal.
 * OR-join, not AND: AND returns 0 results for nearly all multi-word queries;
 * OR lets BM25 rank by how many / how rare the matched tokens are, and the
 * caller applies a score floor to drop common-word-only noise. \p{L} includes CJK.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Independent copy for the history module (AND-join), mirroring MiMoCode's
 * "independent copy from memory/fts-query.ts so the two modules can evolve apart".
 */
export function buildHistoryFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export interface MemoryHit {
  path: string;
  scope: string;
  scope_id: string;
  type: string;
  snippet: string;
  score: number;
}

/**
 * Relative score floor (MiMoCode): keep row i if i === 0 || score >= top * ratio.
 * Relative, not absolute, because BM25 magnitudes are corpus-size-dependent —
 * in a tiny corpus every score collapses toward 0 (low IDF). The #1 result is
 * ALWAYS kept. ratio <= 0 disables the floor.
 */
export function applyScoreFloor<T extends { score: number }>(
  rows: T[],
  limit: number,
  ratio: number,
): T[] {
  if (rows.length === 0) return rows;
  const top = rows[0]!.score;
  const kept = rows.filter((row, i) => i === 0 || ratio <= 0 || row.score >= top * ratio);
  return kept.slice(0, limit);
}

export interface MemorySearchOptions {
  query: string;
  scope?: string;
  scopeId?: string;
  type?: string;
  limit?: number;
  floorRatio?: number;
}

export function memorySearch(db: DatabaseSync, opts: MemorySearchOptions): MemoryHit[] {
  const match = buildFtsQuery(opts.query);
  if (match === null) return [];
  const limit = Math.max(1, opts.limit ?? 10);
  const overFetch = Math.min(limit * 3, 50);
  let sql = `SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type,
       snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
       bm25(memory_fts_idx) AS score
FROM memory_fts_idx
JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
WHERE memory_fts_idx MATCH ?`;
  const params: (string | number)[] = [match];
  if (opts.scope) {
    sql += " AND memory_fts.scope = ?";
    params.push(opts.scope);
  }
  if (opts.scopeId) {
    sql += " AND memory_fts.scope_id = ?";
    params.push(opts.scopeId);
  }
  if (opts.type) {
    sql += " AND memory_fts.type = ?";
    params.push(opts.type);
  }
  sql += " ORDER BY score LIMIT ?";
  params.push(overFetch);
  const raw = db.prepare(sql).all(...params) as unknown as MemoryHit[];
  // bm25() is lower-is-better (negative); sign-flip to higher-is-better.
  const flipped = raw.map((r) => ({ ...r, score: -r.score }));
  return applyScoreFloor(flipped, limit, opts.floorRatio ?? 0.15);
}

export interface HistoryHit {
  message_id: string;
  session_id: string;
  kind: string;
  tool_name: string | null;
  snippet: string;
  time_created: number;
  score: number;
}

export interface HistorySearchOptions {
  query: string;
  /** "project" (default, filter by projectId) or "global" (no project filter). */
  scope?: string;
  projectId: string;
  sessionId?: string;
  kinds?: string[];
  toolName?: string;
  timeAfter?: number;
  timeBefore?: number;
  limit?: number;
}

export const HISTORY_MAX_LIMIT = 50;

export function historySearch(db: DatabaseSync, opts: HistorySearchOptions): HistoryHit[] {
  const match = buildHistoryFtsQuery(opts.query);
  if (match === null) return [];
  const limit = Math.min(Math.max(1, opts.limit ?? 10), HISTORY_MAX_LIMIT);
  let sql = `SELECT history_fts.session_id, history_fts.seq, history_fts.kind, history_fts.tool_name,
       snippet(history_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
       history_fts.time_created,
       bm25(history_fts_idx) AS score
FROM history_fts_idx
JOIN history_fts ON history_fts.id = history_fts_idx.rowid
WHERE history_fts_idx MATCH ?`;
  const params: (string | number)[] = [match];
  if ((opts.scope ?? "project") !== "global") {
    sql += " AND history_fts.project_id = ?";
    params.push(opts.projectId);
  }
  if (opts.sessionId) {
    sql += " AND history_fts.session_id = ?";
    params.push(opts.sessionId);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    sql += ` AND history_fts.kind IN (${opts.kinds.map(() => "?").join(", ")})`;
    params.push(...opts.kinds);
  }
  if (opts.toolName) {
    sql += " AND history_fts.tool_name = ?";
    params.push(opts.toolName);
  }
  if (typeof opts.timeAfter === "number") {
    sql += " AND history_fts.time_created >= ?";
    params.push(opts.timeAfter);
  }
  if (typeof opts.timeBefore === "number") {
    sql += " AND history_fts.time_created <= ?";
    params.push(opts.timeBefore);
  }
  sql += " ORDER BY score LIMIT ?";
  params.push(limit);
  const raw = db.prepare(sql).all(...params) as unknown as (Omit<HistoryHit, "message_id"> & {
    seq: number;
  })[];
  return raw.map((r) => ({
    message_id: `${r.session_id}#${r.seq}`,
    session_id: r.session_id,
    kind: r.kind,
    tool_name: r.tool_name,
    snippet: r.snippet,
    time_created: r.time_created,
    score: -r.score,
  }));
}

export interface HistoryRow {
  message_id: string;
  session_id: string;
  seq: number;
  kind: string;
  tool_name: string | null;
  body: string;
  time_created: number;
}

export const AROUND_MAX_BYTES = 20_000;

export interface AroundResult {
  rows: HistoryRow[];
  /** Set when output was cut to AROUND_MAX_BYTES. */
  overflow: boolean;
}

/**
 * ±N history rows by seq within the anchor's session. Anchor message_id is the
 * synthetic "<sid>#<seq>" produced by historySearch.
 */
export function historyAround(
  db: DatabaseSync,
  messageId: string,
  before = 5,
  after = 5,
): AroundResult | { error: string } {
  const hash = messageId.lastIndexOf("#");
  if (hash <= 0) return { error: `Invalid message_id "${messageId}" — expected "<session_id>#<seq>".` };
  const sid = messageId.slice(0, hash);
  const seq = Number.parseInt(messageId.slice(hash + 1), 10);
  if (!Number.isFinite(seq)) {
    return { error: `Invalid message_id "${messageId}" — seq is not a number.` };
  }
  const rows = db
    .prepare(
      `SELECT session_id, seq, kind, tool_name, body, time_created
       FROM history_fts WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
    )
    .all(sid, seq - Math.max(0, before), seq + Math.max(0, after)) as unknown as Omit<
    HistoryRow,
    "message_id"
  >[];
  let total = 0;
  let overflow = false;
  const kept: HistoryRow[] = [];
  for (const row of rows) {
    if (total + row.body.length > AROUND_MAX_BYTES) {
      const remaining = AROUND_MAX_BYTES - total;
      if (remaining > 0) {
        kept.push({ ...row, body: row.body.slice(0, remaining), message_id: `${row.session_id}#${row.seq}` });
        total = AROUND_MAX_BYTES;
      }
      overflow = true;
      break;
    }
    total += row.body.length;
    kept.push({ ...row, message_id: `${row.session_id}#${row.seq}` });
  }
  return { rows: kept, overflow };
}
