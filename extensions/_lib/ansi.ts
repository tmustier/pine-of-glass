// Shared ANSI helpers for the pine-of-glass extension family.
// This directory has no index.ts on purpose: pi's extension discovery skips it.

/** Matches one OSC sequence (hyperlink/title). The payload can never contain ESC — ESC
 * starts the ST terminator — so excluding it keeps the match from greedily swallowing
 * the visible text between an ST-terminated OSC 8 open and its close. */
export const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip CSI (colors/cursor) and OSC (hyperlink/title) escape sequences. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(OSC_SEQUENCE, "");
}

/** Index of the last char of the escape sequence starting at `i`, or undefined. */
export function ansiEndIndex(line: string, i: number): number | undefined {
  if (line[i] !== "\x1b") return undefined;
  if (line[i + 1] === "[") {
    const end = line.slice(i).search(/[A-Za-z~]/);
    return end >= 0 ? i + end : undefined;
  }
  if (line[i + 1] === "]") {
    const bel = line.indexOf("\x07", i + 2);
    const st = line.indexOf("\x1b\\", i + 2);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    return end >= 0 ? end + (line[end] === "\x1b" ? 1 : 0) : undefined;
  }
  return undefined;
}

/** Raw string index of the visible character at visible index `target` (escape-aware). */
export function rawIndexAtVisibleIndex(line: string, target: number): number {
  let visible = 0;
  for (let i = 0; i < line.length; i++) {
    const ansiEnd = ansiEndIndex(line, i);
    if (ansiEnd !== undefined) {
      i = ansiEnd;
      continue;
    }
    if (visible === target) return i;
    visible++;
  }
  return line.length;
}

/** Like rawIndexAtVisibleIndex, but lands *before* any escapes preceding the char. */
export function rawIndexBeforeVisibleIndex(line: string, target: number): number {
  let visible = 0;
  for (let i = 0; i < line.length; i++) {
    if (visible === target) return i;
    const ansiEnd = ansiEndIndex(line, i);
    if (ansiEnd !== undefined) {
      i = ansiEnd;
      continue;
    }
    visible++;
  }
  return line.length;
}
