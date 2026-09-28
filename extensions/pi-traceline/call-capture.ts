// Borrowing pi's native call grammar (§9.6) means rendering the tool's call component at a
// width where nothing wraps. pi-tui pads every rendered line to the requested width and
// measures it again for the background pass, so a capture costs O(width) per call line.
// The historical fixed 10,000-column capture made every recompute (startup, resume,
// /clone, Ctrl+O, theme or cell-size invalidation) cost O(10,000 x call lines): about
// twenty seconds for a 300-call session, with the TUI frozen.
//
// Two bounded captures prove the same result instead. Greedy word wrap at the wider width
// always leaves a line wider than the narrow width can hold, so when both captures agree
// once trailing padding is removed, neither wrapped, cut or re-laid out anything, and the
// wide capture agrees too. Pairs escalate from the cheapest width most call lines fit;
// anything no pair can prove falls back to the wide capture.
import { ansiEndIndex } from "../_lib/ansi.ts";
import type { ToolArgsLike, ToolCallRendererLike } from "../_lib/chat.ts";

const WIDE_CAPTURE_WIDTH = 10_000;
// Measured on a 300-call session: 256 then 1,024 cost ~10x less padding work than the
// wide capture, and about 40% less than a single 512-column pair.
const NARROW_CAPTURE_WIDTHS = [256, 1_024];
// Runs of spaces are the one token greedy wrap never force-breaks, so a wrap that happens
// at a space run can look identical at both widths. The check width covers runs shorter
// than MAX_SPACE_RUN; args holding a longer run go straight to the wide capture. What
// remains uncovered is a line wider than a check width whose text does not come from the
// args (an edit's on-disk diff context) wrapping exactly at such a run.
const MAX_SPACE_RUN = 64;
const LONG_SPACE_RUN = new RegExp(` {${MAX_SPACE_RUN},}`);

/** The call component's lines as a wide capture would render them, trailing padding aside. */
export function captureCallLines(call: ToolCallRendererLike | undefined, args: ToolArgsLike | undefined): string[] | undefined {
  const render = call?.render;
  if (!render) return undefined;
  if (!LONG_SPACE_RUN.test(JSON.stringify(args ?? {}))) {
    for (const width of NARROW_CAPTURE_WIDTHS) {
      const narrow = renderedLines(render.call(call, width));
      const check = renderedLines(render.call(call, width * 2 + 2 + MAX_SPACE_RUN));
      if (narrow.length === check.length && narrow.every((line, i) => withoutTrailingPadding(line) === withoutTrailingPadding(check[i]!))) {
        return narrow;
      }
    }
  }
  return renderedLines(render.call(call, WIDE_CAPTURE_WIDTH));
}

function renderedLines(rendered: unknown): string[] {
  return Array.isArray(rendered) ? rendered.map((line) => String(line)) : [];
}

/** The line up to its last visible non-space cell, then its trailing escape sequences with
 * the width-dependent padding spaces between them removed. */
function withoutTrailingPadding(line: string): string {
  let lastVisible = -1;
  for (let i = 0; i < line.length; i++) {
    const escapeEnd = ansiEndIndex(line, i);
    if (escapeEnd !== undefined) {
      i = escapeEnd;
      continue;
    }
    if (line[i] !== " ") lastVisible = i;
  }
  let tail = "";
  for (let i = lastVisible + 1; i < line.length; i++) {
    const escapeEnd = ansiEndIndex(line, i);
    if (escapeEnd === undefined) continue; // only padding spaces remain past lastVisible
    tail += line.slice(i, escapeEnd + 1);
    i = escapeEnd;
  }
  return `${line.slice(0, lastVisible + 1)}${tail}`;
}
