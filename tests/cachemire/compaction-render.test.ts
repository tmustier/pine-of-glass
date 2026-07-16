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

test("resolved compaction notice reports the exact preserved and re-written split", () => {
  assert.equal(
    renderMissLine(COMPACTED),
    "cache after compaction \u00b7 preserved 34.9k of the prior 72.5k prefix \u00b7 re-wrote 38.7k (52% of prompt)",
  );
});

test("a post-compaction hit keeps the split instead of falling back to generic held wording", () => {
  const held: CallRecord = {
    ...COMPACTED,
    usage: { ...COMPACTED.usage, cacheRead: 68_000, cacheWrite: 4_100 },
    classification: { kind: "hit" },
    rewroteTokens: 4_100,
  };
  assert.equal(
    renderHeldLine(held),
    "cache after compaction \u00b7 preserved 68.0k of the prior 72.5k prefix \u00b7 re-wrote 4.1k (6% of prompt)",
  );
});

test("a model switch withholds the prior count because its tokenizer differs", () => {
  assert.equal(
    renderMissLine({ ...COMPACTED, postCompaction: { modelSwitched: true } }),
    "cache after compaction \u00b7 preserved 34.9k from the prior prefix \u00b7 re-wrote 38.7k (52% of prompt)",
  );
});
