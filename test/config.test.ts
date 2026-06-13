import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";

test("DEFAULT_CONFIG enables the tasks layer and budgets the actor + task views", () => {
  assert.equal(DEFAULT_CONFIG.tasks.enabled, true);
  assert.equal(typeof DEFAULT_CONFIG.checkpoint.pushCaps.actors, "number");
  assert.ok(DEFAULT_CONFIG.checkpoint.pushCaps.actors > 0);
  assert.equal(typeof DEFAULT_CONFIG.checkpoint.pushCaps.tasks, "number");
  assert.ok(DEFAULT_CONFIG.checkpoint.pushCaps.tasks > 0);
});

test("mergeConfig honors a custom tasks push cap; the merge loop auto-picks it up", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { checkpoint: { pushCaps: { tasks: 750 } } });
  assert.equal(merged.checkpoint.pushCaps.tasks, 750);
  assert.equal(merged.checkpoint.pushCaps.actors, DEFAULT_CONFIG.checkpoint.pushCaps.actors);
});

test("DEFAULT_CONFIG scales thresholds with the window by default", () => {
  assert.equal(DEFAULT_CONFIG.checkpoint.thresholds, "auto");
});

test("DEFAULT_CONFIG auto-runs both evolution passes (matches MiMoCode)", () => {
  assert.equal(DEFAULT_CONFIG.dream.auto, true);
  assert.equal(DEFAULT_CONFIG.distill.auto, true);
  // Opt back out without touching the interval.
  const merged = mergeConfig(DEFAULT_CONFIG, { distill: { auto: false } });
  assert.equal(merged.distill.auto, false);
  assert.equal(merged.distill.intervalDays, 30);
});

test("mergeConfig: an explicit threshold array pins a flat schedule", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { checkpoint: { thresholds: [20, 40, 60, 80] } });
  assert.deepEqual(merged.checkpoint.thresholds, [20, 40, 60, 80]);
});

test("mergeConfig: \"auto\" string is honored; junk strings fall back to default", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { checkpoint: { thresholds: "auto" } }).checkpoint.thresholds, "auto");
  // A non-array, non-"auto" value is ignored → default ("auto") survives.
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { checkpoint: { thresholds: "every-5" } as unknown as Record<string, unknown> })
      .checkpoint.thresholds,
    "auto",
  );
});

test("mergeConfig honors tasks.enabled = false and a custom actors cap", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    tasks: { enabled: false },
    checkpoint: { pushCaps: { actors: 500 } },
  });
  assert.equal(merged.tasks.enabled, false);
  assert.equal(merged.checkpoint.pushCaps.actors, 500);
  // Untouched caps keep their defaults.
  assert.equal(merged.checkpoint.pushCaps.checkpoint, DEFAULT_CONFIG.checkpoint.pushCaps.checkpoint);
});

test("mergeConfig ignores a non-boolean tasks.enabled", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { tasks: { enabled: "yes" } as unknown as Record<string, unknown> });
  assert.equal(merged.tasks.enabled, true);
});
