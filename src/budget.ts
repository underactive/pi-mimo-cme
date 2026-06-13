/**
 * Token estimation (~4 chars/token) and budgeted file reads with MiMoCode's
 * truncation marker so the agent can fetch the missing tail by line offset.
 */
import * as fs from "node:fs";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Returns undefined when the file does not exist / is unreadable. */
export function budgetedRead(filePath: string, capTokens: number): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return budgetText(text, capTokens, filePath);
}

export function budgetText(text: string, capTokens: number, filePath: string): string {
  if (estimateTokens(text) <= capTokens) return text;
  const capChars = capTokens * 4;
  let cut = text.slice(0, capChars);
  // Cut at a line boundary so the Read offset in the marker is exact.
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > 0) cut = cut.slice(0, lastNewline + 1);
  const linesIncluded = cut.split("\n").length - 1;
  const offset = linesIncluded + 1;
  return (
    cut +
    `\n⚠️ Truncated at ~${capTokens} tokens. Read("${filePath}", offset=${offset}) for the rest.`
  );
}
