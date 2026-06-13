/**
 * Lazy reconcile: walk the memory tree (+ optional Claude Code dirs), upsert
 * rows whose size-mtime fingerprint changed, prune rows for vanished files.
 * Files are the source of truth; this keeps the FTS index derived from them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ccProjectsRoot, typeFromKey } from "./paths.ts";

/**
 * Cap a single file's indexed body. Curated memory files are small (the largest
 * inject cap is ~44KB), but the cc scope indexes arbitrary
 * ~/.claude/projects/*​/memory/*.md the user doesn't control — without a cap a
 * runaway file would be read whole into memory and tokenized synchronously
 * inside the reconcile transaction. 256KB leaves generous headroom for any real
 * memory file; the tool tells the agent to Read the path for the full body.
 */
const MAX_INDEXED_BODY_BYTES = 256 * 1024;

export interface ReconcileOptions {
  root: string;
  ccIndex?: boolean;
  /** Override of ~/.claude/projects for tests. */
  ccRoot?: string;
}

export interface ReconcileStats {
  indexed: number;
  removed: number;
  /**
   * Subset of `indexed` whose scope is "global" — the honest "promoted to
   * global" count for the dream notification. Files are the source of truth,
   * so the truthful way to report what a dream did is to re-derive the index
   * diff (this), not to parse the dream agent's freeform prose summary.
   */
  globalIndexed: number;
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
  const stats: ReconcileStats = { indexed: 0, removed: 0, globalIndexed: 0 };
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
      let stat: fs.BigIntStats;
      try {
        // bigint stat exposes mtimeNs: on nanosecond-mtime filesystems (APFS,
        // ext4) this detects a same-size edit that lands within the same
        // millisecond — which a millisecond fingerprint would skip. The agent
        // can Edit MEMORY.md in place, so same-size rewrites are realistic.
        // Same single statSync cost; we still avoid reading unchanged bodies.
        stat = fs.statSync(file.path, { bigint: true });
      } catch {
        continue;
      }
      const fingerprint = `${stat.size}-${stat.mtimeNs}`;
      const existing = selectFp.get(file.path) as { fingerprint: string } | undefined;
      if (existing?.fingerprint === fingerprint) continue;
      let body: string;
      try {
        body = fs.readFileSync(file.path, "utf8");
      } catch {
        continue;
      }
      if (body.length > MAX_INDEXED_BODY_BYTES) body = body.slice(0, MAX_INDEXED_BODY_BYTES);
      const type = file.scope === "cc" ? ccTypeFromFrontmatter(body) : file.type;
      upsert.run(file.path, file.scope, file.scopeId, type, body, fingerprint, Date.now());
      stats.indexed += 1;
      if (file.scope === "global") stats.globalIndexed += 1;
    }
    // Prune any indexed row not produced by the current walk — covers both
    // deleted files and scopes no longer walked (e.g. cc once ccIndex is toggled
    // off, whose files still exist on disk but must leave the index).
    const allRows = db.prepare("SELECT id, path FROM memory_fts").all() as unknown as {
      id: number;
      path: string;
    }[];
    const del = db.prepare("DELETE FROM memory_fts WHERE id = ?");
    for (const row of allRows) {
      if (seen.has(row.path)) continue;
      del.run(row.id);
      stats.removed += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return stats;
}
