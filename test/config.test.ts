import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";

test("DEFAULT_CONFIG enables the tasks layer and budgets the actor views", () => {
  assert.equal(DEFAULT_CONFIG.tasks.enabled, true);
  assert.equal(typeof DEFAULT_CONFIG.checkpoint.pushCaps.actors, "number");
  assert.ok(DEFAULT_CONFIG.checkpoint.pushCaps.actors > 0);
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
