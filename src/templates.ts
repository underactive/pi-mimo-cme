/**
 * File templates (from MiMoCode's checkpoint-templates.ts) and section token
 * budgets. checkpoint.md keeps all 11 sections; §4 tracks subagent/actor
 * activity (Phase 2) rather than MiMoCode's user task graph, which pi has no
 * registry for.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const CHECKPOINT_TEMPLATE = `# Session checkpoint

## §1 Active intent
_Verbatim user request, block-quoted. This is ground truth — do not paraphrase._
(none yet)

## §2 Next concrete action
_Concrete next step, with verbatim quote when possible._
(none yet)

## §3 Directives (this session)
_Session-specific working style only. Project-wide rules belong in MEMORY.md ## Rules._
(none yet)

## §4 Subagents
_Subagent/actor activity this session (id · type · status — one-line result), reconciled from the actor ledger. Never invent actor IDs. Render "(no subagents this session)" when none ran._
(none yet)

## §5 Current work
_What was being done before this checkpoint._
(none yet)

## §6 Files and code sections
_Files actively read/edited, each with a one-line purpose._
(none yet)

## §7 Discovered knowledge (cross-task)
_Cross-task facts; candidates for MEMORY.md promotion._
(none yet)

## §8 Errors and fixes
_Issues encountered and how they were resolved._
(none yet)

## §9 Live resources
_Runtime state: branch, running processes, servers, etc._
(none yet)

## §10 Design decisions and discussion outcomes
_Decisions reached through discussion that produced no immediate code/file artifact; promote to MEMORY.md ## Architecture decisions when proven cross-session-durable._
(none yet)

## §11 Open notes
_Writer-curated catch-all for orphan content (quotes, unresolved questions, micro-observations); prefer empty when in doubt — most checkpoints have nothing here._
(none yet)
`;

export const MEMORY_TEMPLATE = `# Project memory

## Project context
(none yet)

## Rules
(none yet)

## Architecture decisions
(none yet)

## Discovered durable knowledge
(none yet)
`;

export const NOTES_TEMPLATE = `# Session notes

_Free-form scratchpad for the main agent. Append entries as you go; the checkpoint writer reconciles them at checkpoint events. Format each entry as \`## [turn N · YYYY-MM-DDTHH:MM:SSZ]\` followed by a free-form body. Keep entries short; if you've already noted substantially similar content, add a short \`(see entry above)\` reference instead of duplicating._
`;

/** MiMoCode's CHECKPOINT_SECTION_BUDGETS (tokens, ~11K total). */
export const CHECKPOINT_SECTION_BUDGETS: Record<string, number> = {
  "§1 Active intent": 500,
  "§2 Next concrete action": 1000,
  "§3 Directives (this session)": 800,
  "§4 Subagents": 1000,
  "§5 Current work": 2000,
  "§6 Files and code sections": 1500,
  "§7 Discovered knowledge (cross-task)": 2000,
  "§8 Errors and fixes": 1500,
  "§9 Live resources": 1000,
  "§10 Design decisions and discussion outcomes": 3000,
  "§11 Open notes": 800,
};

/** MiMoCode's MEMORY_SECTION_BUDGETS (tokens, ~10K total). */
export const MEMORY_SECTION_BUDGETS: Record<string, number> = {
  "Project context": 1000,
  Rules: 2000,
  "Architecture decisions": 3000,
  "Discovered durable knowledge": 4000,
};

/** Renders the {{SECTION_BUDGETS}} substitution for the writer prompt. */
export function renderSectionBudgets(): string {
  const cp = Object.entries(CHECKPOINT_SECTION_BUDGETS)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const mem = Object.entries(MEMORY_SECTION_BUDGETS)
    .map(([k, v]) => `## ${k}: ${v}`)
    .join(", ");
  return (
    `Per-section token budgets (~4 chars/token). checkpoint.md: ${cp}. ` +
    `MEMORY.md: ${mem}.`
  );
}

/** Creates the file from a template iff it does not already exist. */
export function ensureFile(filePath: string, template: string): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, template, "utf8");
}
