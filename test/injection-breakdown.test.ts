import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAppendixFooterLabel,
  getAppendixBreakdown,
  resetBreakdowns,
  setAppendixBreakdown,
} from "../src/injection-breakdown.ts";

test("getAppendixBreakdown is undefined before the first set", () => {
  resetBreakdowns();
  assert.equal(getAppendixBreakdown(), undefined);
  assert.equal(formatAppendixFooterLabel(), undefined);
});

test("formatAppendixFooterLabel reflects cached and non-cached states", () => {
  resetBreakdowns();
  setAppendixBreakdown({
    instructions: 4000,
    projectMem: 8000,
    globalMem: 2000,
    keys: 500,
    cached: true,
  });
  const cached = formatAppendixFooterLabel();
  assert.ok(cached, "cached label should exist");
  assert.match(cached, /14\.5K inject/);
  assert.match(cached, /\(14\.5K\)/);

  setAppendixBreakdown({
    instructions: 4000,
    projectMem: 8000,
    globalMem: 2000,
    keys: 500,
    cached: false,
  });
  const refreshed = formatAppendixFooterLabel();
  assert.ok(refreshed, "refreshed label should exist");
  assert.match(refreshed, /14\.5K inject/);
  assert.match(refreshed, /\(0\)/);

  resetBreakdowns();
  assert.equal(formatAppendixFooterLabel(), undefined);
});
