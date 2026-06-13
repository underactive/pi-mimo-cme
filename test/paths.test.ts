import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  agentDir,
  memoryRoot,
  projectId,
  sessionsJsonlDir,
  typeFromKey,
} from "../src/paths.ts";

test("projectId is a stable 12-char hex hash of the absolute cwd", () => {
  const a = projectId("/Users/me/proj");
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, projectId("/Users/me/proj"));
  assert.notEqual(a, projectId("/Users/me/other"));
  // Relative input is resolved before hashing.
  const cwdHash = projectId(process.cwd());
  assert.equal(projectId("."), cwdHash);
});

test("agentDir / memoryRoot respect PI_CODING_AGENT_DIR", () => {
  const prev = process.env["PI_CODING_AGENT_DIR"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cme-agent-"));
  try {
    process.env["PI_CODING_AGENT_DIR"] = dir;
    assert.equal(agentDir(), dir);
    assert.equal(memoryRoot(), path.join(dir, "pi-mimo-cme"));
  } finally {
    if (prev === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agentDir defaults to ~/.pi/agent without the override", () => {
  const prev = process.env["PI_CODING_AGENT_DIR"];
  try {
    delete process.env["PI_CODING_AGENT_DIR"];
    assert.equal(agentDir(), path.join(os.homedir(), ".pi", "agent"));
  } finally {
    if (prev !== undefined) process.env["PI_CODING_AGENT_DIR"] = prev;
  }
});

test("sessionsJsonlDir escapes cwd like pi's session-manager", () => {
  const dir = sessionsJsonlDir("/Users/me/Dev/proj", "/agent");
  assert.equal(dir, path.join("/agent", "sessions", "--Users-me-Dev-proj--"));
});

test("typeFromKey regex detection", () => {
  assert.equal(typeFromKey("/x/MEMORY.md"), "memory");
  assert.equal(typeFromKey("memory-extra.md"), "memory");
  assert.equal(typeFromKey("/x/checkpoint.md"), "checkpoint");
  assert.equal(typeFromKey("checkpoint-sqlite.md"), "checkpoint");
  assert.equal(typeFromKey("/x/notes.md"), "notes");
  assert.equal(typeFromKey("/x/random.md"), "free");
});
