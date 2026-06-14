/**
 * Path resolution for the memory tree. Pure module — no pi imports, so tests
 * can run it under plain `node --test`.
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Replicates pi's getAgentDir() (dist/config.js) byte-for-byte semantics:
 * PI_CODING_AGENT_DIR override (with ~ expansion), else ~/.pi/agent.
 * Local copy so pure modules don't have to import the whole pi package.
 */
export function agentDir(): string {
  const env = process.env["PI_CODING_AGENT_DIR"];
  if (env) return expandTilde(env);
  return path.join(os.homedir(), ".pi", "agent");
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function memoryRoot(): string {
  // Lives at <pi-home>/cme — a top-level sibling of the agent dir (default
  // ~/.pi/cme), NOT buried under it. Derived from dirname(agentDir()) so the
  // tree still relocates with PI_CODING_AGENT_DIR. "cme" is short and distinct
  // enough that a future pi-native memory feature is unlikely to claim it;
  // subfolders (projects/, sessions/, global/) underneath need no prefixing.
  return path.join(path.dirname(agentDir()), "cme");
}

export function dbPath(root: string = memoryRoot()): string {
  return path.join(root, "memory.db");
}

export function configPath(root: string = memoryRoot()): string {
  return path.join(root, "config.json");
}

export function logsDir(root: string = memoryRoot()): string {
  return path.join(root, "logs");
}

/** pid = sha256(absolute cwd) hex, truncated to 12 chars (MiMoCode's resolveProjectId). */
export function projectId(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function globalDir(root: string = memoryRoot()): string {
  return path.join(root, "global");
}

export function globalMemoryPath(root: string = memoryRoot()): string {
  return path.join(globalDir(root), "MEMORY.md");
}

export function projectDir(pid: string, root: string = memoryRoot()): string {
  return path.join(root, "projects", pid);
}

export function projectMemoryPath(pid: string, root: string = memoryRoot()): string {
  return path.join(projectDir(pid, root), "MEMORY.md");
}

export function sessionDir(sid: string, root: string = memoryRoot()): string {
  return path.join(root, "sessions", sid);
}

export function checkpointPath(sid: string, root: string = memoryRoot()): string {
  return path.join(sessionDir(sid, root), "checkpoint.md");
}

export function notesPath(sid: string, root: string = memoryRoot()): string {
  return path.join(sessionDir(sid, root), "notes.md");
}

/**
 * Per-session subagent (actor) workspace, mirroring MiMoCode's
 * `sessions/<sid>/tasks/<actorId>/`. Each subagent gets a `progress.md` journal
 * synthesized from its completion payload (Phase 2). The directory is under the
 * memory root, so reconcile's tree walk indexes the journals automatically.
 */
export function tasksDir(sid: string, root: string = memoryRoot()): string {
  return path.join(sessionDir(sid, root), "tasks");
}

export function actorTaskDir(sid: string, actorId: string, root: string = memoryRoot()): string {
  return path.join(tasksDir(sid, root), sanitizeActorId(actorId));
}

export function progressPath(sid: string, actorId: string, root: string = memoryRoot()): string {
  return path.join(actorTaskDir(sid, actorId, root), "progress.md");
}

/**
 * Actor IDs come from another extension's event payloads, so they could in
 * theory contain path separators or traversal segments. Collapse anything that
 * isn't a safe filename char to "_" so an actor ID can never escape its tasks
 * subtree — the journals are written by the extension with raw fs (the path
 * guard only constrains the main agent's tool calls, not our own writes).
 */
export function sanitizeActorId(actorId: string): string {
  const safe = actorId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return safe.length > 0 ? safe.slice(0, 128) : "unknown";
}

export type MemoryType = "memory" | "checkpoint" | "notes" | "progress" | "free";

/** Type detection from the file key, like MiMoCode's paths.ts regexes. */
export function typeFromKey(key: string): MemoryType {
  const base = path.basename(key).toLowerCase();
  if (/^memory/.test(base)) return "memory";
  if (/^checkpoint/.test(base)) return "checkpoint";
  if (/^notes/.test(base)) return "notes";
  if (/^progress/.test(base)) return "progress";
  return "free";
}

/**
 * Directory holding the session JSONL files for a project, replicating pi's
 * session-manager.js escaping: `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`.
 */
export function sessionsJsonlDir(cwd: string, agent: string = agentDir()): string {
  const resolved = path.resolve(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agent, "sessions", safe);
}

/** Default root of Claude Code project memory (for the optional "cc" scope). */
export function ccProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}
