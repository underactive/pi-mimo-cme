/**
 * THROWAWAY confirmation probe (not shipped). Proves whether the `todo`
 * tool-result `details` payload survives in the branch messages pi-mimo-cme
 * reaches via `ctx.sessionManager.getBranch()`.
 *
 * It runs the EXACT access path the real integration (Option A) would use:
 *   1. pi-mimo-cme's `branchMessages`: getBranch().filter(type==="message").map(e=>e.message)
 *   2. rpiv-todo's replay scan: last toolResult whose toolName==="todo" with a TaskDetails `details`
 *
 * On every turn_end (and session_shutdown) it writes a JSON diagnostic to
 * $PROBE_OUT. Captures enough to debug a FAIL: if `details` is stripped, it
 * dumps the keys + a JSON sample of the first todo toolResult so we can see
 * what the branch actually carries.
 *
 * Load:  pi -e scripts/probe-todo-branch.ts -p "<prompt that calls the todo tool>"
 */
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Import the SHIPPED reader/renderer so the probe proves the real §4 path, not a
// reimplementation: live branch → readTaskSnapshot → buildTaskTree.
import { buildTaskTree, readTaskSnapshot } from "../src/tasks.ts";

function isTaskDetails(v: unknown): v is { tasks: unknown[]; nextId: number } {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.tasks) && typeof r.nextId === "number";
}

export default function probe(pi: ExtensionAPI) {
  const out = process.env["PROBE_OUT"] ?? "/tmp/probe-todo-branch.json";

  function scan(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }, trigger: string): void {
    // (1) pi-mimo-cme's branchMessages shape:
    const entries = [...ctx.sessionManager.getBranch()];
    const messages = entries
      .filter((e) => (e as { type?: string }).type === "message")
      .map((e) => (e as { message: unknown }).message);

    // (2) rpiv-todo replay scan over those messages:
    const todoResults = messages.filter((m) => {
      const x = m as { role?: string; toolName?: string };
      return x?.role === "toolResult" && x.toolName === "todo";
    });

    let lastTasks: unknown[] | null = null;
    let withDetails = 0;
    let withTaskDetails = 0;
    for (const m of todoResults) {
      const details = (m as { details?: unknown }).details;
      if (details !== undefined) withDetails++;
      if (isTaskDetails(details)) {
        withTaskDetails++;
        lastTasks = details.tasks; // last-write-wins
      }
    }

    // End-to-end: run the SHIPPED code path the writer/rebuild use.
    const snapshot = readTaskSnapshot(messages);
    const renderedTaskTree = buildTaskTree(snapshot, 2000); // checkpoint §4 source
    const renderedOpenTasks = buildTaskTree(snapshot, 2000, { openOnly: true }); // rebuild dump

    const sample = todoResults[0] as Record<string, unknown> | undefined;
    const diag = {
      trigger,
      branchEntries: entries.length,
      messageEntries: messages.length,
      toolResultMessages: messages.filter(
        (m) => (m as { role?: string }).role === "toolResult",
      ).length,
      todoToolResults: todoResults.length,
      todoResultsWithDetailsField: withDetails,
      todoResultsWithValidTaskDetails: withTaskDetails,
      lastTasksCount: lastTasks ? lastTasks.length : 0,
      lastTasks: lastTasks ?? null,
      // The actual §4 / rebuild output the shipped code produces from this branch:
      shippedSnapshotCount: snapshot.length,
      shippedTaskTreeBlock: renderedTaskTree,
      shippedOpenTasksBlock: renderedOpenTasks,
      // Diagnostics for a FAIL: what does a todo toolResult actually look like?
      firstTodoResultKeys: sample ? Object.keys(sample) : null,
      firstTodoResultSample: sample ? JSON.parse(JSON.stringify(sample)) : null,
    };
    try {
      fs.writeFileSync(out, JSON.stringify(diag, null, 2));
    } catch {
      /* probe must never throw */
    }
  }

  pi.on("turn_end", (_event, ctx) => {
    try {
      scan(ctx as never, "turn_end");
    } catch {
      /* ignore */
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      if (ctx) scan(ctx as never, "session_shutdown");
    } catch {
      /* ignore */
    }
  });
}
