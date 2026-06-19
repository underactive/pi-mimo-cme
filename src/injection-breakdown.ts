/**
 * Lightweight module-level state tracking per-section token counts for the
 * last system-prompt appendix and last rebuild dump. Read by the heartbeat
 * and resume toasts in index.ts; never written to disk or SQL.
 *
 * Two independent tracks:
 * - `appendix`: updated every turn by buildSystemPromptAppendix (inject.ts).
 *   Tracks the 4 sections that compose the system-prompt appendix.
 * - `rebuild`: updated on resume/fork/compaction by buildRebuildDump (inject.ts).
 *   Tracks the sections that compose the one-shot rebuild dump.
 */

export interface AppendixBreakdown {
  /** Memory instructions section (~2-3K tokens). */
  instructions: number;
  /** Project MEMORY.md section (up to 10K tokens). */
  projectMem: number;
  /** Global MEMORY.md section (up to 6K tokens). */
  globalMem: number;
  /** Memory keys index section (up to 500 tokens). */
  keys: number;
  /** Whether this was a cache hit (unchanged from last turn). */
  cached: boolean;
}

export interface RebuildBreakdown {
  /** Checkpoint section (up to 11K tokens). */
  checkpoint: number;
  /** Notes section (up to 6K tokens). */
  notes: number;
  /** Number of keys in the keys index. */
  keyCount: number;
  /** Token estimate for the keys index. */
  keysTokens: number;
  /** Actual number of active actors in the rebuild dump (not binary). */
  actorCount: number;
}

let lastAppendix: AppendixBreakdown | undefined;
let lastRebuild: RebuildBreakdown | undefined;

import { fmtK } from "./formatting.ts";

/** Called by buildSystemPromptAppendix after each non-cached computation. */
export function setAppendixBreakdown(b: AppendixBreakdown): void {
  lastAppendix = b;
}

/** Called by buildRebuildDump after each computation. */
export function setRebuildBreakdown(b: RebuildBreakdown): void {
  lastRebuild = b;
}

/** Read the last appendix breakdown (undefined if never computed this session). */
export function getAppendixBreakdown(): AppendixBreakdown | undefined {
  return lastAppendix;
}

/** Compact footer label for the last injection snapshot: `· ~14K inject (5.0K)`. */
export function formatAppendixFooterLabel(): string | undefined {
  const ab = lastAppendix;
  if (!ab) return undefined;
  const total = ab.instructions + ab.projectMem + ab.globalMem + ab.keys;
  return `· ~${fmtK(total)} inject (${ab.cached ? fmtK(total) : "0"})`;
}

/** Read the last rebuild breakdown (undefined if no rebuild dump was generated). */
export function getRebuildBreakdown(): RebuildBreakdown | undefined {
  return lastRebuild;
}

/** Reset both breakdowns — called on session_shutdown for clean state. */
export function resetBreakdowns(): void {
  lastAppendix = undefined;
  lastRebuild = undefined;
}
