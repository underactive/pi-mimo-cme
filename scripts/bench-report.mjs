#!/usr/bin/env node
/**
 * bench-report.mjs — Render a markdown results fragment from a bench-memory.mjs
 * run (summary.json + raw.json). Keeps the numbers in docs/MEMORY-BENCHMARK.md
 * straight from data instead of hand-transcribed.
 *
 *   node scripts/bench-report.mjs /tmp/cme-full
 */
import * as fs from "node:fs";
import * as path from "node:path";

const dir = process.argv[2] || "/tmp/cme-full";
const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
const raw = JSON.parse(fs.readFileSync(path.join(dir, "raw.json"), "utf8"));

const pctOrDash = (a) => (a == null ? "—" : `**${Math.round(a.acc * 100)}%**`);
const cell = (a, f) => (a == null ? "—" : f(a));

const TRACK_LABEL = {
  incontext: "`incontext` (sanity control)",
  recall: "`recall` (cross-session fact)",
  rule: "`rule` (cross-session behaviour)",
  precision: "`precision` (right fact, loaded)",
};

let out = "";
out += `_Model: \`${summary.model}\` · ${summary.trials} trials · ${summary.totalCalls} real pi sessions · `;
out += `${(summary.wallMs / 1000).toFixed(0)}s wall · total cost \$${summary.totalCost.toFixed(3)}._\n\n`;

out += `| Track | Condition | Accuracy | Correct | "I don't know" | Hallucinated | Wrong-fact | Avg input tok | Avg ms |\n`;
out += `|---|---|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const track of ["incontext", "recall", "rule", "precision"]) {
  for (const cond of ["treatment", "baseline"]) {
    const a = summary.tracks[track][cond];
    if (!a) continue;
    const label = cond === "treatment" ? "**with** ext" : "without";
    out += `| ${cond === "treatment" ? TRACK_LABEL[track] : ""} | ${label} | ${pctOrDash(a)} | ${cell(a, (x) => `${x.correct}/${x.n}`)} | ${cell(a, (x) => x.idk)} | ${cell(a, (x) => x.wrong)} | ${cell(a, (x) => x.confused)} | ${cell(a, (x) => x.avgInput)} | ${cell(a, (x) => x.avgMs)} |\n`;
  }
}

// token overhead from the in-context track (cleanest: same single-turn task both arms)
const icT = summary.tracks.incontext.treatment, icB = summary.tracks.incontext.baseline;
if (icT && icB) {
  out += `\n**Memory tax:** the extension adds ~${icT.avgInput - icB.avgInput} input tokens/turn on the in-context task `;
  out += `(${icT.avgInput} vs ${icB.avgInput}) — the injected memory instructions + project \`MEMORY.md\`.\n`;
}

// example transcripts: the rule track is the most legible
function ex(track, treatment) {
  const rows = raw.filter((r) => r.track === track && r.treatment === treatment && r.answer);
  return rows[0];
}
out += `\n### A representative pair — same task, opposite behaviour\n\n`;
const ruB = ex("rule", false), ruT = ex("rule", true);
const rcB = ex("recall", false), rcT = ex("recall", true);
if (ruB && ruT) {
  out += `**Rule track** (a fresh session asked to create a module; the project rule "new modules under \`src/domains/\`" was set in an earlier session):\n\n`;
  out += `- without ext → \`${(ruB.answer || "").replace(/`/g, "").slice(0, 90)}\`\n`;
  out += `- **with ext** → \`${(ruT.answer || "").replace(/`/g, "").slice(0, 90)}\`\n`;
}
if (rcB && rcT) {
  out += `\n**Recall track** (asked for a fact stated only in a prior session):\n\n`;
  out += `- without ext → "${(rcB.answer || "").slice(0, 90)}"\n`;
  out += `- **with ext** → "${(rcT.answer || "").slice(0, 90)}"\n`;
}

console.log(out);
