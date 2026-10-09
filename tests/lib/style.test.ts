// _lib/style.ts — the family style implementation (docs/design-language.md §§1–6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { middleTruncate, panelHeader, panelPips, sizeTone } from "../../extensions/_lib/style.ts";

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
  const preview = `The TTL docs issue - the CLI help says 30 days but the docs say 7. Let me just compile my findings now. The key items: Confirmed fixed in 0.1.7: 1. \u2705 API`;
  const out = middleTruncate(` ${preview}`, 158);
  assert.ok(visibleWidth(out) <= 158, `overflowed: ${visibleWidth(out)} > 158`);
});

test("sizeTone: dim below warning, warning at 10k ch, error at 50k ch", () => {
  assert.equal(sizeTone(0), "dim");
  assert.equal(sizeTone(9_999), "dim");
  assert.equal(sizeTone(10_000), "warning");
  assert.equal(sizeTone(49_999), "warning");
  assert.equal(sizeTone(50_000), "error");
});

test("sizeTone honours overridden thresholds", () => {
  assert.equal(sizeTone(500, { warning: 100, error: 1_000 }), "warning");
  assert.equal(sizeTone(2_000, { warning: 100, error: 1_000 }), "error");
});

test("panel header without pips or hint, and without a theme", () => {
  assert.deepEqual(panelHeader(undefined, "Cachemire"), ["", "[Cachemire]"]);
  assert.equal(panelPips(undefined, ["a", "b"], "a"), "a\x1b[90m → \x1b[0m\x1b[90mb\x1b[0m");
});
