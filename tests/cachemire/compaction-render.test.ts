import { test } from "node:test";
import assert from "node:assert/strict";

import { internals, type CallRecord } from "../../extensions/pi-cachemire/index.ts";

const { renderHeldLine, renderMissLine } = internals;

const COMPACTED: CallRecord = {
  index: 5,
  at: 600_000,
  gapMs: 60_000,
  usage: { input: 400, output: 1_000, cacheRead: 34_900, cacheWrite: 38_700 },
  expectedRead: 72_500,
  classification: { kind: "partial", cause: { kind: "compaction", detail: "compaction rewrote history" } },
  rewroteTokens: 38_700,
  postCompaction: { modelSwitched: false },
};

test("resolved compaction notice reports reuse against the last pre-compaction prompt", () => {
  assert.equal(
    renderMissLine(COMPACTED),
    "cache after compaction \u00b7 reused 34.9k of the last pre-compaction 72.5k prompt (48%) \u00b7 processed 39.1k uncached",
  );
});

test("the reported session uses the pre-compaction denominator", () => {
  const observed: CallRecord = {
    ...COMPACTED,
    usage: { input: 21_163, output: 299, cacheRead: 17_920, cacheWrite: 0 },
    expectedRead: 173_864,
    rewroteTokens: 21_163,
  };
  assert.equal(
    renderMissLine(observed),
    "cache after compaction \u00b7 reused 17.9k of the last pre-compaction 173.9k prompt (10%) \u00b7 processed 21.2k uncached",
  );
});

test("a post-compaction hit keeps the reuse comparison instead of generic held wording", () => {
  const held: CallRecord = {
    ...COMPACTED,
    usage: { ...COMPACTED.usage, cacheRead: 68_000, cacheWrite: 4_100 },
    classification: { kind: "hit" },
    rewroteTokens: 4_100,
  };
  assert.equal(
    renderHeldLine(held),
    "cache after compaction \u00b7 reused 68.0k of the last pre-compaction 72.5k prompt (94%) \u00b7 processed 4.5k uncached",
  );
});

test("a model switch withholds the prior count and share because its tokenizer differs", () => {
  assert.equal(
    renderMissLine({ ...COMPACTED, postCompaction: { modelSwitched: true } }),
    "cache after compaction \u00b7 reused 34.9k from the last pre-compaction prompt \u00b7 processed 39.1k uncached",
  );
});
