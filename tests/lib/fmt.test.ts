// _lib/fmt.ts — the family number grammar (docs/design-language.md §4).
import { test } from "node:test";
import assert from "node:assert/strict";

import { compactCount, formatChars, formatTokens, formatUsd, formatDuration } from "../../extensions/_lib/fmt.ts";

test("counts: one unit everywhere — fixed k below 1M, M above", () => {
  assert.equal(compactCount(0), "0.0k");
  assert.equal(compactCount(133), "0.1k");
  assert.equal(compactCount(412), "0.4k");
  assert.equal(compactCount(999), "1.0k");
  assert.equal(compactCount(1_234), "1.2k");
  assert.equal(compactCount(52_300), "52.3k");
  assert.equal(compactCount(999_949), "999.9k");
  assert.equal(compactCount(999_950), "1.0M");
  assert.equal(compactCount(9_100_000), "9.1M");
  assert.equal(compactCount(Number.NaN), "?");
});

test("chars carry the ch unit", () => {
  assert.equal(formatChars(133), "0.1k ch");
  assert.equal(formatChars(35_200), "35.2k ch");
});

test("tokens: ~ marks estimates; exact provider-reported counts drop it", () => {
  assert.equal(formatTokens(14_200), "~14.2k tokens");
  assert.equal(formatTokens(64_100, { exact: true }), "64.1k tokens");
  assert.equal(formatTokens(78), "~0.1k tokens");
});

test("money: two decimals, three below $0.10", () => {
  assert.equal(formatUsd(17.03), "$17.03");
  assert.equal(formatUsd(0.523), "$0.52");
  assert.equal(formatUsd(0.0523), "$0.052");
  assert.equal(formatUsd(0.1), "$0.10");
});

test("durations: compact mixed units, no spaces", () => {
  assert.equal(formatDuration(14_000), "14s");
  assert.equal(formatDuration(270_000), "4m30s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(35_400_000), "9h50m");
});
