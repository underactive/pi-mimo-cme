/**
 * Memory write path: context-usage thresholds, conversation-delta
 * serialization, the in-process checkpoint-writer session (queue depth 1,
 * newest wins), and memory-flush nudges.
 */
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { metaGet, metaSet, recordWriterMetrics } from "./db.ts";
import { checkpointPath, notesPath, projectMemoryPath, sessionDir } from "./paths.ts";
import { checkpointWriterPrompt } from "./prompts/checkpoint-writer.ts";
import { CHECKPOINT_TEMPLATE, MEMORY_TEMPLATE, NOTES_TEMPLATE, ensureFile } from "./templates.ts";

const TOOL_INPUT_CAP = 500;
const TOOL_RESULT_CAP = 500;
/**
 * Upper bound on the conversation delta handed to the writer. Formerly a
 * filesystem cap on `delta-<n>.md`; now the writer runs in-process and the
 * delta is inlined into its prompt, so this is a token-budget guard on that
 * string — we choose the budget. The head is dropped; the newest content is
 * what the writer needs most.
 */
export const DELTA_CAP = 100_000;

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
  if (out.length > DELTA_CAP) {
    const dropped = out.length - DELTA_CAP;
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

/**
 * MiMoCode's window-size → checkpoint-density schedule (their
 * `src/session/prune.ts: defaultThresholdsFor`, design spec
 * `2026-06-03-checkpoint-threshold-density-design.md`). Larger context windows
 * fire denser so a fixed 20/40/60/80 doesn't leave huge unsaved spans on
 * big-context models. The schedule is "every S%, from S to 100-S": S=20
 * reproduces [20,40,60,80] (≤200K, identical to the old flat default); S=10
 * fires every 10% (200K–500K); S=5 every 5% (>500K). An unknown window (no
 * contextUsage at fire time) falls back to S=20 — exactly the prior behavior.
 */
export function defaultThresholdsFor(window: number | null | undefined): number[] {
  const step = !window || window <= 200_000 ? 20 : window <= 500_000 ? 10 : 5;
  const out: number[] = [];
  for (let t = step; t <= 100 - step; t += step) out.push(t);
  return out;
}

/**
 * The writer session's own token usage for one run (from its getSessionStats),
 * plus wall-clock. The Phase 3 "measure first" signal: `input` is the writer's
 * full-price cold-start cost, weighed against the parent context size (recorded
 * separately, at fire time) that a `fork=true` writer would carry instead.
 * `cacheRead` is ~0 today (no prefix reuse) and would be the fork's success
 * signal if it were ever built.
 */
export interface WriterTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
  durationMs: number;
}

/** Outcome of one writer run, as reported by the injected runner. */
export interface WriterResult {
  ok: boolean;
  /** Short diagnostic, logged on failure. */
  error?: string;
  /** Token usage + duration for profiling; absent when the runner can't report it. */
  metrics?: WriterTokenUsage;
}

export interface WriterRequest {
  /** The full checkpoint-writer prompt, conversation delta already inlined. */
  prompt: string;
  /** Project cwd the writer's file tools resolve relative paths against. */
  cwd: string;
}

/**
 * Runs one checkpoint-writer pass and resolves to its outcome. The
 * implementation (an in-process pi SDK session) lives in index.ts so this
 * module stays pure and testable; a mock runner drives the unit tests. An
 * ordinary writer failure resolves to `{ok:false}` rather than throwing — a
 * thrown error is treated as a failure too, but the runner owns the
 * distinction.
 */
export type WriterFn = (req: WriterRequest) => Promise<WriterResult>;

export interface CheckpointDeps {
  db: DatabaseSync;
  root: string;
  /**
   * Flat list of context-% crossings, or `"auto"` to scale the schedule with
   * the parent context window per fire (see `defaultThresholdsFor`). When
   * `"auto"`, the window comes from `maybeCheckpoint`'s `parentContext`.
   */
  thresholds: readonly number[] | "auto";
  maxWriterFailures: number;
  runWriter: WriterFn;
  /**
   * Builds the inlined SUBAGENT PROGRESS block (checkpoint §4 source) for a
   * session, from the actor ledger. Optional and injected like runWriter so this
   * module stays pure: when absent (tasks layer off / no ledger), the writer
   * sees an empty block and §4 renders "(no subagents this session)".
   */
  buildSubagentProgress?: (sid: string) => string;
  log: (message: string) => void;
  /**
   * Optional UI toast. The writer runs in a headless in-process session with
   * no UI of its own, so the "checkpoint saved" moment can only surface here,
   * in the parent, when run() observes the writer's outcome. No-op without a UI.
   */
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/**
 * Parent context size at checkpoint-fire time (from ctx.getContextUsage()).
 * Captured here, not when the (possibly-queued) writer eventually runs, so the
 * recorded number reflects the context that actually triggered this checkpoint —
 * i.e. exactly what a `fork=true` writer would have had to carry.
 */
export interface ParentContext {
  tokens: number | null;
  contextWindow: number;
}

interface WriterJob {
  sid: string;
  pid: string;
  cwd: string;
  /** Serialized conversation delta, inlined into the writer prompt. */
  delta: string;
  /** Branch message count at serialization time — becomes last_checkpoint_seq. */
  messageCount: number;
  /** Parent context size when this checkpoint fired (for Phase 3 profiling). */
  parentTokens: number | null;
  parentContextWindow: number;
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
    /** Parent context size at this turn, recorded for Phase 3 profiling. */
    parentContext?: ParentContext;
  }): boolean {
    if (typeof args.percent !== "number") return false;
    const set = this.crossedSet(args.sid);
    // "auto" resolves against the live window each fire; a window change (model
    // switch) just yields a different schedule — the crossed set is keyed by
    // threshold value, so already-saved ticks stay saved and new ones still fire.
    const thresholds =
      this.deps.thresholds === "auto"
        ? defaultThresholdsFor(args.parentContext?.contextWindow)
        : this.deps.thresholds;
    const crossed = newlyCrossed(args.percent, thresholds, set);
    if (crossed.length === 0) return false;
    for (const t of crossed) set.add(t);
    metaSet(this.deps.db, `crossed:${args.sid}`, JSON.stringify([...set]));
    return this.fireCheckpoint(args);
  }

  /** Serializes the delta and schedules a writer run (queue depth 1, newest wins). */
  fireCheckpoint(args: {
    sid: string;
    pid: string;
    cwd: string;
    messages: unknown[];
    parentContext?: ParentContext;
  }): boolean {
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
    // The writer runs in-process and reads/edits these in place, so they must
    // exist before it starts; the delta itself is inlined into the prompt (no
    // temp file) — see WriterJob.delta.
    fs.mkdirSync(sessionDir(args.sid, root), { recursive: true });
    ensureFile(checkpointPath(args.sid, root), CHECKPOINT_TEMPLATE);
    ensureFile(notesPath(args.sid, root), NOTES_TEMPLATE);
    ensureFile(projectMemoryPath(args.pid, root), MEMORY_TEMPLATE);
    const job: WriterJob = {
      sid: args.sid,
      pid: args.pid,
      cwd: args.cwd,
      delta: serializeDelta(delta),
      messageCount: args.messages.length,
      parentTokens: args.parentContext?.tokens ?? null,
      parentContextWindow: args.parentContext?.contextWindow ?? 0,
    };
    if (this.running) {
      // Newest wins: its delta range is a strict superset of the evicted one's.
      // The evicted job held only an in-memory string, so dropping it needs no
      // cleanup (the old delta-<n>.md eviction is gone).
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
        delta: job.delta,
        subagentProgress: this.deps.buildSubagentProgress?.(job.sid) ?? "",
      });
      const result = await this.deps.runWriter({ prompt, cwd: job.cwd });
      this.recordMetrics(job, result.ok, result.metrics);
      if (result.ok) {
        metaSet(db, `last_checkpoint_seq:${job.sid}`, String(job.messageCount));
        this.consecutiveFailures = 0;
        this.deps.log(`checkpoint: writer ok (sid=${job.sid}, messages=${job.messageCount})`);
        this.deps.notify?.("💾 mimo-cme: checkpoint saved — session memory written");
      } else {
        this.consecutiveFailures += 1;
        this.deps.log(
          `checkpoint: writer failed (failure ${this.consecutiveFailures}/${this.deps.maxWriterFailures})` +
            (result.error ? `\n${result.error.slice(0, 2000)}` : ""),
        );
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      this.recordMetrics(job, false, undefined); // a run happened and failed — log it with the parent size, no usage
      this.deps.log(`checkpoint: writer error: ${String(err)}`);
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

  /**
   * Persist + log one writer run's instrumentation (SUBAGENT-INTEGRATION-PLAN
   * §6 "measure first"). Instrumentation must never disrupt the writer flow, so
   * every failure here is swallowed to the log. The structured log line mirrors
   * the row so the data is greppable even if the table is later dropped.
   */
  private recordMetrics(job: WriterJob, ok: boolean, usage: WriterTokenUsage | undefined): void {
    const deltaChars = job.delta.length;
    const deltaTokensEst = Math.ceil(deltaChars / 4);
    try {
      recordWriterMetrics(this.deps.db, {
        sessionId: job.sid,
        projectId: job.pid,
        ts: Date.now(),
        ok,
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        total: usage?.total ?? 0,
        costUsd: usage?.costUsd ?? 0,
        deltaChars,
        deltaTokensEst,
        parentTokens: job.parentTokens,
        parentContextWindow: job.parentContextWindow,
        messageCount: job.messageCount,
        durationMs: usage?.durationMs ?? 0,
      });
    } catch (err) {
      this.deps.log(`checkpoint: failed to record writer metrics: ${String(err)}`);
    }
    this.deps.log(
      `checkpoint metrics: sid=${job.sid} ok=${ok} ` +
        `writer_input=${usage?.input ?? 0} writer_output=${usage?.output ?? 0} ` +
        `cache_read=${usage?.cacheRead ?? 0} cache_write=${usage?.cacheWrite ?? 0} ` +
        `cost=$${(usage?.costUsd ?? 0).toFixed(4)} delta_tok≈${deltaTokensEst} ` +
        `parent_tokens=${job.parentTokens ?? "?"} dur_ms=${usage?.durationMs ?? 0}`,
    );
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
