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
}

export interface CmeConfig {
  checkpoint: {
    thresholds: number[];
    scoreFloor: number;
    reconcileOnSearch: boolean;
    maxWriterFailures: number;
    pushCaps: PushCaps;
  };
  history: { kinds: string[] };
  memory: { ccIndex: boolean };
  dream: { auto: boolean; intervalDays: number };
  distill: { auto: boolean; intervalDays: number };
}

export const DEFAULT_CONFIG: CmeConfig = {
  checkpoint: {
    thresholds: [20, 40, 60, 80],
    scoreFloor: 0.15,
    reconcileOnSearch: true,
    maxWriterFailures: 3,
    pushCaps: { checkpoint: 11_000, memory: 10_000, global: 6_000, notes: 6_000, memoryKeys: 500 },
  },
  history: { kinds: ["user_text", "assistant_text", "tool_input", "tool_error"] },
  memory: { ccIndex: false },
  dream: { auto: true, intervalDays: 7 },
  distill: { auto: false, intervalDays: 30 },
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
    if (typeof c["scoreFloor"] === "number") out.checkpoint.scoreFloor = c["scoreFloor"];
    if (typeof c["reconcileOnSearch"] === "boolean") out.checkpoint.reconcileOnSearch = c["reconcileOnSearch"];
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
  for (const pass of ["dream", "distill"] as const) {
    const p = o[pass];
    if (p && typeof p === "object") {
      if (typeof p["auto"] === "boolean") out[pass].auto = p["auto"];
      if (typeof p["intervalDays"] === "number") out[pass].intervalDays = p["intervalDays"];
    }
  }
  return out;
}
