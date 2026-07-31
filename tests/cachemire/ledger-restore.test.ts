// Ledger restore from persisted assistant messages: classification without invented
// request-time causes, and currency honesty across a restored model switch.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";

const { restoreFromMessages } = internals;

test("ledger restore from a continued session's assistant messages", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 0 },
    {
      role: "assistant", timestamp: 1_000,
      usage: { input: 12_000, output: 500, cacheRead: 0, cacheWrite: 130_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
    },
    { role: "toolResult", toolName: "bash", timestamp: 2_000 },
    {
      role: "assistant", timestamp: 30_000,
      usage: { input: 1_000, output: 800, cacheRead: 141_000, cacheWrite: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 } },
    },
    { role: "assistant", timestamp: 31_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, // empty usage → skipped
  ];
  const records = restoreFromMessages(messages as never);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.classification.kind, "cold");
  assert.equal(records[1]!.classification.kind, "hit");
  assert.equal(records[1]!.gapMs, 29_000);
  assert.ok(records.every((record) => record.restored));
});

test("ledger restore across a model switch classifies in the new model's own currency", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 };
  const messages = [
    {
      role: "assistant", timestamp: 1_000, provider: "openai-codex", model: "gpt-5.6-sol", api: "openai-codex-responses",
      usage: { input: 600, output: 500, cacheRead: 0, cacheWrite: 20_000, cost },
    },
    // fable reads its whole 28.2k prompt warm: a hit, though sol's 20.6k "expectation"
    // would misread it as 137%; the identity change in the data names the record.
    {
      role: "assistant", timestamp: 60_000, provider: "anthropic", model: "claude-fable-5", api: "anthropic-messages",
      usage: { input: 0, output: 400, cacheRead: 28_200, cacheWrite: 0, cost },
    },
    // and a switched cold re-write keeps its true cause instead of "restored (unknown)".
    {
      role: "assistant", timestamp: 120_000, provider: "openai-codex", model: "gpt-5.6-sol", api: "openai-codex-responses",
      usage: { input: 100, output: 400, cacheRead: 0, cacheWrite: 21_000, cost },
    },
  ];
  const records = restoreFromMessages(messages as never);
  assert.equal(records[1]!.classification.kind, "hit");
  assert.equal(records[1]!.switched, true);
  assert.equal(records[2]!.classification.kind, "miss");
  assert.equal(records[2]!.classification.cause?.detail, "model switched claude-fable-5 \u2192 gpt-5.6-sol");
});
