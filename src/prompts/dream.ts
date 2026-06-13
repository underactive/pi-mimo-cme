/**
 * Dream prompt — MiMoCode's dream.txt adapted for pi-mimo-cme:
 * - data paths point at our memory root and memory.db;
 * - Phase 3 documents OUR history_fts schema with sqlite3-CLI query templates
 *   (read-only);
 * - task/actor registry material removed (pi has none).
 * All ground rules, phases, keyword lists, size caps, [unverified] marks,
 * [ses_xxx] provenance, merge-don't-append, and absolute dates preserved.
 */
export interface DreamPromptArgs {
  memoryRoot: string;
  dbPath: string;
  projectId: string;
  projectMemoryPath: string;
  globalMemoryPath: string;
}

export function dreamPrompt(a: DreamPromptArgs): string {
  return `# Dream: Memory Consolidation

You consolidate durable project memory from two sources:

1. Memory files under the memory tree at \`${a.memoryRoot}\`.
2. Raw conversation history indexed in the local SQLite database.

Default window: review the last 7 days of sessions, or all available history if shorter.

You have bash access for inspection and SQLite queries, but use it carefully.

## Data Source

History database: \`${a.dbPath}\` (SQLite, read-only)
Memory files root: \`${a.memoryRoot}\`
This project's id: \`${a.projectId}\`
This project's memory file: \`${a.projectMemoryPath}\`
Global memory file: \`${a.globalMemoryPath}\`

## Ground Rules

- Raw trajectory is authoritative; memory files are a structured index/cache.
- Prefer read-only bash commands for discovery and SQLite queries.
- Do not modify the SQLite database or raw trajectory.
- Write final durable knowledge only to project memory files unless the task explicitly requires cleaning current session notes.
- Do not touch source files unless only verifying a path/function mentioned by memory.
- Keep the memory folder compact and high-signal. Information density matters more than completeness.
- Reuse existing memories instead of duplicating them. Packaging repeated workflows into skills or commands is the job of \`/distill\`, not dream.
- \`${a.globalMemoryPath}\` is for cross-project user preferences and habits (heading: \`# Global memory\`). Prefer the project's MEMORY.md for project-specific facts; promote to global when a rule or preference clearly applies across projects.

## Phase 0 - Locate Data

1. Use Glob/Read to inspect the memory tree under \`${a.memoryRoot}\` (global/, projects/${a.projectId}/, sessions/).
2. Verify the database exists at \`${a.dbPath}\`. Treat it as read-only: query with \`sqlite3 -readonly\`.
3. If memory is empty and the database has no rows for project '${a.projectId}', report "Nothing to consolidate - memory is empty" and stop.

## Phase 1 - Orient

- Read the current project's \`MEMORY.md\` at \`${a.projectMemoryPath}\` (it may not exist yet).
- Read current session \`notes.md\` if it exists.
- Glob \`${a.memoryRoot}/sessions/*/checkpoint.md\` and identify recent checkpoints.
- Use bash/SQLite to list recent sessions for this project, newest first:

  sqlite3 -readonly "${a.dbPath}" "SELECT session_id, COUNT(*) AS rows, datetime(MIN(time_created)/1000,'unixepoch') AS first, datetime(MAX(time_created)/1000,'unixepoch') AS last FROM history_fts WHERE project_id='${a.projectId}' GROUP BY session_id ORDER BY MAX(time_created) DESC LIMIT 20;"

- Record the current \`MEMORY.md\` section structure before editing to avoid duplicates.

## Phase 2 - Gather From Memory Files

Extract candidate durable facts from recent memory artifacts:

1. Recent \`checkpoint.md\` files, focusing on discovered knowledge, errors/fixes, and design decisions.
2. \`notes.md\` entries not already represented in project memory.

Do not read every file exhaustively. Prefer recent and repeated signals.

## Phase 3 - Verify Against Raw Trajectory

Use bash with read-only sqlite3 queries to check candidate facts against raw history.

Schema notes (this is pi-mimo-cme's own history index, NOT OpenCode's message/part tables):

- \`history_fts(id, session_id, project_id, seq, kind, tool_name, body, time_created)\` — one row per extracted conversation fragment.
  - \`kind\` ∈ user_text | assistant_text | tool_input | tool_error | reasoning | tool_output
  - \`tool_name\` is set for tool_input / tool_error / tool_output rows.
  - \`seq\` orders rows chronologically within a session.
  - \`time_created\` is epoch milliseconds.
  - \`project_id\` is the 12-hex project hash; this project is '${a.projectId}'.
- \`history_fts_idx\` is the FTS5 full-text index over body; join \`history_fts.id = history_fts_idx.rowid\` and filter with MATCH.

Query template — a session's chronological flow:

  sqlite3 -readonly "${a.dbPath}" "SELECT seq, kind, tool_name, substr(body,1,800) FROM history_fts WHERE session_id='<SESSION_ID>' ORDER BY seq;"

Query template — keyword search across this project's history:

  sqlite3 -readonly "${a.dbPath}" "SELECT h.session_id, h.seq, h.kind, substr(h.body,1,300) FROM history_fts_idx i JOIN history_fts h ON h.id=i.rowid WHERE history_fts_idx MATCH '\\"<KEYWORD>\\"' AND h.project_id='${a.projectId}' ORDER BY h.time_created DESC LIMIT 40;"

Useful searches include user statements containing English keywords like:

- "always", "never", "remember", "rule"
- "decision", "decided", "tradeoff", "reason"
- "repeat", "again", "every time", "workflow"

Also search equivalent keywords in the user's language when the trajectory shows the user working in another language.
Also search for repeated error text, failed commands, and recurring file paths.

Promote a fact only when supported by an explicit user statement, a clear design decision, or repeated evidence across sessions.

Drill into full trajectories when:

- A session produced code files or architecture decisions but memory lacks detail; inspect tool_input rows for write/edit calls.
- A session involved debugging and gotchas may need promotion; inspect tool_error rows.
- A session has many rows but memory only has a short summary.

## Workflow Packaging

If you notice a repeated manual workflow worth packaging, leave it to the
\`/distill\` command, which is dedicated to that. You may note such a candidate in
one line, but do not create skills or commands here. Stay focused on
memory consolidation.

## Phase 4 - Consolidate

Edit the current project's \`MEMORY.md\` using these sections when useful:

- \`## Rules\` - project-level rules explicitly stated by the user.
- \`## Architecture decisions\` - decision + absolute date + rationale.
- \`## Discovered durable knowledge\` - cross-session durable facts.
- \`## Patterns\` - repeated problems and solutions.
- \`## Gotchas\` - easy-to-miss traps.

Principles:

- Merge duplicates instead of appending.
- Convert relative dates like "yesterday" to YYYY-MM-DD.
- Remove contradicted or obsolete entries when newer trajectory or code proves them stale.
- Keep each entry to 1-3 lines.
- Preserve source session ids at the end of entries, for example \`[ses_xxx]\`.

## Phase 5 - Prune And Verify

- Keep \`MEMORY.md\` under 200 lines and 10KB when possible. Prefer fewer, denser entries over exhaustive notes.
- Remove entries superseded by newer decisions.
- Remove details that mattered only to one session.
- Remove low-signal memory files or entries that are redundant with stronger project memory.
- Clear current \`notes.md\` entries only when fully integrated.
- Verify mentioned file paths with Glob.
- Verify mentioned function/class names with Grep.
- Mark unverifiable-but-plausible claims \`[unverified]\`.

## Output Format

Return a brief summary:

- Consolidated: new memory entries added.
- Updated: existing entries changed.
- Deleted: stale entries removed.
- Skipped: reason if no changes were made.
- Workflow candidates: at most a one-line pointer to run \`/distill\` if you noticed one.
- Health: project memory line count / 200 and size / 10KB.
`;
}
