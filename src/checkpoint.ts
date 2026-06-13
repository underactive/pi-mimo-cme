/**
 * Memory write path: context-usage thresholds, conversation-delta
 * serialization, the checkpoint-writer subprocess (queue depth 1, newest
 * wins), and memory-flush nudges.
 */
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { metaGet, metaSet } from "./db.ts";
import { checkpointPath, deltaPath, notesPath, projectMemoryPath, sessionDir } from "./paths.ts";
import { checkpointWriterPrompt } from "./prompts/checkpoint-writer.ts";
import { CHECKPOINT_TEMPLATE, MEMORY_TEMPLATE, NOTES_TEMPLATE, ensureFile } from "./templates.ts";

const TOOL_INPUT_CAP = 500;
const TOOL_RESULT_CAP = 500;
export const DELTA_FILE_CAP = 100_000;

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

interface MessageLike {
  role?: string;
  content?: string | ContentPart[];
  toolName?: string;
  isError?: boolean;
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap) + "…";
}

/**
 * Role-labeled markdown of the conversation delta. Tool calls/results are
 * condensed; the whole file is capped (~100KB) by dropping the head — the
 * newest content matters most to the writer.
 */
export function serializeDelta(messages: unknown[]): string {
  const blocks: string[] = [];
  for (const raw of messages) {
    const m = raw as MessageLike;
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n")
            : "";
      if (text.trim()) blocks.push(`### user\n\n${text.trim()}`);
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const lines: string[] = [];
      for (const part of m.content) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          lines.push(part.text.trim());
        } else if (part?.type === "toolCall" && typeof part.name === "string") {
          let input = "";
          try {
            input = JSON.stringify(part.arguments ?? {});
          } catch {
            input = "[unserializable]";
          }
          lines.push(`tool(${part.name}): ${clip(input, TOOL_INPUT_CAP)}`);
        }
      }
      if (lines.length > 0) blocks.push(`### assistant\n\n${lines.join("\n")}`);
    } else if (m.role === "toolResult") {
      const text = Array.isArray(m.content)
        ? m.content.filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n")
        : "";
      const label = m.isError ? "tool result (error)" : "tool result";
      const name = typeof m.toolName === "string" ? m.toolName : "?";
      if (text.trim()) blocks.push(`### ${label}: ${name}\n\n${clip(text.trim(), TOOL_RESULT_CAP)}`);
    }
  }
  let out = blocks.join("\n\n") + "\n";
  if (out.length > DELTA_FILE_CAP) {
    const dropped = out.length - DELTA_FILE_CAP;
    out = `[delta truncated: first ${dropped} bytes dropped — newest content kept]\n\n` + out.slice(dropped);
  }
  return out;
}

/** Newly crossed thresholds, ascending. */
export function newlyCrossed(
  percent: number,
  thresholds: readonly number[],
  alreadyCrossed: ReadonlySet<number>,
): number[] {
  return [...thresholds].sort((a, b) => a - b).filter((t) => percent >= t && !alreadyCrossed.has(t));
}

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResultLike>;

export interface CheckpointDeps {
  db: DatabaseSync;
  root: string;
  thresholds: readonly number[];
  maxWriterFailures: number;
  exec: ExecFn;
  /** argv prefix to invoke pi (e.g. [node, cli.js] or ["pi"]). */
  piCommand: string[];
  log: (message: string) => void;
  /**
   * Optional UI toast. The writer runs in a headless subprocess that has no
   * UI of its own, so the "checkpoint saved" moment can only surface here, in
   * the parent, when run() observes the child's exit code. No-op without a UI.
   */
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

interface WriterJob {
  sid: string;
  pid: string;
  cwd: string;
  deltaFile: string;
  /** Branch message count at serialization time — becomes last_checkpoint_seq. */
  messageCount: number;
}

export class CheckpointManager {
  private deps: CheckpointDeps;
  private crossed = new Map<string, Set<number>>();
  private nudged = new Map<string, Set<number>>();
  private running = false;
  private pending: WriterJob | null = null;
  private consecutiveFailures = 0;
  private waiters: (() => void)[] = [];

  constructor(deps: CheckpointDeps) {
    this.deps = deps;
  }

  private crossedSet(sid: string): Set<number> {
    let set = this.crossed.get(sid);
    if (!set) {
      set = new Set<number>();
      const stored = metaGet(this.deps.db, `crossed:${sid}`);
      if (stored) {
        try {
          for (const t of JSON.parse(stored) as number[]) set.add(t);
        } catch {
          /* corrupt meta — start fresh */
        }
      }
      this.crossed.set(sid, set);
    }
    return set;
  }

  /** Called from turn_end. Returns true when a writer run was scheduled. */
  maybeCheckpoint(args: {
    sid: string;
    pid: string;
    cwd: string;
    percent: number | null | undefined;
    messages: unknown[];
  }): boolean {
    if (typeof args.percent !== "number") return false;
    const set = this.crossedSet(args.sid);
    const crossed = newlyCrossed(args.percent, this.deps.thresholds, set);
    if (crossed.length === 0) return false;
    for (const t of crossed) set.add(t);
    metaSet(this.deps.db, `crossed:${args.sid}`, JSON.stringify([...set]));
    return this.fireCheckpoint(args);
  }

  /** Serializes the delta and schedules a writer run (queue depth 1, newest wins). */
  fireCheckpoint(args: { sid: string; pid: string; cwd: string; messages: unknown[] }): boolean {
    if (this.consecutiveFailures >= this.deps.maxWriterFailures) {
      this.deps.log(
        `checkpoint: giving up (${this.consecutiveFailures} consecutive writer failures); restart pi to retry`,
      );
      return false;
    }
    const { db, root } = this.deps;
    const lastSeq = Number(metaGet(db, `last_checkpoint_seq:${args.sid}`) ?? "0");
    const delta = args.messages.slice(lastSeq);
    if (delta.length === 0) return false;
    const n = Number(metaGet(db, `delta_n:${args.sid}`) ?? "0") + 1;
    metaSet(db, `delta_n:${args.sid}`, String(n));
    const deltaFile = deltaPath(args.sid, n, root);
    fs.mkdirSync(sessionDir(args.sid, root), { recursive: true });
    fs.writeFileSync(deltaFile, serializeDelta(delta), "utf8");
    ensureFile(checkpointPath(args.sid, root), CHECKPOINT_TEMPLATE);
    ensureFile(notesPath(args.sid, root), NOTES_TEMPLATE);
    ensureFile(projectMemoryPath(args.pid, root), MEMORY_TEMPLATE);
    const job: WriterJob = {
      sid: args.sid,
      pid: args.pid,
      cwd: args.cwd,
      deltaFile,
      messageCount: args.messages.length,
    };
    if (this.running) {
      // Newest wins: its delta range is a strict superset of the evicted one's.
      if (this.pending) {
        try {
          fs.rmSync(this.pending.deltaFile, { force: true });
        } catch {
          /* best effort */
        }
      }
      this.pending = job;
    } else {
      void this.run(job);
    }
    return true;
  }

  /** Resolves when the queue drains (used by session_before_compact, with a timeout). */
  waitForIdle(timeoutMs: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async run(job: WriterJob): Promise<void> {
    this.running = true;
    const { db, root } = this.deps;
    try {
      const prompt = checkpointWriterPrompt({
        checkpointPath: checkpointPath(job.sid, root),
        memoryPath: projectMemoryPath(job.pid, root),
        notesPath: notesPath(job.sid, root),
        deltaPath: job.deltaFile,
      });
      // /usr/bin/env wrapper sets the recursion guard; ExecOptions has no env field.
      const result = await this.deps.exec(
        "/usr/bin/env",
        ["PI_MIMO_CME_CHILD=1", ...this.deps.piCommand, "--no-extensions", "-p", prompt],
        { cwd: job.cwd },
      );
      if (result.code === 0) {
        metaSet(db, `last_checkpoint_seq:${job.sid}`, String(job.messageCount));
        try {
          fs.rmSync(job.deltaFile, { force: true });
        } catch {
          /* best effort */
        }
        this.consecutiveFailures = 0;
        this.deps.log(`checkpoint: writer ok (sid=${job.sid}, messages=${job.messageCount})`);
        this.deps.notify?.("💾 mimo-cme: checkpoint saved — session memory written");
      } else {
        this.consecutiveFailures += 1;
        this.deps.log(
          `checkpoint: writer failed code=${result.code} (failure ${this.consecutiveFailures}/${this.deps.maxWriterFailures})\n` +
            `stderr: ${result.stderr.slice(0, 2000)}`,
        );
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      this.deps.log(`checkpoint: writer exec error: ${String(err)}`);
    } finally {
      const next = this.pending;
      this.pending = null;
      if (next && this.consecutiveFailures < this.deps.maxWriterFailures) {
        void this.run(next);
      } else {
        this.running = false;
        for (const w of this.waiters.splice(0)) w();
      }
    }
  }

  /** Memory-flush nudge text for 70% / 85% levels — once per level per session. */
  nudgeFor(sid: string, percent: number | null | undefined): string | undefined {
    if (typeof percent !== "number") return undefined;
    let sent = this.nudged.get(sid);
    if (!sent) {
      sent = new Set<number>();
      this.nudged.set(sid, sent);
    }
    for (const level of [85, 70]) {
      if (percent >= level && !sent.has(level)) {
        // Mark this level and everything below it — jumping straight past 85%
        // must not queue a redundant 70% nudge for the next turn.
        for (const l of [85, 70]) if (level >= l) sent.add(l);
        return (
          `<system-reminder>Context is filling up (${Math.round(percent)}% used). ` +
          `If you have important learnings or decisions from this session, consider writing them ` +
          `to memory now before context may be reset.</system-reminder>`
        );
      }
    }
    return undefined;
  }
}
