// _lib/style.ts — the family style implementation (docs/design-language.md §§1–6).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { visibleWidth } from "@earendil-works/pi-tui";
import { GLYPH, SCALE, SEP, ink, middleTruncate, panelHeader, panelPips, sizeTone, SIZE_THRESHOLDS } from "../../extensions/_lib/style.ts";

// A recording theme: proves ink() routes through Theme.fg with the right role.
const recordingTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
  bg: (_color: string, text: string) => text,
} as unknown as Theme;

test("family glyphs and separator are the documented characters", () => {
  assert.equal(GLYPH.tool, "›");
  assert.equal(GLYPH.econ, "◍");
  assert.equal(GLYPH.section, "▸");
  assert.equal(GLYPH.rail, "▏");
  assert.deepEqual([SCALE.cold, SCALE.hit, SCALE.partial, SCALE.miss], ["○", "●", "◑", "◌"]);
  assert.equal(SEP, " · ");
});

test("ink derives from the theme for every role-mapped tone", () => {
  assert.equal(ink(recordingTheme, "text", "x"), "<text>x</text>");
  assert.equal(ink(recordingTheme, "muted", "x"), "<muted>x</muted>");
  assert.equal(ink(recordingTheme, "dim", "x"), "<dim>x</dim>");
  assert.equal(ink(recordingTheme, "success", "x"), "<success>x</success>");
  assert.equal(ink(recordingTheme, "warning", "x"), "<warning>x</warning>");
  assert.equal(ink(recordingTheme, "error", "x"), "<error>x</error>");
  assert.equal(ink(recordingTheme, "accent", "x"), "<accent>x</accent>");
});

test("running has no faithful theme role: raw ANSI blue even with a theme", () => {
  assert.equal(ink(recordingTheme, "running", "x"), "\x1b[34mx\x1b[0m");
  assert.equal(ink(undefined, "running", "x"), "\x1b[34mx\x1b[0m");
});

test("without a theme, ink falls back to basic ANSI; text/accent stay plain", () => {
  assert.equal(ink(undefined, "dim", "x"), "\x1b[90mx\x1b[0m");
  assert.equal(ink(undefined, "muted", "x"), "\x1b[90mx\x1b[0m");
  assert.equal(ink(undefined, "success", "x"), "\x1b[32mx\x1b[0m");
  assert.equal(ink(undefined, "warning", "x"), "\x1b[33mx\x1b[0m");
  assert.equal(ink(undefined, "error", "x"), "\x1b[31mx\x1b[0m");
  assert.equal(ink(undefined, "text", "x"), "x");
  assert.equal(ink(undefined, "accent", "x"), "x");
});

test("ink never styles empty text and never lets a broken theme break a render", () => {
  assert.equal(ink(recordingTheme, "dim", ""), "");
  const broken = { fg: () => { throw new Error("boom"); } } as unknown as Theme;
  assert.equal(ink(broken, "error", "x"), "\x1b[31mx\x1b[0m");
});

test("middleTruncate replays active ink across the cut (design language §5)", () => {
  // The dim span opens before the cut and closes after it: the tail's opening SGR
  // lives in the removed middle and must be replayed after the ellipsis.
  const line = `head \x1b[38;5;245m${"a".repeat(120)}\x1b[39m`;
  const out = middleTruncate(line, 40);
  const cut = out.indexOf("…");
  assert.ok(cut >= 0, out);
  assert.ok(out.slice(cut).includes("\x1b[38;5;245m"), `tail ink must be replayed: ${JSON.stringify(out)}`);
  // A full reset before the cut clears the replay: nothing stale leaks into the tail.
  const reset = middleTruncate(`\x1b[1mB\x1b[0m${"b".repeat(120)}`, 40);
  const resetCut = reset.indexOf("…");
  assert.ok(!reset.slice(resetCut).includes("\x1b[1m"), `no stale bold after a reset: ${JSON.stringify(reset)}`);
});

test("middleTruncate never overflows the budget when wide graphemes sit at a cut", () => {
  // Crash regression: the budget is terminal columns, but the cut used to count raw
  // characters. A 2-column grapheme inside the tail made the "fitted" line one column
  // wider than the terminal, and pi's render guard killed the session.
  // Use BMP wide characters (\u2705, CJK): 1 UTF-16 code unit but 2 columns. Astral
  // emoji are 2 code units for 2 columns, so they cannot expose a char/column mix-up.
  const wide = "\u2705";
  const head = "h".repeat(80);
  const tail = `${"t".repeat(40)} ${wide} tail-end`;
  const out = middleTruncate(`\x1b[38;5;245m${head} middle ${tail}\x1b[39m`, 100);
  assert.ok(visibleWidth(out) <= 100, `overflowed: ${visibleWidth(out)} > 100`);
  assert.ok(out.includes("tail-end"), `tail lost its end: ${JSON.stringify(out)}`);
  assert.ok(out.includes("\u2026"), "ellipsis preserved");

  // Wide grapheme straddling the head cut: dropped from the head, never half-kept.
  const headWide = middleTruncate(`${"a".repeat(30)}\u4E2D${"b".repeat(120)}`, 60);
  assert.ok(visibleWidth(headWide) <= 60, `head overflowed: ${visibleWidth(headWide)} > 60`);
});

test("middleTruncate fits the exact crashing thinking preview (159 cols in a 158 terminal)", () => {
  // The pi-traceline Thinking preview that crashed: 158 chars but 159 columns because
  // the tail carried an emoji.
  const preview = `Thinking: The TTL docs issue - the CLI help says 30 days but the docs say 7. Let me just compile my findings now. The key items: Confirmed fixed in 0.1.7: 1. \u2705 API`;
  const out = middleTruncate(` ${preview}`, 158);
  assert.ok(visibleWidth(out) <= 158, `overflowed: ${visibleWidth(out)} > 158`);
});

test("sizeTone: dim below warning, warning at 10k ch, error at 50k ch", () => {
  assert.equal(sizeTone(0), "dim");
  assert.equal(sizeTone(9_999), "dim");
  assert.equal(sizeTone(10_000), "warning");
  assert.equal(sizeTone(49_999), "warning");
  assert.equal(sizeTone(50_000), "error");
  assert.deepEqual(SIZE_THRESHOLDS, { warning: 10_000, error: 50_000 });
});

test("sizeTone honours overridden thresholds", () => {
  assert.equal(sizeTone(500, { warning: 100, error: 1_000 }), "warning");
  assert.equal(sizeTone(2_000, { warning: 100, error: 1_000 }), "error");
});

test("panel header: bold accent brand, mode pips, one dim hint line (design language §8)", () => {
  const lines = panelHeader(recordingTheme, "Contextimate", {
    modes: ["summary", "compact", "expanded"],
    active: "compact",
    hint: "ctrl+o: cycle view",
  });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "", "one blank line before the panel (group spacing)");
  assert.ok(lines[1]!.startsWith("<accent><b>[Contextimate]</b></accent> "), lines[1]);
  assert.ok(lines[1]!.includes("<accent><b>compact</b></accent>"), "active pip is accent-bold");
  assert.ok(lines[1]!.includes("<dim>summary</dim>") && lines[1]!.includes("<dim>expanded</dim>"), "inactive pips dim");
  assert.ok(lines[1]!.includes("<dim> → </dim>"), "pip separator dim");
  assert.equal(lines[2], "  <dim>ctrl+o: cycle view</dim>");
});

test("panel header without pips or hint, and without a theme", () => {
  assert.deepEqual(panelHeader(undefined, "Cachemire"), ["", "[Cachemire]"]);
  assert.equal(panelPips(undefined, ["a", "b"], "a"), "a\x1b[90m → \x1b[0m\x1b[90mb\x1b[0m");
});
