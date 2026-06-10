// ANSI-aware middle truncation: the tail (basename + :range / operative command end) must
// survive, visible width must never exceed budget, and escape sequences must never tear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { internals } from "../../extensions/pi-traceline/index.ts";

const { middleTruncate, rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } = internals;

const ELLIPSIS = "\u2026";

const plainLong = "read ~/projects/pine-of-glass/extensions/pi-traceline/index.ts:1-200";
const ansiLong = `\x1b[1mread\x1b[22m \x1b[38;5;245m~/projects/pine-of-glass/extensions/\x1b[0mpi-traceline/index.ts\x1b[2m:1-200\x1b[0m`;
const command = "$ cd ~/projects/pine-of-glass && rm -f docs/img/pi-traceline-native.png";

test("short input is returned unchanged", () => {
  assert.equal(middleTruncate(plainLong, 200), plainLong);
  assert.equal(middleTruncate(ansiLong, 200), ansiLong);
});

test("truncation preserves head prefix and tail suffix around one ellipsis", () => {
  for (const input of [plainLong, ansiLong, command]) {
    for (const width of [20, 30, 40, 55]) {
      const out = middleTruncate(input, width);
      assert.ok(visibleWidth(out) <= width, `visible width ${visibleWidth(out)} > ${width} for ${JSON.stringify(input)}`);
      const visible = stripAnsi(out);
      const original = stripAnsi(input);
      const cut = visible.indexOf(ELLIPSIS);
      assert.ok(cut >= 0, "must contain ellipsis");
      const head = visible.slice(0, cut);
      const tail = visible.slice(cut + ELLIPSIS.length);
      assert.ok(original.startsWith(head), `head ${JSON.stringify(head)} must prefix the original`);
      assert.ok(original.endsWith(tail), `tail ${JSON.stringify(tail)} must suffix the original`);
    }
  }
});

test("the discriminating tail survives: basename and :range, or the command end", () => {
  assert.ok(stripAnsi(middleTruncate(plainLong, 36)).endsWith("index.ts:1-200"));
  assert.ok(stripAnsi(middleTruncate(ansiLong, 36)).endsWith("index.ts:1-200"));
  assert.ok(stripAnsi(middleTruncate(command, 40)).endsWith("traceline-native.png"));
  assert.ok(stripAnsi(middleTruncate(command, 48)).endsWith("/pi-traceline-native.png"));
});

test("tiny widths fall back without exceeding budget", () => {
  for (const width of [1, 4, 8]) {
    assert.ok(visibleWidth(middleTruncate(plainLong, width)) <= width);
  }
});

test("no torn ANSI sequences after truncation", () => {
  for (const width of [18, 26, 34, 48]) {
    const out = middleTruncate(ansiLong, width);
    // Every ESC in the output must begin a complete, parseable sequence: stripping all
    // well-formed sequences must leave no ESC bytes behind.
    assert.ok(!stripAnsi(out).includes("\x1b"), `torn escape at width ${width}: ${JSON.stringify(out)}`);
  }
});

test("raw/visible index mapping across SGR and OSC-8 sequences", () => {
  const line = "\x1b[31mab\x1b[0mcd";
  assert.equal(rawIndexAtVisibleIndex(line, 0), 5); // first visible char after ESC[31m
  assert.equal(rawIndexAtVisibleIndex(line, 2), 11); // 'c' after ESC[0m
  assert.equal(rawIndexAtVisibleIndex(line, 4), line.length); // past the end
  assert.equal(rawIndexBeforeVisibleIndex(line, 0), 0); // before the leading escape
  assert.equal(rawIndexBeforeVisibleIndex(line, 2), 7); // before ESC[0m, after 'ab'

  const osc = "\x1b]8;;http://example.com\x07link\x1b]8;;\x07!";
  assert.equal(stripAnsi(osc), "link!");
  assert.equal(osc.slice(rawIndexAtVisibleIndex(osc, 4)), "!");
});
