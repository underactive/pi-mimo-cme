/**
 * Memory-path guard (adapted from MiMoCode's memory-path-guard): the main
 * agent may write ONLY its own notes.md and the project MEMORY.md. The
 * checkpoint writer (in-process, built with a noExtensions resource loader) and
 * the dream/distill subprocesses (--no-extensions) all run without this
 * extension bound, so they are unaffected.
 */
import * as path from "node:path";

export interface GuardVerdict {
  allowed: boolean;
  reason?: string;
}

export function checkMemoryWrite(
  root: string,
  sid: string,
  pid: string,
  targetPath: string,
  cwd?: string,
): GuardVerdict {
  const resolved = path.resolve(cwd ?? process.cwd(), targetPath);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { allowed: true }; // outside the memory root — none of our business
  }
  const allowed = [
    path.join("sessions", sid, "notes.md"),
    path.join("projects", pid, "MEMORY.md"),
  ];
  if (allowed.includes(rel)) return { allowed: true };

  const notes = path.join(rootResolved, "sessions", sid, "notes.md");
  const projectMemory = path.join(rootResolved, "projects", pid, "MEMORY.md");
  const base = path.basename(rel);
  const tasksPrefix = path.join("sessions", sid, "tasks") + path.sep;
  let detail: string;
  if (base === "checkpoint.md" || /^checkpoint-/.test(base)) {
    detail = "checkpoint.md is the checkpoint writer's domain — the main agent never edits it.";
  } else if (rel.startsWith(tasksPrefix)) {
    detail =
      "the tasks/ subtree holds subagent progress journals — the extension synthesizes those from subagent lifecycle events; the main agent never writes there.";
  } else if (rel === path.join("global", "MEMORY.md") || rel.startsWith("global" + path.sep)) {
    detail =
      "global memory is read-only from the agent side; the dream pass promotes entries there.";
  } else if (rel.startsWith("sessions" + path.sep) && !rel.startsWith(path.join("sessions", sid))) {
    detail = "that file belongs to another session.";
  } else if (rel.startsWith("projects" + path.sep) && !rel.startsWith(path.join("projects", pid))) {
    detail = "that file belongs to another project.";
  } else {
    detail =
      "don't create ad-hoc memory files (no learning.md, no scratch.md — notes.md is your ONLY legal scratchpad).";
  }
  return {
    allowed: false,
    reason:
      `mimo-cme memory guard: write to ${resolved} blocked — ${detail} ` +
      `Allowed targets: ${notes} (free-form notes) and ${projectMemory} (explicit user rules / durable knowledge).`,
  };
}
