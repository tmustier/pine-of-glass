import { ansiEndIndex, stripAnsi } from "../_lib/ansi.ts";
import { SEP } from "../_lib/style.ts";

/** Flatten call-only rendering; results and expanded geometry remain native. */
export function summarizeCallLines(lines: string[]): string | undefined {
  const visible = lines.filter((line) => stripAnsi(line).trim().length > 0);
  if (visible.length === 0) return undefined;
  return visible.map((line, index) => {
    const plain = stripAnsi(line);
    // Tree branches describe vertical layout, not the invocation. Leave ordinary
    // code operators and list bullets untouched; only continuation branches go.
    const prefix = index === 0 ? /^\s*/ : /^\s*(?:[└├]─?\s+)?/;
    const start = plain.match(prefix)![0].length;
    const end = plain.trimEnd().length;
    let text = "";
    let column = 0;
    for (let i = 0; i < line.length; i++) {
      const escapeEnd = ansiEndIndex(line, i);
      if (escapeEnd !== undefined) {
        text += line.slice(i, escapeEnd + 1);
        i = escapeEnd;
      } else {
        if (column >= start && column < end) text += line[i];
        column++;
      }
    }
    return text;
  }).join(SEP);
}
