/**
 * Lazy reconcile: walk the memory tree (+ optional Claude Code dirs), upsert
 * rows whose size-mtime fingerprint changed, prune rows for vanished files.
 * Files are the source of truth; this keeps the FTS index derived from them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ccProjectsRoot, typeFromKey } from "./paths.ts";

export interface ReconcileOptions {
  root: string;
  ccIndex?: boolean;
  /** Override of ~/.claude/projects for tests. */
  ccRoot?: string;
}

export interface ReconcileStats {
  indexed: number;
  removed: number;
}

interface WalkedFile {
  path: string;
  scope: string;
  scopeId: string;
  type: string;
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Extracts metadata.type / type from a YAML frontmatter block (cc scope). */
export function ccTypeFromFrontmatter(body: string): string {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    const fm = m[1]!;
    const typeMatch = fm.match(/^\s*type:\s*["']?(\w+)["']?\s*$/m);
    const t = typeMatch?.[1];
    if (t === "feedback" || t === "project" || t === "reference" || t === "user") return t;
  }
  return "free";
}

function walkMemoryTree(opts: ReconcileOptions): WalkedFile[] {
  const files: WalkedFile[] = [];
  for (const file of listMarkdownFiles(path.join(opts.root, "global"))) {
    files.push({ path: file, scope: "global", scopeId: "", type: typeFromKey(file) });
  }
  for (const scope of ["projects", "sessions"] as const) {
    const scopeDir = path.join(opts.root, scope);
    let ids: fs.Dirent[] = [];
    try {
      ids = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      /* scope dir absent */
    }
    for (const entry of ids) {
      if (!entry.isDirectory()) continue;
      for (const file of listMarkdownFiles(path.join(scopeDir, entry.name))) {
        // delta-<n>.md is a transient writer handoff (raw conversation, layer-4
        // territory) — never index it as curated memory.
        if (scope === "sessions" && /^delta-\d+\.md$/.test(path.basename(file))) continue;
        files.push({ path: file, scope, scopeId: entry.name, type: typeFromKey(file) });
      }
    }
  }
  if (opts.ccIndex) {
    const ccRoot = opts.ccRoot ?? ccProjectsRoot();
    let slugs: fs.Dirent[] = [];
    try {
      slugs = fs.readdirSync(ccRoot, { withFileTypes: true });
    } catch {
      /* no claude dir */
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const memDir = path.join(ccRoot, slug.name, "memory");
      for (const file of listMarkdownFiles(memDir)) {
        files.push({ path: file, scope: "cc", scopeId: slug.name, type: "" });
      }
    }
  }
  return files;
}

export function reconcile(db: DatabaseSync, opts: ReconcileOptions): ReconcileStats {
  const files = walkMemoryTree(opts);
  const stats: ReconcileStats = { indexed: 0, removed: 0 };
  const selectFp = db.prepare("SELECT fingerprint FROM memory_fts WHERE path = ?");
  const upsert = db.prepare(
    `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       scope = excluded.scope, scope_id = excluded.scope_id, type = excluded.type,
       body = excluded.body, fingerprint = excluded.fingerprint,
       last_indexed_at = excluded.last_indexed_at`,
  );
  db.exec("BEGIN");
  try {
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.path);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file.path);
      } catch {
        continue;
      }
      const fingerprint = `${stat.size}-${stat.mtimeMs}`;
      const existing = selectFp.get(file.path) as { fingerprint: string } | undefined;
      if (existing?.fingerprint === fingerprint) continue;
      let body: string;
      try {
        body = fs.readFileSync(file.path, "utf8");
      } catch {
        continue;
      }
      const type = file.scope === "cc" ? ccTypeFromFrontmatter(body) : file.type;
      upsert.run(file.path, file.scope, file.scopeId, type, body, fingerprint, Date.now());
      stats.indexed += 1;
    }
    // Prune rows whose file vanished (covers walked scopes and toggled-off cc).
    const allRows = db.prepare("SELECT id, path FROM memory_fts").all() as unknown as {
      id: number;
      path: string;
    }[];
    const del = db.prepare("DELETE FROM memory_fts WHERE id = ?");
    for (const row of allRows) {
      if (seen.has(row.path)) continue;
      if (!fs.existsSync(row.path)) {
        del.run(row.id);
        stats.removed += 1;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return stats;
}
