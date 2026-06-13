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
  // Unique root under pi's agent dir (NOT the generic "memory" — that name is the
  // most collision-prone and the likeliest segment a future pi-native memory
  // feature would claim). The package name is globally unique, so subfolders
  // (projects/, sessions/, global/) underneath need no further prefixing.
  return path.join(agentDir(), "pi-mimo-cme");
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

export function deltaPath(sid: string, n: number, root: string = memoryRoot()): string {
  return path.join(sessionDir(sid, root), `delta-${n}.md`);
}

export type MemoryType = "memory" | "checkpoint" | "notes" | "free";

/** Type detection from the file key, like MiMoCode's paths.ts regexes. */
export function typeFromKey(key: string): MemoryType {
  const base = path.basename(key).toLowerCase();
  if (/^memory/.test(base)) return "memory";
  if (/^checkpoint/.test(base)) return "checkpoint";
  if (/^notes/.test(base)) return "notes";
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
