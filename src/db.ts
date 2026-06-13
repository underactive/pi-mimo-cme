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

/** Sequential migrations keyed by PRAGMA user_version. */
const MIGRATIONS: string[] = [SCHEMA_V1];

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
