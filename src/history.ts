/**
 * Layer 4: continuous history indexing from message_end events plus an
 * idempotent JSONL backfill of past sessions for the current project.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { metaGet, metaSet } from "./db.ts";

export type HistoryKind =
  | "user_text"
  | "assistant_text"
  | "tool_input"
  | "tool_error"
  | "reasoning"
  | "tool_output";

export const ALL_HISTORY_KINDS: readonly HistoryKind[] = [
  "user_text",
  "assistant_text",
  "tool_input",
  "tool_error",
  "reasoning",
  "tool_output",
];

const TOOL_INPUT_PREVIEW_BYTES = 2048;
const TOOL_BODY_CAP_BYTES = 8192;

export interface ExtractedRow {
  kind: HistoryKind;
  toolName: string | null;
  body: string;
  timestamp: number;
}

interface ContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

interface MessageLike {
  role?: string;
  content?: string | ContentPart[];
  isError?: boolean;
  toolName?: string;
  timestamp?: number;
}

function joinTextParts(parts: ContentPart[], field: "text" | "thinking"): string {
  return parts
    .filter((p) => p && typeof p[field] === "string")
    .map((p) => p[field] as string)
    .join("\n")
    .trim();
}

/**
 * Extracts indexable rows from a finalized message. Custom / bashExecution /
 * branchSummary / compactionSummary roles are skipped — they are harness
 * artifacts, not conversation.
 */
export function extractRows(message: unknown, kinds: readonly string[]): ExtractedRow[] {
  const m = message as MessageLike;
  if (!m || typeof m !== "object") return [];
  const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  const rows: ExtractedRow[] = [];
  if (m.role === "user") {
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? joinTextParts(m.content, "text")
          : "";
    if (text.trim()) rows.push({ kind: "user_text", toolName: null, body: text, timestamp: ts });
  } else if (m.role === "assistant" && Array.isArray(m.content)) {
    const text = joinTextParts(
      m.content.filter((p) => p?.type === "text"),
      "text",
    );
    if (text) rows.push({ kind: "assistant_text", toolName: null, body: text, timestamp: ts });
    const thinking = joinTextParts(
      m.content.filter((p) => p?.type === "thinking"),
      "thinking",
    );
    if (thinking) rows.push({ kind: "reasoning", toolName: null, body: thinking, timestamp: ts });
    for (const part of m.content) {
      if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
      let preview = "";
      try {
        preview = JSON.stringify(part.arguments ?? {});
      } catch {
        preview = "[unserializable input]";
      }
      rows.push({
        kind: "tool_input",
        toolName: part.name,
        body: `${part.name} ${preview}`.slice(0, TOOL_INPUT_PREVIEW_BYTES),
        timestamp: ts,
      });
    }
  } else if (m.role === "toolResult") {
    const text = Array.isArray(m.content) ? joinTextParts(m.content, "text") : "";
    if (text.trim()) {
      rows.push({
        kind: m.isError ? "tool_error" : "tool_output",
        toolName: typeof m.toolName === "string" ? m.toolName : null,
        body: text.slice(0, TOOL_BODY_CAP_BYTES),
        timestamp: ts,
      });
    }
  }
  return rows.filter((r) => kinds.includes(r.kind));
}

/** Maintains per-session seq counters and inserts extracted rows. */
export class HistoryIndexer {
  private db: DatabaseSync;
  private kinds: readonly string[];
  private seqCounters = new Map<string, number>();

  constructor(db: DatabaseSync, kinds: readonly string[]) {
    this.db = db;
    this.kinds = kinds;
  }

  private nextSeq(sessionId: string): number {
    let current = this.seqCounters.get(sessionId);
    if (current === undefined) {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM history_fts WHERE session_id = ?")
        .get(sessionId) as { max_seq: number };
      current = row.max_seq;
    }
    const next = current + 1;
    this.seqCounters.set(sessionId, next);
    return next;
  }

  indexMessage(sessionId: string, projectId: string, message: unknown): number {
    const rows = extractRows(message, this.kinds);
    if (rows.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO history_fts (session_id, project_id, seq, kind, tool_name, body, time_created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        insert.run(sessionId, projectId, this.nextSeq(sessionId), row.kind, row.toolName, row.body, row.timestamp);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return rows.length;
  }
}

export interface BackfillStats {
  files: number;
  rows: number;
}

/**
 * Idempotent backfill of a project's session JSONL files. Skips files whose
 * size-mtime fingerprint matches meta, and skips the live session (the
 * HistoryIndexer owns it; a later session start will pick the file up).
 */
/**
 * Async chunked variant of backfillProject. Processes one JSONL file per
 * event-loop tick so that long backlogs don't block rendering of other
 * extensions (statusline animations, etc.). Calls `onProgress` after each
 * file that produced new rows so the caller can update counters/UI
 * incrementally.
 */
export async function backfillProjectAsync(
  db: DatabaseSync,
  jsonlDir: string,
  projectId: string,
  kinds: readonly string[],
  currentSessionId?: string,
  onProgress?: (delta: BackfillStats) => void,
): Promise<BackfillStats> {
  const stats: BackfillStats = { files: 0, rows: 0 };
  let entries: string[];
  try {
    entries = fs.readdirSync(jsonlDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return stats;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO history_fts (session_id, project_id, seq, kind, tool_name, body, time_created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const name of entries) {
    const fileDelta = backfillOneFile(db, insert, path.join(jsonlDir, name), projectId, kinds, currentSessionId);
    if (fileDelta) {
      stats.files += 1;
      stats.rows += fileDelta;
      onProgress?.({ files: 1, rows: fileDelta });
    }
    // Yield to the event loop between files so other extensions can render.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return stats;
}

export function backfillProject(
  db: DatabaseSync,
  jsonlDir: string,
  projectId: string,
  kinds: readonly string[],
  currentSessionId?: string,
): BackfillStats {
  const stats: BackfillStats = { files: 0, rows: 0 };
  let entries: string[];
  try {
    entries = fs.readdirSync(jsonlDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return stats;
  }
  // Hoist prepared statement outside the per-file loop — it doesn't depend on
  // any per-file state and node:sqlite recompiles on every prepare().
  const insert = db.prepare(
    `INSERT OR IGNORE INTO history_fts (session_id, project_id, seq, kind, tool_name, body, time_created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const name of entries) {
    const delta = backfillOneFile(db, insert, path.join(jsonlDir, name), projectId, kinds, currentSessionId);
    if (delta) {
      stats.files += 1;
      stats.rows += delta;
    }
  }
  return stats;
}

/**
 * Process a single JSONL session file. Returns the number of rows inserted,
 * or 0/undefined if the file was skipped (fingerprint match, missing, etc.).
 * Shared by both the sync `backfillProject` and the async chunked variant.
 */
function backfillOneFile(
  db: DatabaseSync,
  insert: ReturnType<DatabaseSync["prepare"]>,
  file: string,
  projectId: string,
  kinds: readonly string[],
  currentSessionId?: string,
): number | undefined {
  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(file, { bigint: true });
  } catch {
    return undefined;
  }
  const fingerprint = `${stat.size}-${stat.mtimeNs}`;
  const metaKey = `backfill:${file}`;
  if (metaGet(db, metaKey) === fingerprint) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let sessionId: string | undefined;
  const messages: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 8 || !line.includes('"type"')) continue;
    let entry: { type?: string; id?: string; message?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session" && typeof entry.id === "string") sessionId = entry.id;
    else if (entry.type === "message" && entry.message) messages.push(entry.message);
  }
  if (!sessionId) return undefined;
  if (currentSessionId && sessionId === currentSessionId) return undefined;
  let rows = 0;
  db.exec("BEGIN");
  try {
    let seq = 0;
    for (const message of messages) {
      for (const row of extractRows(message, kinds)) {
        seq += 1;
        insert.run(sessionId, projectId, seq, row.kind, row.toolName, row.body, row.timestamp);
        rows += 1;
      }
    }
    metaSet(db, metaKey, fingerprint);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows;
}
