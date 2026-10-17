// Output contracts for ANSI-aware, column-aligned middle truncation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { middleTruncate } from "../../extensions/_lib/style.ts";

const PATHS = [
  "src/extensions/pi-traceline/index.ts:1-200",
  "漢字/表/e\u0301/👩‍💻/src/extensions/index.ts:1-200",
  "\x1b[38;5;245msrc/extensions/pi-traceline/index.ts:1-200\x1b[39m",
  "\x1b]8;;file:///tmp/index.ts\x1b\\src/extensions/pi-traceline/index.ts:1-200\x1b]8;;\x1b\\",
  "npm\tinstall src/extensions/pi-traceline/index.ts:1-200",
];

test("middle truncation keeps the path tail and fits every column budget", () => {
  for (const line of PATHS) {
    for (let width = 1; width <= 100; width++) {
      const out = middleTruncate(line, width);
      assert.ok(visibleWidth(out) <= width, `width ${width}: ${JSON.stringify(out)}`);
      if (visibleWidth(line) <= width) assert.equal(out, line);
      else if (width >= 30) {
        assert.equal(visibleWidth(out), width, "middle cuts fill their column budget");
        assert.ok(stripAnsi(out).endsWith("index.ts:1-200"), "the basename and range survive");
      }
    }
  }
});

test("middle truncation keeps cut columns aligned across wide and combining graphemes", () => {
  for (const grapheme of ["a", "漢", "e\u0301", "👩‍💻"]) {
    const line = grapheme.repeat(100);
    const out = stripAnsi(middleTruncate(line, 40));
    assert.equal(visibleWidth(out), 40);
    assert.equal(visibleWidth(out.slice(0, out.indexOf("…"))), 18);
    assert.equal(visibleWidth(out.slice(out.indexOf("…") + 1)), 21);
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(out)];
    assert.ok(graphemes.every(({ segment }) => [grapheme, "…", " "].includes(segment)), "cuts preserve complete graphemes");
  }
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
