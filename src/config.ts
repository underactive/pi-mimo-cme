/**
 * Defaults + optional `<root>/config.json` overlay (SPEC §8).
 */
import * as fs from "node:fs";
import { configPath } from "./paths.ts";

export interface PushCaps {
  checkpoint: number;
  memory: number;
  global: number;
  notes: number;
  memoryKeys: number;
  /** Token cap for the actor ledger views (writer §4 block + rebuild "Active actors"). */
  actors: number;
}

export interface CmeConfig {
  checkpoint: {
    /**
     * Context-% crossings that fire the writer. `"auto"` (default) scales the
     * schedule with the model's context window — MiMoCode's behavior, see
     * `defaultThresholdsFor` in checkpoint.ts: every 20% ≤200K, 10% to 500K, 5%
     * beyond. An explicit array (e.g. `[20,40,60,80]`) pins a flat schedule and
     * ignores the window.
     */
    thresholds: number[] | "auto";
    scoreFloor: number;
    reconcileOnSearch: boolean;
    /**
     * Debounce window (ms) for search-triggered reconcile. A full tree walk is
     * synchronous and grows with session count, so when reconcileOnSearch fires
     * repeatedly within one session we skip the walk if one ran < this window
     * ago. The clock is per-session (in-memory), so the first search of every
     * session always reconciles — only rapid repeats collapse. 0 disables.
     */
    reconcileDebounceMs: number;
    maxWriterFailures: number;
    pushCaps: PushCaps;
  };
  history: { kinds: string[] };
  memory: { ccIndex: boolean };
  /**
   * Phase 2 subagent/actor layer. When enabled (default), the extension
   * observes pi-subagents lifecycle events, records an actor ledger, and writes
   * per-actor progress.md journals. A soft dependency: with pi-subagents absent
   * the ledger simply stays empty. Set false to opt out of the wiring entirely.
   */
  tasks: { enabled: boolean };
  dream: { auto: boolean; intervalDays: number };
  distill: { auto: boolean; intervalDays: number };
}

export const DEFAULT_CONFIG: CmeConfig = {
  checkpoint: {
    thresholds: "auto",
    scoreFloor: 0.15,
    reconcileOnSearch: true,
    reconcileDebounceMs: 4000,
    maxWriterFailures: 3,
    pushCaps: {
      checkpoint: 11_000,
      memory: 10_000,
      global: 6_000,
      notes: 6_000,
      memoryKeys: 500,
      actors: 2_000,
    },
  },
  history: { kinds: ["user_text", "assistant_text", "tool_input", "tool_error"] },
  memory: { ccIndex: false },
  tasks: { enabled: true },
  dream: { auto: true, intervalDays: 7 },
  distill: { auto: true, intervalDays: 30 },
};

export function loadConfig(root: string): CmeConfig {
  let overlay: Record<string, unknown> = {};
  try {
    overlay = JSON.parse(fs.readFileSync(configPath(root), "utf8"));
  } catch {
    // missing or malformed config.json → defaults
  }
  return mergeConfig(DEFAULT_CONFIG, overlay);
}

export function mergeConfig(base: CmeConfig, overlay: Record<string, unknown>): CmeConfig {
  const out: CmeConfig = structuredClone(base);
  const o = overlay as Partial<Record<keyof CmeConfig, Record<string, unknown>>>;
  if (o.checkpoint && typeof o.checkpoint === "object") {
    const c = o.checkpoint;
    if (Array.isArray(c["thresholds"])) out.checkpoint.thresholds = c["thresholds"].filter((t) => typeof t === "number");
    else if (c["thresholds"] === "auto") out.checkpoint.thresholds = "auto";
    if (typeof c["scoreFloor"] === "number") out.checkpoint.scoreFloor = c["scoreFloor"];
    if (typeof c["reconcileOnSearch"] === "boolean") out.checkpoint.reconcileOnSearch = c["reconcileOnSearch"];
    if (typeof c["reconcileDebounceMs"] === "number") out.checkpoint.reconcileDebounceMs = c["reconcileDebounceMs"];
    if (typeof c["maxWriterFailures"] === "number") out.checkpoint.maxWriterFailures = c["maxWriterFailures"];
    if (c["pushCaps"] && typeof c["pushCaps"] === "object") {
      for (const key of Object.keys(out.checkpoint.pushCaps) as (keyof PushCaps)[]) {
        const v = (c["pushCaps"] as Record<string, unknown>)[key];
        if (typeof v === "number") out.checkpoint.pushCaps[key] = v;
      }
    }
  }
  if (o.history && typeof o.history === "object" && Array.isArray(o.history["kinds"])) {
    out.history.kinds = o.history["kinds"].filter((k) => typeof k === "string");
  }
  if (o.memory && typeof o.memory === "object" && typeof o.memory["ccIndex"] === "boolean") {
    out.memory.ccIndex = o.memory["ccIndex"];
  }
  if (o.tasks && typeof o.tasks === "object" && typeof o.tasks["enabled"] === "boolean") {
    out.tasks.enabled = o.tasks["enabled"];
  }
  for (const pass of ["dream", "distill"] as const) {
    const p = o[pass];
    if (p && typeof p === "object") {
      if (typeof p["auto"] === "boolean") out[pass].auto = p["auto"];
      if (typeof p["intervalDays"] === "number") out[pass].intervalDays = p["intervalDays"];
    }
  }
  return out;
}
