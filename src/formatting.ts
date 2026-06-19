/**
 * Shared formatting utilities for /memory readouts.
 *
 * Visual conventions (consistent across status, metrics, validations, search):
 * - Section dividers: `── Name ──`
 * - Progress bars: auto-width based on context window (20 chars ≤100K, 30 chars >100K)
 * - Token display: `fmtK()` — ≥1000 → "1.2K", <1000 → "847"
 * - Estimates: `≈` prefix for approximate values
 * - Column alignment: fixed-width labels with trailing spaces
 */

/** Compact token display: ≥1000 → "1.2K", <1000 → raw number. */
export function fmtK(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(Math.round(tokens));
}

/**
 * Section divider: `── Name ──`, padded to a fixed width for visual consistency.
 * Width: 40 chars total (adjustable via `width` param).
 */
export function sectionHeader(name: string, width = 40): string {
  const inner = ` ${name} `;
  const dashCount = Math.max(2, width - inner.length);
  const left = Math.ceil(dashCount / 2);
  const right = dashCount - left;
  return `${"─".repeat(left)}${inner}${"─".repeat(right)}`;
}

/**
 * Auto-width ASCII progress bar. Returns a string like `[████████░░░░░░░░░░░░] 42%`.
 *
 * Bar width adapts to context window:
 * - ≤100K tokens → 20 chars
 * - >100K tokens → 30 chars
 *
 * @param current - current value (e.g. injection overhead tokens)
 * @param max - maximum value (e.g. context window size)
 * @param contextWindow - model's context window for width selection (default 200_000)
 */
export function bar(current: number, max: number, contextWindow = 200_000): string {
  const width = contextWindow <= 100_000 ? 20 : 30;
  const ratio = max > 0 ? Math.min(current / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);
  const filledChar = "█";
  const emptyChar = "░";
  return `[${filledChar.repeat(filled)}${emptyChar.repeat(empty)}] ${pct}%`;
}

/**
 * Column-aligned label: pads the label to `labelWidth` chars, then appends the value.
 * Example: `"  writer tokens/run:   input≈1,234  output≈567"`
 */
export function labelValue(label: string, value: string, labelWidth = 22): string {
  return `${label.padEnd(labelWidth)}${value}`;
}

/**
 * Compact token line: `"label:  [bar] ~X.YK tok / ZK (N.N%)"`
 * Used for injection breakdown total line.
 */
export function tokenBarLine(
  label: string,
  current: number,
  max: number,
  contextWindow = 200_000,
): string {
  const b = bar(current, max, contextWindow);
  const pctText = max > 0 ? ` (${(current / max * 100).toFixed(1)}%)` : "";
  return `${label.padEnd(22)}${b} ${fmtK(current)} / ${fmtK(max)}${pctText}`;
}

/**
 * Simple key=value pair with padding, for the injection breakdown detail lines.
 * Example: `"  instructions:         ~2.5K tok"`
 */
export function kvLine(key: string, value: string, keyWidth = 22): string {
  return `  ${key.padEnd(keyWidth - 2)}${value}`;
}
