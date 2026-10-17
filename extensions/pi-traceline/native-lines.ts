// Plain-text shaping of pi's native call and notice lines before the family ink goes
// on: whitespace and bullet trims, the key hint and timeout boilerplate, and the
// one-line flatten (design language §9.3/§9.6/§9.15).
import { rawIndexAtVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { LINE_BREAK_MARK } from "./bash-preamble.ts";

const RESET = "\x1b[0m";

export function trimLeadingVisibleWhitespace(line: string): string {
  const visible = stripAnsi(line);
  const leading = visible.match(/^\s*/)?.[0].length ?? 0;
  if (leading === 0) return line;
  return line.slice(rawIndexAtVisibleIndex(line, leading));
}

export function stripLeadingVisibleBullet(line: string): string {
  const trimmed = trimLeadingVisibleWhitespace(line);
  const visible = stripAnsi(trimmed);
  const bullet = visible.match(/^•\s*/)?.[0];
  if (!bullet) return trimmed;
  return trimmed.slice(rawIndexAtVisibleIndex(trimmed, bullet.length));
}

/** Pi's native collapsed rows carry a key hint. One-line mode is invocation-only, so
 * keep the styling and drop that non-invocation suffix. */
export function stripTrailingExpandHint(line: string): string {
  const visible = stripAnsi(line);
  const hint = visible.match(/ \([^)]*to expand\)\s*$/i)?.[0];
  if (!hint) return line;
  const rawStart = rawIndexAtVisibleIndex(line, visible.length - hint.length);
  return `${line.slice(0, rawStart)}${RESET}`;
}

// Native bash rows append " (timeout Ns)". It is near-constant boilerplate — the same
// dim parenthetical on every row — so in one-line mode it only spends width and adds
// noise; the full invocation (timeout included) is one Ctrl+T away. Bash rows
// are rebuilt from plain text (see bashInvocationText), so this works on plain text.
export function stripTimeoutSuffix(text: string): string {
  return text.replace(/ \(timeout [^)]*\)\s*$/i, "");
}

// Bash commands keep their real newlines (heredocs, inline python, chained pipelines),
// so first-line-only collapses them to an uninformative prefix like `$ python3 -c "`
// (issue #10). Flatten every visible line into the one trace line, with a ↵ where each
// break was — middle truncation then keeps the head *and* the operative tail. The marks
// stay plain here; inkBashBody dims them with the rest of the shell apparatus.
export function flattenInvocationLines(lines: string[]): string | undefined {
  const visible = lines
    .filter((line) => stripAnsi(line).trim().length > 0)
    .map((line) => trimLeadingVisibleWhitespace(line.trimEnd()));
  if (visible.length === 0) return undefined;
  return visible.join(` ${LINE_BREAK_MARK} `);
}
