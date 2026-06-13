// _lib/style.ts — the family style implementation (docs/design-language.md §§1–6).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { GLYPH, SCALE, SEP, ink, panelHeader, panelPips, sizeTone, SIZE_THRESHOLDS } from "../../extensions/_lib/style.ts";

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

test("panel header: bold accent brand, mode pips, one dim hint line (design language §5)", () => {
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
