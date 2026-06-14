#!/usr/bin/env node
/**
 * bench-memory.mjs — Head-to-head A/B benchmark: pi WITH the pi-mimo-cme memory
 * extension vs. plain pi WITHOUT it. Answers the question "does this extension
 * actually improve an agent's memory across sessions, and at what cost?"
 *
 * It is NOT a unit test (those live in test/ and prove the machinery is correct).
 * This drives the *real* pi agent in headless mode and measures behaviour.
 *
 * Design (see docs/research or the generated report for full rationale):
 *   - One variable: `-e src/index.ts` (treatment) vs `--no-extensions` (baseline).
 *     Everything else held constant: same model, same cwd, same prompts,
 *     --no-context-files so AGENTS.md/CLAUDE.md can't leak project info.
 *   - Cross-session = a FRESH session B (new session id, NO --resume) asks a
 *     question that can only be answered from a PRIOR session A. The only
 *     information channel between them is the extension's memory. Plain pi has
 *     no such channel, by construction.
 *   - Isolated sandbox per item: a private PI_CODING_AGENT_DIR (memory root) and
 *     a private cwd (so the sha256(cwd) project id is unique). Independent and
 *     parallel-safe.
 *
 * Tracks:
 *   incontext  — fact + question in ONE session (both conditions). Sanity: the
 *                model CAN answer when the fact is in context. Isolates the
 *                variable to cross-session persistence.
 *   recall     — cross-session fact recall. A persists a fact; fresh B is asked.
 *   rule       — cross-session rule ADHERENCE (behavioural, not Q&A). A saves a
 *                rule; fresh B gets a task that violates it unless remembered.
 *   precision  — load ALL facts into one project memory, then ask each question.
 *                Does the right fact surface, or does memory confuse neighbours?
 *
 * Usage:
 *   node scripts/bench-memory.mjs --trials 5 --parallel 4 --out /tmp/cme-results
 *   node scripts/bench-memory.mjs --pilot          # 1 trial, tiny, validates wiring
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXT = path.join(REPO, "src", "index.ts");

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PILOT = argv.includes("--pilot");
const TRIALS = PILOT ? 1 : parseInt(getArg("--trials", "5"), 10);
const PARALLEL = parseInt(getArg("--parallel", "4"), 10);
const OUT = getArg("--out", "/tmp/cme-results");
const MODEL = getArg("--model", ""); // empty = pi's configured default
const PER_CALL_TIMEOUT_MS = 120_000;

fs.mkdirSync(OUT, { recursive: true });
const SANDBOX = path.join(OUT, "sandbox");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });

// ---- benchmark items ------------------------------------------------------
// Each fact has a deterministically checkable answer token. Phrased so a model
// with NO prior knowledge cannot plausibly guess it (arbitrary names/values).
const FACTS = [
  { id: "deploy",   teach: "our deploy command is exactly `make ship-prod`",                 ask: "What is this project's exact deploy command?",                     expect: /make ship-prod/i },
  { id: "pkgmgr",   teach: "this project uses the `bun` package manager, never npm or yarn",  ask: "Which package manager does this project use?",                     expect: /\bbun\b/i },
  { id: "stagedb",  teach: "the staging database is named `pglake_staging_7`",                ask: "What is the name of the staging database?",                        expect: /pglake_staging_7/i },
  { id: "apiurl",   teach: "the internal API base URL is https://api.zentry.internal/v4",     ask: "What is the internal API base URL?",                               expect: /api\.zentry\.internal\/v4/i },
  { id: "oncall",   teach: "the primary on-call engineer is Priya Raghunathan",               ask: "Who is the primary on-call engineer for this project?",            expect: /priya raghunathan/i },
  { id: "port",     teach: "the gateway service listens on port 8473",                        ask: "What port does the gateway service listen on?",                    expect: /8473/ },
  { id: "flags",    teach: "feature flags are managed with a tool called `Plumeria`",         ask: "What tool manages feature flags in this project?",                 expect: /plumeria/i },
  { id: "testcmd",  teach: "the CI test command is exactly `mise run verify:all`",            ask: "What is the exact CI test command?",                               expect: /mise run verify:all/i },
  { id: "nodever",  teach: "this project is pinned to Node version 22.6.3",                   ask: "Which exact Node version is this project pinned to?",              expect: /22\.6\.3/ },
  { id: "secret",   teach: "the auth signing key lives in the env var `ZENTRY_HMAC_SEED`",    ask: "Which environment variable holds the auth signing key?",           expect: /ZENTRY_HMAC_SEED/i },
];

// Behavioural rules: B must APPLY the remembered rule on a fresh task.
const RULES = [
  { id: "modpath", teach: "all new modules must be created under `src/domains/`, never `src/lib/`",
    ask: "I want to create a new module called rate-limiter. Reply with ONLY the full file path where you would create it.",
    expect: /src\/domains\// , antiBaseline: /src\/(lib|utils)?/ },
  { id: "commit",  teach: "every git commit message MUST start with the prefix `[ZN]`",
    ask: "Write a one-line git commit message for fixing a typo in the README. Reply with ONLY the commit message.",
    expect: /^\W*\[ZN\]/i },
  { id: "delete",  teach: "destructive deletes are forbidden; always use the `safe-rm` wrapper instead of rm",
    ask: "What command should I run to delete the build/ folder here? Reply with ONLY the command.",
    expect: /safe-rm/i },
];

// ---- pi runner ------------------------------------------------------------
let detectedModel = ""; // sniffed from the first call's JSON; all calls share one model
function runPi({ treatment, prompt, cwd, agentDir, sessionId, noTools }) {
  const args = ["-p", "--mode", "json", "--no-context-files"];
  if (MODEL) args.push("--model", MODEL);
  // Question turns disable tools so neither arm can snoop sibling sandboxes'
  // MEMORY.md off the filesystem — the only legal channel is in-context memory
  // (injected for treatment, the conversation for the in-context control).
  // Treatment recall uses zero tools anyway (pure system-prompt injection).
  if (noTools) args.push("--no-tools");
  if (treatment) args.push("-e", EXT);
  else args.push("--no-extensions");
  if (sessionId) args.push("--session-id", sessionId);
  else args.push("--no-session");
  args.push(prompt);

  const env = { ...process.env };
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;

  const t0 = Date.now();
  return new Promise((resolve) => {
    // stdin = "ignore" (→ /dev/null): pi -p blocks reading an open stdin pipe
    // until EOF, so leaving it open hangs every call until the timeout.
    const child = spawn("pi", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, PER_CALL_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(killer);
      const ms = Date.now() - t0;
      const parsed = parseJsonl(stdout);
      if (parsed.model) detectedModel = parsed.model; // all calls share one model; capture once
      resolve({ ...parsed, ms, err: code === 0 ? null : `exit ${code}`, stderr: stderr.slice(0, 400) });
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ answer: "", model: "", input: 0, output: 0, cost: 0, tools: [], ms: Date.now() - t0, err: String(e).slice(0, 200), stderr: "" });
    });
  });
}

function parseJsonl(stdout) {
  let answer = "";
  let model = "";
  let input = 0, output = 0, cost = 0;
  const toolNames = [];
  const mm = stdout.match(/"model":"([^"]+)"/); // robust sniff across all event shapes
  if (mm) model = mm[1];
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
      // sum usage across assistant messages; final assistant text is the answer
      for (const m of obj.messages) {
        if (m.role !== "assistant") continue;
        if (m.usage) { input += m.usage.input || 0; output += m.usage.output || 0; cost += m.usage.cost?.total || 0; }
        if (!model && m.model) model = m.model;
        const text = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
        if (text) answer = text;
        for (const c of m.content || []) if (c.type === "tool_call" || c.type === "tool_use") toolNames.push(c.name || c.toolName || "?");
      }
    }
  }
  return { answer, model, input, output, cost, tools: toolNames };
}

// ---- scoring --------------------------------------------------------------
// strip markdown emphasis backticks/asterisks ONLY — NOT underscores, which
// appear inside legitimate answer tokens like pglake_staging_7 / ZENTRY_HMAC_SEED.
const norm = (s) => (s || "").replace(/[`*]/g, "").trim();
const saysIdk = (s) => /\b(i (don'?t|do not) know|no (information|knowledge|record|memory|context|idea)|not (sure|aware|specified|provided|available)|cannot (find|determine|recall)|unknown|unable to)/i.test(s || "");
const hit = (ans, re) => re.test(norm(ans));

// ---- track runners --------------------------------------------------------
let calls = 0;
const inc = () => { calls++; };

async function trackIncontext(item, trial, treatment) {
  const key = `ic-${treatment ? "t" : "b"}-${item.id}-${trial}`;
  const { cwd, agentDir } = mkSandbox(key);
  inc();
  const r = await runPi({
    treatment, cwd, agentDir, sessionId: treatment ? key : null, noTools: true,
    prompt: `For this project, ${item.teach}. Now answer this question using that fact: ${item.ask} Reply with ONLY the answer.`,
  });
  return { track: "incontext", item: item.id, trial, treatment, correct: hit(r.answer, item.expect), idk: saysIdk(r.answer), answer: r.answer, input: r.input, output: r.output, cost: r.cost, ms: r.ms, tools: r.tools, err: r.err };
}

async function trackRecall(item, trial, treatment) {
  const key = `rc-${treatment ? "t" : "b"}-${item.id}-${trial}`;
  const { cwd, agentDir } = mkSandbox(key);
  // Session A: persist (treatment writes MEMORY.md; baseline cannot — no channel).
  if (treatment) {
    inc();
    await runPi({
      treatment, cwd, agentDir, sessionId: `${key}-A`,
      prompt: `Project fact you must persist for future sessions: ${item.teach}. Record it in project memory (MEMORY.md) under ## Rules. Then reply DONE.`,
    });
  }
  // Session B: FRESH session, NO resume, tools OFF. Only the extension can bridge.
  inc();
  const r = await runPi({
    treatment, cwd, agentDir, sessionId: treatment ? `${key}-B` : null, noTools: true,
    prompt: `${item.ask} Answer with ONLY the answer, or say "I don't know" if you have no information about it. Do not guess.`,
  });
  return { track: "recall", item: item.id, trial, treatment, correct: hit(r.answer, item.expect), idk: saysIdk(r.answer), answer: r.answer, input: r.input, output: r.output, cost: r.cost, ms: r.ms, tools: r.tools, err: r.err };
}

async function trackRule(item, trial, treatment) {
  const key = `ru-${treatment ? "t" : "b"}-${item.id}-${trial}`;
  const { cwd, agentDir } = mkSandbox(key);
  if (treatment) {
    inc();
    await runPi({
      treatment, cwd, agentDir, sessionId: `${key}-A`,
      prompt: `Project rule you must persist for future sessions: ${item.teach}. Record it in project memory (MEMORY.md) under ## Rules. Then reply DONE.`,
    });
  }
  inc();
  const r = await runPi({
    treatment, cwd, agentDir, sessionId: treatment ? `${key}-B` : null, noTools: true,
    prompt: item.ask,
  });
  return { track: "rule", item: item.id, trial, treatment, correct: hit(r.answer, item.expect), idk: saysIdk(r.answer), answer: r.answer, input: r.input, output: r.output, cost: r.cost, ms: r.ms, tools: r.tools, err: r.err };
}

// Precision under load: ONE treatment project, ALL facts saved, then ask each.
async function trackPrecision(trial) {
  const key = `pr-t-${trial}`;
  const { cwd, agentDir } = mkSandbox(key);
  const all = FACTS.map((f, i) => `${i + 1}. ${f.teach}`).join("\n");
  inc();
  await runPi({
    treatment: true, cwd, agentDir, sessionId: `${key}-A`,
    prompt: `Persist ALL of these project facts for future sessions by recording each under ## Rules in project memory (MEMORY.md):\n${all}\nThen reply DONE.`,
  });
  const out = [];
  for (const f of FACTS) {
    inc();
    const r = await runPi({
      treatment: true, cwd, agentDir, sessionId: `${key}-B-${f.id}`, noTools: true,
      prompt: `${f.ask} Answer with ONLY the answer, or say "I don't know". Do not guess.`,
    });
    // wrong = answered confidently but matched a DIFFERENT fact's expected token
    const others = FACTS.filter((x) => x.id !== f.id).some((x) => hit(r.answer, x.expect));
    out.push({ track: "precision", item: f.id, trial, treatment: true, correct: hit(r.answer, f.expect), confusedWithOther: others && !hit(r.answer, f.expect), idk: saysIdk(r.answer), answer: r.answer, input: r.input, output: r.output, cost: r.cost, ms: r.ms, tools: r.tools, err: r.err });
  }
  return out;
}

function mkSandbox(key) {
  const base = path.join(SANDBOX, key);
  const cwd = path.join(base, "proj");
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

// ---- concurrency pool -----------------------------------------------------
async function pool(tasks, width) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(width, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await tasks[idx](); }
      catch (e) { results[idx] = { error: String(e) }; }
      process.stderr.write(".");
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- main -----------------------------------------------------------------
const facts = PILOT ? FACTS.slice(0, 2) : FACTS;
const rules = PILOT ? RULES.slice(0, 1) : RULES;

const jobs = [];
for (let t = 0; t < TRIALS; t++) {
  for (const f of facts) {
    jobs.push(() => trackIncontext(f, t, true));
    jobs.push(() => trackIncontext(f, t, false));
    jobs.push(() => trackRecall(f, t, true));
    jobs.push(() => trackRecall(f, t, false));
  }
  for (const r of rules) {
    jobs.push(() => trackRule(r, t, true));
    jobs.push(() => trackRule(r, t, false));
  }
  if (!PILOT) jobs.push(() => trackPrecision(t));
}

console.error(`[bench] ${jobs.length} jobs · trials=${TRIALS} · parallel=${PARALLEL} · pilot=${PILOT}`);
const t0 = Date.now();
const raw = (await pool(jobs, PARALLEL)).flat();
const wallMs = Date.now() - t0;
process.stderr.write("\n");

const flat = raw.filter((r) => r && !r.error);
fs.writeFileSync(path.join(OUT, "raw.json"), JSON.stringify(flat, null, 2));

// ---- aggregate ------------------------------------------------------------
const model = detectedModel || flat.find((r) => r.model)?.model || MODEL || "(unknown)";
function agg(track, treatment) {
  const rows = flat.filter((r) => r.track === track && r.treatment === treatment);
  if (!rows.length) return null;
  const n = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const idk = rows.filter((r) => r.idk && !r.correct).length;
  const wrong = rows.filter((r) => !r.correct && !r.idk).length;
  const confused = rows.filter((r) => r.confusedWithOther).length;
  const avgInput = Math.round(rows.reduce((a, r) => a + r.input, 0) / n);
  const avgOutput = Math.round(rows.reduce((a, r) => a + r.output, 0) / n);
  const avgMs = Math.round(rows.reduce((a, r) => a + r.ms, 0) / n);
  const cost = rows.reduce((a, r) => a + r.cost, 0);
  return { n, correct, idk, wrong, confused, acc: correct / n, avgInput, avgOutput, avgMs, cost };
}

const summary = { model, trials: TRIALS, pilot: PILOT, totalCalls: calls, wallMs, totalCost: flat.reduce((a, r) => a + r.cost, 0),
  tracks: {} };
for (const track of ["incontext", "recall", "rule", "precision"]) {
  summary.tracks[track] = { treatment: agg(track, true), baseline: agg(track, false) };
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

// ---- print ----------------------------------------------------------------
const pct = (x) => x == null ? "  —  " : `${(x * 100).toFixed(0)}%`.padStart(5);
console.log(`\n=== pi-mimo-cme memory benchmark ===`);
console.log(`model=${model}  trials=${TRIALS}  calls=${calls}  wall=${(wallMs/1000).toFixed(0)}s  cost=$${summary.totalCost.toFixed(4)}\n`);
console.log(`track       | cond      |   acc | correct | idk | wrong | conf | avgIn | avgOut | avgMs`);
console.log(`------------|-----------|-------|---------|-----|-------|------|-------|--------|------`);
for (const track of ["incontext", "recall", "rule", "precision"]) {
  for (const cond of ["treatment", "baseline"]) {
    const a = summary.tracks[track][cond];
    if (!a) continue;
    console.log(`${track.padEnd(11)} | ${cond.padEnd(9)} | ${pct(a.acc)} | ${String(a.correct).padStart(2)}/${String(a.n).padEnd(4)} | ${String(a.idk).padStart(3)} | ${String(a.wrong).padStart(5)} | ${String(a.confused).padStart(4)} | ${String(a.avgInput).padStart(5)} | ${String(a.avgOutput).padStart(6)} | ${String(a.avgMs).padStart(5)}`);
  }
}
console.log(`\nraw → ${path.join(OUT, "raw.json")}\nsummary → ${path.join(OUT, "summary.json")}`);
