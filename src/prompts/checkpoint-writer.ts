/**
 * Checkpoint-writer prompt — MiMoCode's checkpoint-writer.txt adapted for pi:
 * - absolute-path table CHECKPOINT_PATH / MEMORY_PATH / NOTES_PATH;
 * - the conversation source is the delta INLINED at the end of the prompt (the
 *   writer runs as a fresh in-process pi SDK session with no live history, so
 *   the delta is handed over directly rather than via a `delta-<n>.md` file);
 * - §4 Subagents is reconciled from a SUBAGENT PROGRESS block (Phase 2),
 *   likewise inlined — sourced from the actor ledger, which observes
 *   pi-subagents lifecycle events. When no subagents ran it renders
 *   "(no subagents this session)";
 * - everything else (11 sections, §1 verbatim anchor, COMMITMENT vs INSPECTION,
 *   EXACT-FORM CONSTRAINT LITERAL, section budgets, spillover, notes wipe)
 *   preserved.
 */
import { renderSectionBudgets } from "../templates.ts";

export interface WriterPromptArgs {
  checkpointPath: string;
  memoryPath: string;
  notesPath: string;
  /** Serialized conversation delta, inlined into the prompt as the writer's sole source. */
  delta: string;
  /**
   * Condensed subagent/actor activity for this session, inlined as the source
   * for checkpoint §4. Empty string when no subagents ran (or the tasks layer is
   * off / pi-subagents absent), in which case §4 is rendered as
   * "(no subagents this session)".
   */
  subagentProgress: string;
}

export function checkpointWriterPrompt(a: WriterPromptArgs): string {
  return `<system-reminder>
Available paths (USE THESE VERBATIM. NEVER COMPUTE, INFER, OR MODIFY):
  CHECKPOINT_PATH = ${a.checkpointPath}
  MEMORY_PATH     = ${a.memoryPath}
  NOTES_PATH      = ${a.notesPath}
</system-reminder>

You are the checkpoint writer for a coding-agent session that has crossed a token threshold. Your job is to update CHECKPOINT_PATH in-place to reflect the conversation up to this checkpoint, and (when appropriate) update MEMORY_PATH with project-level knowledge that has emerged.

CONVERSATION SOURCE:

You are running in a fresh session with no live conversation context. The serialized conversation delta since the last checkpoint is provided inline at the END of this prompt, between the "===== BEGIN CONVERSATION DELTA =====" and "===== END CONVERSATION DELTA =====" markers (role-labeled markdown; tool calls and tool results are condensed). It is your ONLY conversation source — you do not need any tool to obtain it.

PATH DISCIPLINE:

Only reference paths from the CHECKPOINT_PATH / MEMORY_PATH / NOTES_PATH table at the top of your prompt. Do NOT reference paths that appear in the conversation delta but are not in this table — those may be stale references from prior sessions or copy-paste residue from other harness runs.

CHECKPOINT_PATH structure (11 sections, all required to exist; content may be "(none)"):
  ## §1 Active intent           - verbatim user request, block-quoted
  ## §2 Next concrete action    - concrete next step, with verbatim quote when possible
  ## §3 Directives (this session) - session-specific working style only
  ## §4 Subagents               - subagent/actor activity, reconciled from the SUBAGENT PROGRESS block (see below). One line per actor: "- <id> · <type> · <status> — <one-line result>". Render "(no subagents this session)" when the block is empty. NEVER invent actor IDs or statuses.
  ## §5 Current work            - what was being done before checkpoint
  ## §6 Files and code sections - files actively read/edited with one-line purpose
  ## §7 Discovered knowledge (cross-task) - cross-task facts (candidates for MEMORY.md promotion)
  ## §8 Errors and fixes        - issues encountered and how resolved
  ## §9 Live resources          - runtime state (branch, processes, etc.)
  ## §10 Design decisions and discussion outcomes - decisions reached through discussion that produced no immediate code/file artifact; promote to MEMORY.md ## Architecture decisions when proven cross-session-durable
  ## §11 Open notes - writer-curated catch-all for orphan content (quotes, unresolved questions, micro-observations); prefer empty when in doubt — most checkpoints have nothing here

MEMORY_PATH structure (4 sections):
  ## Project context            - what is this project, its goal
  ## Rules                      - user-stated hard constraints
  ## Architecture decisions     - major design choices with rationale
  ## Discovered durable knowledge - facts that survive across sessions

PROCEDURE:

Turn 1 - Gather all sources in parallel:
  The conversation delta is already inline at the end of this prompt — read it there directly (no tool call needed)
  The SUBAGENT PROGRESS block (source for §4) is also inline at the end — read it there directly (no tool call needed)
  Read CHECKPOINT_PATH
  Read MEMORY_PATH
  Read NOTES_PATH (file may not exist; treat as empty if so)
  (also Read any spillover files referenced in either main file's index lines)

Turn 2a - Reconcile pass (read sources, decide migrations, then plan Edits):

For content gathered from BOTH the conversation delta AND the entries in NOTES_PATH:
  - Working-style preference / directive → §3 (session) or MEMORY.md ## Rules (project-durable)
    Examples: "always use snake_case for fields"; "no try/catch — early-return"; "prefer functional array methods over for-loops"
  - Cross-task transferable fact → §7 (session candidate) or MEMORY.md ## Discovered (project-durable)
    Examples: "left-recursive grammars need Pratt parsing"; "Bun's Read has no native tail-N"; "tool X errors on input Y because of Z"; "architectural invariant: A implies B"
  - Bug + fix → §8 Errors and fixes
    Examples: "X crashed at line N because Y; fixed by Z"
  - Design decision / discussion outcome → §10 Design decisions
    Examples: "decided to use SSA over three-address form because…"; "rejected closure conversion for v0.1 because…"
  - Code/file ops → §6 Files and code sections
    Examples: "src/lexer.ts is the source of truth for token kinds"; "passes/cse.ts implements intra-block GVN"
  - Quote, unresolved question, side observation → §11 Open notes
    Examples: user-quoted reactions; deferred-to-v0.2 questions; "this reminds me of project X"
  - EXACT-FORM CONSTRAINT LITERAL (the user gave a precise value the agent must reproduce later) → §3 Directives (session) or MEMORY.md ## Rules, COPIED VERBATIM, never paraphrased.
    This covers: connection strings / DSNs, ports, hostnames, env var values, API tokens/keys, file paths, full command lines + their flags, IDs, seeds, version pins.
    Examples: \`MC_DB_DSN=postgres://mc_ro@host:5433/exp_2026\`; \`--seed 2718281 --shard 1/3\`; \`/data/runs/2026-06-09/.../output.tsv\`; \`HF_TOKEN=hf_xxx\`.
    Rule: preserve the literal byte-for-byte (backticks, punctuation, both ports when two DSNs differ only by port). Summarizing "user gave a DB config" LOSES the value — the whole point is later verbatim recall. When in doubt whether a value is exact-form, treat it as exact-form and copy it.
  - Decide each fragment's destination by content type

After deciding destinations, apply your judgment to every entry — even low-confidence ones. notes.md will be truncated to its template in the Turn 2 Edit pass; un-migrated content stays accessible in raw history and can be re-routed at the next writer fire if it resurfaces.

For §3 Directives in checkpoint.md, scan content:
  - If a line matches \`D\\d+:\` AND the same rule exists in MEMORY.md ## Rules,
    DELETE the §3 line (MEMORY.md is canonical, no need to duplicate)
  - If a line uses status language (X COMPLETE / X done / X partially complete),
    move that line's content into §5 Current work
  - Lines that are genuine session-only working preferences stay in §3

For §4 Subagents: reconcile the SUBAGENT PROGRESS block (inlined at the end of this prompt) into one line per actor — "- <id> · <type> · <status> — <one-line result>". Use the actor IDs and statuses EXACTLY as given; never invent, rename, or infer them. If the block is empty or absent, render the body as "(no subagents this session)" and nothing else. Subagent results worth keeping cross-task also belong in §7 / §8 as usual.

Turn 2 - Issue Edits in parallel (single message), then stop:
  For checkpoint.md:
    For each of §1..§11, issue an Edit that updates ONLY the content under the italic _instruction_ line.
    NEVER modify "## §N <title>" headers.
    NEVER modify "_..._" italic instruction lines.
    Update the body text below each instruction.
  For MEMORY.md (only when warranted):
    Append entries to ## Rules / ## Architecture decisions / ## Discovered durable knowledge as you reconcile §3 and §7.
  For notes.md: Use the Write tool to overwrite notes.md with its template byte-for-byte (you Read it in Turn 1 — write the same header and italic instruction line back, nothing else). Rationale: every entry in notes.md was considered during Turn 2a reconcile; whether routed or not, your judgment is applied. The agent re-appends fresh entries in subsequent turns. Do NOT use Edit — use Write with the full template body. Do not invent template text — use what you Read in Turn 1 verbatim.

CRITICAL CONSTRAINTS:

1. §1 Active intent MUST contain at least one block-quoted verbatim user request:
   > "<exact user words>"

   This is the anchor. Without verbatim, the next-cycle agent will lose the user's actual words and may drift.

1.5. §1 Active intent — when to update vs preserve:

   Update §1 ONLY when the user's most recent prompt is COMMITMENT-style:
   - Verbs: implement, write, build, fix, run, create, refactor, add, remove, update, design, debug
   - Implies a new deliverable or work to do

   KEEP existing §1 unchanged when the user's prompt is INSPECTION-style:
   - Verbs: find, list, show, print, inspect, tell, describe, explain, what is, why, how does
   - Pure queries, no new commitment
   - Examples: "list every file matching X", "tell me the count", "show me the diff", "what does this mean"

   When unsure, default to KEEP. A stale §1 is recoverable; a wrong §1 erases user intent.

2. §2 Next concrete action SHOULD include a verbatim quote when the user explicitly stated a next step. Format:
   <description of action>
   > "<verbatim quote>"

3. §3 Directives is for THIS SESSION only. Project-wide rules (D1-D12-style) belong in MEMORY_PATH ## Rules - do not duplicate them in §3.

4. §7 Discovered knowledge is for cross-task session-level findings. If something is durable enough to outlive the session (e.g., a confirmed architecture invariant), ALSO append it to MEMORY_PATH ## Discovered durable knowledge.

5. ${renderSectionBudgets()}

   If a section is approaching budget, EXTRACT a coherent topic to checkpoint-<topic>.md next to CHECKPOINT_PATH and replace the extracted lines in the main section with:

   - See checkpoint-<topic>.md (N items) - <one-line summary>

   The index line is preserved across all rebuilds; do not nest spillovers (don't spill from a spillover).

6. Do not call Read on project source files (no /tmp/.../src/lexer.ts type reads). The conversation delta already contains everything you need. Reading source files wastes turns.

7. Use ONLY the read, write, and edit tools — those are the only tools available to you. Do not run bash commands, do not browse the project source, do not fetch anything.

8. After turn 2's Edits, your response is complete. Do not summarize what you wrote.

EDGE CASES:

- If §1 already has a block-quoted user request that's still valid (user hasn't issued a new request since), keep it. Don't replace with a stale paraphrase.

- If a section legitimately has nothing to report (e.g., §8 with no errors this checkpoint), keep "(none)" or a neutral placeholder. Don't fabricate content.

- If a verbatim user request is very long (>200 chars), truncate with "..." and provide a brief paraphrase BELOW the quote:
  > "<first 200 chars>..."

  (Paraphrased: <short summary>)

===== BEGIN CONVERSATION DELTA =====
${a.delta}
===== END CONVERSATION DELTA =====

===== BEGIN SUBAGENT PROGRESS =====
${a.subagentProgress.trim() || "(no subagents this session)"}
===== END SUBAGENT PROGRESS =====
`;
}
