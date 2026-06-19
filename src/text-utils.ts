/**
 * Shared text utilities used by checkpoint, actors, and tasks renderers.
 * Centralised here to avoid duplicating identical helpers across modules.
 */
import { estimateTokens } from "./budget.ts";

/** Truncate text to `cap` characters, appending "…" when truncated. */
export function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap) + "…";
}

/** Collapse a multi-line value to a single trimmed line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Accumulate rendered lines until the token cap, noting any dropped tail with
 * the supplied suffix message. Returns the joined, trimmed body.
 */
export function capLines(lines: string[], capTokens: number, droppedSuffix: string): string {
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
  if (dropped > 0) body += `…and ${dropped} more ${droppedSuffix}\n`;
  return body.trimEnd();
}
