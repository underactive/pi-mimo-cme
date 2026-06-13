/**
 * The `memory` (curated recall) and `history` (raw trajectory) tools.
 */
import type { DatabaseSync } from "node:sqlite";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CmeConfig } from "./config.ts";
import type { FooterCounts } from "./footer-counts.ts";
import {
  AROUND_MAX_BYTES,
  historyAround,
  historySearch,
  memorySearch,
  type MemoryHit,
} from "./fts.ts";
import { projectId } from "./paths.ts";
import { reconcileAndNotify } from "./commands.ts";
import { ALL_HISTORY_KINDS } from "./history.ts";

export interface ToolDeps {
  db: DatabaseSync;
  root: string;
  config: CmeConfig;
  /** Cached footer counters (phase 1); the memory tool's reconcile reseeds it. */
  counts?: FooterCounts;
  /** UI toast, no-op without a UI (see index.ts notify shim). */
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

function formatMemoryHits(hits: MemoryHit[], root: string): string {
  if (hits.length === 0) {
    return [
      "No hits.",
      "",
      "Escalation ladder:",
      "1. Retry with fewer or rarer terms (BM25 ranks by token rarity).",
      `2. Grep the memory dir (${root}) for tokenizer-split literals (dotted.names, snake_case, CLI flags).`,
      "3. Use the history tool for verbatim past-conversation content.",
      "4. Widen scope: session → project → global → history.",
    ].join("\n");
  }
  const rows = hits.map(
    (h) =>
      `${h.path}\n  scope=${h.scope}${h.scope_id ? `/${h.scope_id}` : ""} type=${h.type} score=${h.score.toFixed(2)}\n  ${h.snippet}`,
  );
  return (
    rows.join("\n\n") +
    "\n\nA hit here is authoritative: these are your own memory files. If you need the FULL body (snippets are truncated), Read the path."
  );
}

export function registerMemoryTool(pi: ExtensionAPI, deps: ToolDeps): void {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Search your persistent memory layers (session checkpoints, project memory, global memory) with BM25 full-text search over markdown bodies. " +
      "Use this FIRST when past context might already record the answer — before asking the user or re-deriving it. " +
      "Hits return path / scope / type / score / snippet; Read the path for the full body.",
    promptSnippet: "Search persistent memory layers (BM25 full-text over memory files)",
    promptGuidelines: [
      "Use the memory tool first when the user references past work, prior decisions, or anything memory may already record — before asking the user.",
      "If the memory tool returns nothing useful, escalate to the history tool for raw past-conversation search.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query (BM25 over markdown bodies)" }),
      scope: Type.Optional(
        StringEnum(["global", "projects", "sessions", "cc"] as const, {
          description: "Restrict to one memory scope",
        }),
      ),
      scope_id: Type.Optional(
        Type.String({ description: "Scope id: session id or 12-hex project id hash" }),
      ),
      type: Type.Optional(
        Type.String({ description: "Memory type filter: memory | checkpoint | notes | free" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    // DatabaseSync is synchronous, but sequential makes write-ordering explicit.
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (deps.config.checkpoint.reconcileOnSearch) {
        reconcileAndNotify(deps);
      }
      const hits = memorySearch(deps.db, {
        query: params.query,
        scope: params.scope,
        scopeId: params.scope_id,
        type: params.type,
        limit: params.limit,
        floorRatio: deps.config.checkpoint.scoreFloor,
      });
      return {
        content: [{ type: "text", text: formatMemoryHits(hits, deps.root) }],
        details: { count: hits.length },
      };
    },
  });
}

export function registerHistoryTool(pi: ExtensionAPI, deps: ToolDeps): void {
  pi.registerTool({
    name: "history",
    label: "History",
    description:
      "Search RAW conversation trajectory across past sessions. USE ONLY WHEN MEMORY SEARCH RETURNS NOTHING USEFUL. " +
      "memory is your curated notebook — small, fast, semantically organized. ALWAYS try `memory` first. " +
      "history is the unindexed firehose of your past sessions — use it for verbatim recall (exact error text, an old command, a specific tool output) when curated memory has no answer. " +
      "operation=search: AND full-text search with filters; returns message_ids. " +
      "operation=around: fetch ±N rows around a message_id from a previous search.",
    promptSnippet: "Search raw past-session conversation history (escalation target after memory)",
    promptGuidelines: [
      "Use the history tool only after the memory tool returned nothing useful; then drill into context with operation=around.",
    ],
    parameters: Type.Object({
      operation: StringEnum(["search", "around"] as const, {
        description: "search: full-text query; around: window around a message_id",
        default: "search",
      }),
      query: Type.Optional(Type.String({ description: "Search query (AND-joined tokens)" })),
      scope: Type.Optional(
        StringEnum(["project", "global"] as const, {
          description: "project (default): this project only; global: all projects",
        }),
      ),
      session_id: Type.Optional(Type.String({ description: "Restrict to one session" })),
      kind: Type.Optional(
        Type.Array(StringEnum([...ALL_HISTORY_KINDS] as const), {
          description: "Restrict to row kinds",
        }),
      ),
      tool_name: Type.Optional(Type.String({ description: "Restrict tool_* rows to one tool" })),
      time_after: Type.Optional(Type.Number({ description: "Epoch ms lower bound" })),
      time_before: Type.Optional(Type.Number({ description: "Epoch ms upper bound" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, hard cap 50)" })),
      message_id: Type.Optional(
        Type.String({ description: "Anchor for operation=around (from a search hit)" }),
      ),
      before: Type.Optional(Type.Number({ description: "Rows before the anchor (default 5)" })),
      after: Type.Optional(Type.Number({ description: "Rows after the anchor (default 5)" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const pid = projectId(ctx.cwd);
      if (params.operation === "around") {
        if (!params.message_id) throw new Error("operation=around requires message_id");
        const result = historyAround(deps.db, params.message_id, params.before, params.after);
        if ("error" in result) throw new Error(result.error);
        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: "No rows around that message_id." }], details: {} };
        }
        let text = result.rows
          .map(
            (r) =>
              `[${r.message_id}] ${r.kind}${r.tool_name ? ` (${r.tool_name})` : ""} ${new Date(r.time_created).toISOString()}\n${r.body}`,
          )
          .join("\n\n");
        if (result.overflow) {
          text += `\n\n[output capped at ${AROUND_MAX_BYTES} bytes — narrow the window with smaller before/after]`;
        }
        return { content: [{ type: "text", text }], details: { count: result.rows.length } };
      }
      if (!params.query) throw new Error("operation=search requires query");
      const hits = historySearch(deps.db, {
        query: params.query,
        scope: params.scope,
        projectId: pid,
        sessionId: params.session_id,
        kinds: params.kind,
        toolName: params.tool_name,
        timeAfter: params.time_after,
        timeBefore: params.time_before,
        limit: params.limit,
      });
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No hits. Tokens are AND-joined — try fewer terms, or scope=global to search all projects.",
            },
          ],
          details: { count: 0 },
        };
      }
      const text = hits
        .map(
          (h) =>
            `[${h.message_id}] ${h.kind}${h.tool_name ? ` (${h.tool_name})` : ""} ${new Date(h.time_created).toISOString()}\n  ${h.snippet}`,
        )
        .join("\n")
        .concat("\n\nUse operation=around with a message_id to read the surrounding conversation.");
      return { content: [{ type: "text", text }], details: { count: hits.length } };
    },
  });
}
