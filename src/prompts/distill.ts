/**
 * Distill prompt — MiMoCode's distill.txt structure retargeted at pi assets:
 * pi skills (~/.pi/agent/skills, project .pi/skills), slash-command extensions
 * (~/.pi/agent/extensions, project .pi/extensions), or a playbook entry in
 * MEMORY.md ## Patterns. "Created nothing" remains a complete, successful result.
 */
export interface DistillPromptArgs {
  memoryRoot: string;
  dbPath: string;
  projectId: string;
  projectMemoryPath: string;
  agentDir: string;
}

export function distillPrompt(a: DistillPromptArgs): string {
  return `# Distill: Workflow Packaging

You look back over recent work, identify repeated manual workflows worth
packaging, and turn only the high-confidence ones into reusable assets:
pi skills, slash-command extensions, or recurring playbooks.

Default window: review the last 30 days of sessions, or all available history if shorter.

## Data Source

History database: \`${a.dbPath}\` (SQLite, read-only — query with \`sqlite3 -readonly\`)
Memory files root: \`${a.memoryRoot}\`
This project's id: \`${a.projectId}\`
This project's memory file: \`${a.projectMemoryPath}\`
Pi agent dir: \`${a.agentDir}\`

## Ground Rules

- Raw trajectory is authoritative; memory files are a structured index/cache.
- Prefer read-only bash commands for discovery and SQLite queries.
- Do not modify the SQLite database or raw trajectory.
- If nothing has actually been repeated, create nothing. Doing zero packaging is
  a valid and expected outcome; just say so in the summary rather than
  manufacturing an asset to justify the run.

## Phase 0 - Locate Data

Skim memory files for workflow signals: search MEMORY.md and recent checkpoint.md
files for "workflow", "repeat", "every time", "rule", "decision".

## Phase 1 - Inventory Existing Assets

Before creating anything, inventory what already exists — reuse or extend, don't duplicate:

- Glob \`${a.agentDir}/skills/*/SKILL.md\` and \`${a.agentDir}/skills/**/*.md\` (global pi skills)
- Glob \`${a.agentDir}/extensions/*\` (global pi extensions, including slash commands)
- Glob \`.pi/skills/**\` and \`.pi/extensions/**\` in the project root (project-local assets)
- Read \`${a.projectMemoryPath}\` ## Patterns (existing playbooks)

## Phase 2 - Discover Repeated Workflows From Memory

Scan recent \`${a.memoryRoot}/sessions/*/checkpoint.md\`, \`notes.md\`, and
\`${a.projectMemoryPath}\` (## Patterns / ## Rules) for manual sequences that
appear more than once.

## Phase 3 - Confirm Against Raw Trajectory

Schema: \`history_fts(id, session_id, project_id, seq, kind, tool_name, body, time_created)\`;
\`kind='tool_input'\` rows hold "toolname {json-args}" previews; \`time_created\` is epoch ms.

Query template to find repeated tool/command usage across recent sessions:

  sqlite3 -readonly "${a.dbPath}" "SELECT tool_name, substr(body,1,200) AS input_preview, COUNT(*) AS n FROM history_fts WHERE kind='tool_input' AND project_id='${a.projectId}' AND time_created > <CUTOFF_MS> GROUP BY tool_name, input_preview ORDER BY n DESC LIMIT 50;"

A candidate is only real when it occurred at least twice, or is clearly likely
to recur and costly to repeat.

## Phase 4 - Shortlist

For each candidate: workflow / evidence + dates [ses_xxx] / frequency-confidence /
recommended form / why.

## Phase 5 - Choose The Smallest Form

- Skill → \`${a.agentDir}/skills/<name>/SKILL.md\` (or project \`.pi/skills/<name>/SKILL.md\`) with YAML frontmatter (name, description) — for know-how the agent should load on demand.
- Slash command → a small TypeScript extension registering the command, in \`${a.agentDir}/extensions/\` (or project \`.pi/extensions/\`) — only when a deterministic, parameterized action is wanted.
- Playbook → an entry in \`${a.projectMemoryPath}\` under \`## Patterns\` — for sequences that need judgment each time.
- Automation: do not invent a scheduler. If a workflow needs periodic running, write it as a skill or command the user can invoke.
- Extend existing: prefer adding to an existing skill/command over creating a near-duplicate.
- Skip: when evidence is weak.

## Phase 6 - Create And Validate

Create in the project's \`.pi/\` unless the workflow is clearly global. Verify any
referenced paths with Glob and names with Grep. No irreversible external actions.

## Output Format

Return a brief summary:

- Shortlist: candidates considered.
- Created or extended: assets written, with paths.
- Skipped: candidates rejected and why.
- Needs more evidence: candidates to watch.

"Created nothing - no repeated workflow worth packaging" is a complete, successful result.
`;
}
