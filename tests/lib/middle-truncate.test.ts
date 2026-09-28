// middleTruncate finds its tail cut from the end of the line. That must not change a
// single byte of output, so the pre-change implementation (v0.13.0, verbatim below) is
// the oracle for a seeded differential run over ANSI-laden, wide, combining, emoji and
// tab inputs; tabs and stray escapes deliberately exercise the forward fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { rawIndexAtVisibleIndex, stripAnsi } from "../../extensions/_lib/ansi.ts";
import { ELLIPSIS, ink, middleTruncate } from "../../extensions/_lib/style.ts";

const RESET = "\x1b[0m";
const MIN_HEAD_COLS = 6;
const TAIL_RATIO = 0.55;

// --- reference implementation (v0.13.0 extensions/_lib/style.ts, unchanged) ---------------
// Runtime logic is verbatim; only columnBoundary's return type is named, which changes no behaviour.
type ReferenceColumnCut = { plainIndex: number; column: number };

function activeSgrAt(line: string, rawIndex: number): string {
  const state = new Map<string, string>();
  const sgr = /\x1b\[([0-9;]*)m/g;
  let match: RegExpExecArray | null;
  while ((match = sgr.exec(line)) && match.index < rawIndex) {
    const params = match[1] ?? "";
    if (params === "" || params === "0") {
      state.clear();
      continue;
    }
    const key =
      params.startsWith("38") || params === "39" || /^(3[0-7]|9[0-7])$/.test(params)
        ? "fg"
        : params.startsWith("48") || params === "49" || /^(4[0-7]|10[0-7])$/.test(params)
          ? "bg"
          : params === "1" || params === "2" || params === "22"
            ? "weight"
            : params === "3" || params === "23"
              ? "italic"
              : params === "4" || params === "24"
                ? "underline"
                : params; // unknown/compound: replay verbatim, keyed by itself
    const off = params === "39" || params === "49" || params === "22" || params === "23" || params === "24";
    if (off) state.delete(key);
    else state.set(key, match[0]);
  }
  return [...state.values()].join("");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Map a terminal-column cut to a grapheme boundary in the stripped line. Wide
 * graphemes that straddle the cut are excluded whole: down excludes them from the
 * head, up excludes them from the tail. The returned column lets the caller replace
 * the excluded cell with padding so every truncated row keeps the exact block grid. */
function columnBoundary(
  text: string,
  target: number,
  round: "down" | "up",
): ReferenceColumnCut {
  let column = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const nextColumn = column + visibleWidth(segment);
    if (target <= column) return { plainIndex: index, column };
    if (target < nextColumn) {
      return round === "up"
        ? { plainIndex: index + segment.length, column: nextColumn }
        : { plainIndex: index, column };
    }
    column = nextColumn;
  }
  return { plainIndex: text.length, column };
}

function referenceMiddleTruncate(line: string, width: number, theme?: Theme): string {
  const maxWidth = Math.max(1, width);
  if (visibleWidth(line) <= maxWidth) return line;

  const vis = stripAnsi(line);
  const visLen = visibleWidth(vis);
  const ellipsisWidth = visibleWidth(ELLIPSIS);
  const budget = Math.max(1, maxWidth - ellipsisWidth); // reserve columns for the ellipsis

  const maxTail = Math.min(budget - MIN_HEAD_COLS, Math.max(12, Math.floor(budget * TAIL_RATIO)));
  if (maxTail < 1) return truncateToWidth(line, maxWidth, ELLIPSIS);

  // The cut is a column (design language §9.8): the tail is exactly `maxTail` wide and
  // the head exactly fills the rest, so every line truncated to the same budget cuts at
  // identical columns and fills the budget exactly. Wide graphemes that cross either cut
  // round out of the retained spans; padding keeps the ellipsis and right edge fixed.
  const tailStart = visLen - maxTail;
  const tailBoundary = columnBoundary(vis, tailStart, "up");
  const dimEllipsis = ink(theme, "dim", ELLIPSIS);
  const tailRawStart = rawIndexAtVisibleIndex(line, tailBoundary.plainIndex);
  const tailRaw = `${activeSgrAt(line, tailRawStart)}${line.slice(tailRawStart)}`;
  const tailPadding = Math.max(0, maxTail - (visLen - tailBoundary.column));

  const headEnd = budget - maxTail;
  if (headEnd <= 0) return `${dimEllipsis}${" ".repeat(tailPadding)}${tailRaw}`;

  const headBoundary = columnBoundary(vis, headEnd, "down");
  const headRaw = line.slice(0, rawIndexAtVisibleIndex(line, headBoundary.plainIndex));
  const headPadding = Math.max(0, headEnd - headBoundary.column);
  return `${headRaw}${RESET}${" ".repeat(headPadding)}${dimEllipsis}${" ".repeat(tailPadding)}${tailRaw}`;
}
// --- differential run --------------------------------------------------------------------

const recordingTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
  bg: (_color: string, text: string) => text,
} as unknown as Theme;

const PIECES = [
  "src/extensions/index.ts", "npm", " ", "  ", "--flag=value", "a", "hello world", "/", ":1-200",
  "·", "…", "›", "▏", "漢字", "表", "e\u0301", "🇺🇸", "\u{1F1FA}", "👩‍💻", "1\uFE0F\u20E3", "\u0600x",
  "ก\u0e33", "각", "é", "\u200d", "\ufe0f",
  "\x1b[38;5;245m", "\x1b[39m", "\x1b[1m", "\x1b[22m", "\x1b[0m", "\x1b[48;2;1;2;3m", "\x1b[m",
  "\x1b]8;;file:///tmp/x.ts\x1b\\", "\x1b]8;;\x1b\\",
];
const FALLBACK_PIECES = ["\t", "\x1b_pi:c\x07"];

function seeded(seed: number): (n: number) => number {
  let state = seed;
  return (n) => ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) % n);
}

function randomLine(pick: (n: number) => number, fallback: boolean): string {
  const pieces = fallback ? [...PIECES, ...FALLBACK_PIECES] : PIECES;
  let line = "";
  const length = 1 + pick(pick(4) === 0 ? 400 : 60);
  for (let i = 0; i < length; i++) line += pieces[pick(pieces.length)]!;
  return line;
}

test("middleTruncate output is byte-identical to the forward-scan reference", () => {
  const pick = seeded(20260927);
  let truncated = 0;
  for (let run = 0; run < 12_000; run++) {
    const line = randomLine(pick, run % 5 === 0);
    const width = 1 + pick(pick(3) === 0 ? 300 : 90);
    const theme = run % 2 === 0 ? undefined : recordingTheme;
    const expected = referenceMiddleTruncate(line, width, theme);
    if (expected !== line) truncated++;
    assert.equal(middleTruncate(line, width, theme), expected, `run ${run}: width ${width} line ${JSON.stringify(line)}`);
  }
  assert.ok(truncated > 6_000, `the run must mostly exercise the cut, got ${truncated}`);
});

test("the tail cut costs the kept tail, not the whole line", (t) => {
  // A pure-ASCII line never reaches pi's segmenting width path, so every iterated grapheme
  // here is middleTruncate's own; the old forward scan walked all ~200k of them.
  const line = `${"x".repeat(200_000)} src/extensions/pi-traceline/index.ts:1-200`;
  const segment = Intl.Segmenter.prototype.segment;
  let iterated = 0;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, input: string) {
    const segments = segment.call(this, input);
    return {
      containing: (index?: number) => segments.containing(index),
      *[Symbol.iterator]() {
        for (const data of segments) {
          iterated++;
          yield data;
        }
      },
    };
  });
  const out = middleTruncate(line, 80);
  assert.equal(visibleWidth(out), 80);
  assert.ok(stripAnsi(out).endsWith("index.ts:1-200"));
  assert.ok(iterated < 200, `iterated ${iterated} graphemes for an 80-column result`);
});
