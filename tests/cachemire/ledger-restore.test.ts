// Ledger restore from persisted assistant messages: classification without invented
// request-time causes, and currency honesty across a restored model switch.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";

const { restoreFromMessages } = internals;

function persistedEntries<T extends { timestamp: number }>(messages: readonly T[]) {
  return messages.map((message, index) => ({
    type: "message" as const,
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  }));
}

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
  const records = restoreFromMessages(persistedEntries(messages) as never);
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
  const records = restoreFromMessages(persistedEntries(messages) as never);
  assert.equal(records[1]!.classification.kind, "hit");
  assert.equal(records[1]!.switched, true);
  assert.equal(records[2]!.classification.kind, "miss");
  assert.equal(records[2]!.classification.cause?.detail, "model switched claude-fable-5 \u2192 gpt-5.6-sol");
});

test("ledger restore includes persisted cache warming usage as a labelled billed call", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 };
  const entries = [
    {
      type: "message", id: "assistant-1", parentId: null, timestamp: new Date(1_000).toISOString(),
      message: {
        role: "assistant", timestamp: 1_000, provider: "anthropic", model: "claude-opus-4-8", api: "anthropic-messages",
        usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 100_000, cost },
      },
    },
    {
      type: "usage", id: "warm-1", parentId: "assistant-1", timestamp: new Date(240_000).toISOString(),
      kind: "cache_warm", provider: "anthropic", model: "claude-opus-4-8",
      usage: { input: 100, output: 1, cacheRead: 99_900, cacheWrite: 0, cost },
    },
  ];
  const records = restoreFromMessages(entries as never);
  assert.equal(records.length, 2);
  assert.equal(records[1]!.warm, true);
  assert.equal(records[1]!.classification.kind, "hit");
  assert.match(internals.renderLedger(records).join("\n"), /warm · hit/);
  assert.match(internals.renderLedger(records).join("\n"), /totals: 2 calls/);
});

test("ledger restore preserves a compaction boundary on the next billed call", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 };
  const entries = [
    {
      type: "message", id: "before", parentId: null, timestamp: new Date(1_000).toISOString(),
      message: {
        role: "assistant", timestamp: 1_000, provider: "anthropic", model: "claude-opus-4-8", api: "anthropic-messages",
        usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 100_000, cost },
      },
    },
    {
      type: "compaction", id: "compact", parentId: "before", timestamp: new Date(2_000).toISOString(),
      summary: "summary", firstKeptEntryId: "before", tokensBefore: 100_000,
    },
    {
      type: "message", id: "after", parentId: "compact", timestamp: new Date(3_000).toISOString(),
      message: {
        role: "assistant", timestamp: 3_000, provider: "anthropic", model: "claude-opus-4-8", api: "anthropic-messages",
        usage: { input: 10_000, output: 20, cacheRead: 20_000, cacheWrite: 70_000, cost },
      },
    },
  ];
  const records = restoreFromMessages(entries as never);
  assert.equal(records[1]!.classification.cause?.kind, "compaction");
  assert.deepEqual(records[1]!.postCompaction, { modelSwitched: false });
  assert.match(internals.renderLedger(records).join("\n"), /compaction rewrote history/);
});
