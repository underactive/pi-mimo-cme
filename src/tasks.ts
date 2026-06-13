/**
 * User task-graph reader — closes the §4 "Task tree" gap (plan §7).
 *
 * MiMoCode's checkpoint §4 was sourced from a `task`/`task_event` registry. pi
 * has no such registry, but the community extension `@juicesharp/rpiv-todo` (a
 * soft, optional dependency) maintains one: every `todo` tool call returns a
 * tool-result whose `details` field carries the COMPLETE task snapshot
 * (`{ action, params, tasks[], nextId }`). rpiv-todo persists nothing to disk
 * and emits nothing on `pi.events`; it survives /reload by replaying that
 * snapshot from the session branch (its `state/replay.ts`). We read the SAME
 * branch the SAME way — last-write-wins over `toolResult`/`toolName==="todo"` —
 * so we reconstruct the live task graph without importing the package.
 *
 * Confirmed live (plan §7.5): the `details` payload IS present on the branch
 * messages we reach via `ctx.sessionManager.getBranch()`.
 *
 * Pure module (no DB, no pi imports) — the snapshot is already persisted in the
 * branch, so unlike the actor ledger there is nothing to store. Runs under plain
 * `node --test`.
 */
import { estimateTokens } from "./budget.ts";

/** rpiv-todo statuses (tool/types.ts:26). `deleted` is terminal/hidden. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

/** A single task, mirroring rpiv-todo's `Task` (tool/types.ts:30-39). */
export interface TodoTask {
  id: number;
  subject: string;
  status: TodoStatus;
  activeForm?: string;
  description?: string;
  blockedBy?: number[];
  owner?: string;
}

/** Clip applied to a single rendered task line. */
const LINE_CAP = 200;

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap) + "…";
}
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Discriminator for the `details` envelope, byte-compatible with rpiv-todo's
 * `isTaskDetails` (state/replay.ts:9-13). Defensive — entries from older or
 * corrupt sessions are skipped silently.
 */
function isTaskDetails(v: unknown): v is { tasks: unknown[]; nextId: number } {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.tasks) && typeof r.nextId === "number";
}

const VALID_STATUS = new Set<TodoStatus>(["pending", "in_progress", "completed", "deleted"]);

/** Coerce one raw task object defensively; null if it lacks a usable id+subject. */
function coerceTask(v: unknown): TodoTask | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r["id"] !== "number" || typeof r["subject"] !== "string") return null;
  const status = (typeof r["status"] === "string" && VALID_STATUS.has(r["status"] as TodoStatus)
    ? (r["status"] as TodoStatus)
    : "pending") as TodoStatus;
  const task: TodoTask = { id: r["id"], subject: r["subject"], status };
  if (typeof r["activeForm"] === "string") task.activeForm = r["activeForm"];
  if (typeof r["description"] === "string") task.description = r["description"];
  if (Array.isArray(r["blockedBy"])) {
    const deps = r["blockedBy"].filter((x): x is number => typeof x === "number");
    if (deps.length > 0) task.blockedBy = deps;
  }
  if (typeof r["owner"] === "string" && r["owner"]) task.owner = r["owner"];
  return task;
}

/**
 * Last-write-wins scan over the branch messages (the `branchMessages` shape:
 * `getBranch().filter(type==="message").map(e=>e.message)`) for the latest
 * `todo` tool-result snapshot. Returns [] when rpiv-todo is absent / no task was
 * ever created. Each `details.tasks` array is the COMPLETE post-mutation state,
 * so the last matching message alone yields the current graph.
 */
export function readTaskSnapshot(messages: unknown[]): TodoTask[] {
  let tasks: TodoTask[] = [];
  for (const raw of messages) {
    const m = raw as { role?: string; toolName?: string; details?: unknown };
    if (!m || typeof m !== "object") continue;
    if (m.role !== "toolResult" || m.toolName !== "todo") continue;
    if (!isTaskDetails(m.details)) continue;
    tasks = m.details.tasks.map(coerceTask).filter((t): t is TodoTask => t !== null);
  }
  return tasks;
}

/** in_progress → pending → completed; `deleted` filtered out before this runs. */
const STATUS_ORDER: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 };

/** One task → a single condensed line, mirroring rpiv-todo's list format. */
function renderTaskLine(t: TodoTask): string {
  const form = t.status === "in_progress" && t.activeForm ? ` (${oneLine(t.activeForm)})` : "";
  const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const owner = t.owner ? ` @${t.owner}` : "";
  return clip(`- [${t.status}] #${t.id} ${oneLine(t.subject)}${form}${block}${owner}`, LINE_CAP);
}

/** Accumulate lines until the token cap, noting any dropped tail. */
function capLines(lines: string[], capTokens: number): string {
  let body = "";
  let dropped = 0;
  for (const [i, line] of lines.entries()) {
    const next = body + line + "\n";
    if (estimateTokens(next) > capTokens) {
      dropped = lines.length - i;
      break;
    }
    body = next;
  }
  if (dropped > 0) body += `…and ${dropped} more (use the todo tool to list)\n`;
  return body.trimEnd();
}

/**
 * Render the task graph as condensed lines, ordered in_progress → pending →
 * completed, budget-clipped. `deleted` tasks are always excluded; with
 * `openOnly` also drops `completed` (used by the rebuild dump, which surfaces
 * only still-actionable tasks — the analog of `## Active actors`). Returns ""
 * when nothing is left to show, so callers can omit the section.
 */
export function buildTaskTree(
  tasks: TodoTask[],
  capTokens: number,
  opts?: { openOnly?: boolean },
): string {
  let view = tasks.filter((t) => t.status !== "deleted");
  if (opts?.openOnly) view = view.filter((t) => t.status === "in_progress" || t.status === "pending");
  if (view.length === 0) return "";
  const sorted = [...view].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.id - b.id,
  );
  return capLines(sorted.map(renderTaskLine), capTokens);
}
