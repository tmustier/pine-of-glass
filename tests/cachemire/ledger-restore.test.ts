import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

import { classifyCall } from "../../extensions/pi-cachemire/classify.ts";
import { restoreBranchRecords } from "../../extensions/pi-cachemire/ledger.ts";
import { restoreLineageSnapshots } from "../../extensions/pi-cachemire/lineage-persistence.ts";
import { renderLedger } from "../../extensions/pi-cachemire/render.ts";
import { assistantMessage } from "../helpers.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function restore(manager: SessionManager) {
  return restoreBranchRecords(manager.getBranch(), classifyCall);
}

test("resume uses the session-entry time when a legacy message has no embedded timestamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "cachemire-legacy-time-"));
  const path = join(dir, "session.jsonl");
  const at = "2026-07-01T10:00:05.000Z";
  const entries = [
    { type: "session", version: 3, id: "legacy-time", timestamp: "2026-07-01T10:00:00.000Z", cwd: dir },
    {
      type: "message", id: "assistant", parentId: null, timestamp: at,
      message: {
        role: "assistant", content: [{ type: "text", text: "answer" }],
        provider: "anthropic", api: "anthropic-messages", model: "claude-opus-4-8", stopReason: "stop",
        usage: {
          input: 0, output: 10, cacheRead: 0, cacheWrite: 50_000, totalTokens: 50_010,
          cost: zeroCost,
        },
      },
    },
  ];
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  try {
    const manager = SessionManager.open(path);
    assert.equal(restore(manager)[0]!.at, Date.parse(at));
    assert.equal(restoreLineageSnapshots(manager.getEntries())[0]!.responseAt, Date.parse(at));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger restore from a continued session's assistant messages", () => {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "first", timestamp: 500 });
  manager.appendMessage(assistantMessage([], {
    timestamp: 1_000,
    usage: {
      input: 12_000, output: 500, cacheRead: 0, cacheWrite: 130_000, totalTokens: 142_500,
      cost: { ...zeroCost, total: 0.5 },
    },
  }));
  manager.appendMessage({ role: "user", content: "second", timestamp: 2_000 });
  manager.appendMessage(assistantMessage([], {
    timestamp: 30_000,
    usage: {
      input: 1_000, output: 800, cacheRead: 141_000, cacheWrite: 1_500, totalTokens: 144_300,
      cost: { ...zeroCost, total: 0.04 },
    },
  }));
  manager.appendMessage({ role: "user", content: "third", timestamp: 30_500 });
  manager.appendMessage(assistantMessage([], {
    timestamp: 31_000,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost },
  }));

  const records = restore(manager);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.classification.kind, "cold");
  assert.equal(records[1]!.classification.kind, "hit");
  assert.equal(records[1]!.gapMs, 29_000);
  assert.ok(records.every((record) => record.restored));
});

test("ledger restore across a model switch classifies in the new model's own currency", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const cost = { ...zeroCost, total: 0.1 };
  const append = (timestamp: number, provider: string, model: string, api: string, usage: Usage) => {
    manager.appendMessage({ role: "user", content: "next", timestamp: timestamp - 1 });
    manager.appendMessage(assistantMessage([], { timestamp, provider, model, api, usage }));
  };
  append(1_000, "openai-codex", "gpt-5.6-sol", "openai-codex-responses", {
    input: 600, output: 500, cacheRead: 0, cacheWrite: 20_000, totalTokens: 21_100, cost,
  });
  append(60_000, "anthropic", "claude-fable-5", "anthropic-messages", {
    input: 0, output: 400, cacheRead: 28_200, cacheWrite: 0, totalTokens: 28_600, cost,
  });
  append(120_000, "openai-codex", "gpt-5.6-sol", "openai-codex-responses", {
    input: 100, output: 400, cacheRead: 0, cacheWrite: 21_000, totalTokens: 21_500, cost,
  });

  const records = restore(manager);
  assert.equal(records[1]!.classification.kind, "hit");
  assert.equal(records[1]!.switched, true);
  assert.equal(records[2]!.classification.kind, "miss");
  assert.equal(records[2]!.classification.cause?.detail, "model switched claude-fable-5 \u2192 gpt-5.6-sol");
});

test("ledger restore includes persisted cache warming usage", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const cost = { ...zeroCost, total: 0.02 };
  manager.appendMessage({ role: "user", content: "hello", timestamp: 500 });
  manager.appendMessage(assistantMessage([], {
    timestamp: 1_000,
    usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 100_000, totalTokens: 100_020, cost },
  }));
  manager.appendUsage("cache_warm", "anthropic", "claude-opus-4-8", {
    input: 100, output: 1, cacheRead: 99_900, cacheWrite: 0, totalTokens: 100_001, cost,
  });

  const records = restore(manager);
  assert.equal(records.length, 2);
  assert.equal(records[1]!.warm, true);
  assert.equal(records[1]!.classification.kind, "hit");
  const ledger = renderLedger(records).join("\n");
  assert.match(ledger, /warm · hit/);
  assert.match(ledger, /totals: 2 calls/);
});

test("ledger restore preserves a compaction boundary on the next billed call", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const cost = { ...zeroCost, total: 0.1 };
  manager.appendMessage({ role: "user", content: "before", timestamp: 500 });
  const before = manager.appendMessage(assistantMessage([], {
    timestamp: 1_000,
    usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 100_000, totalTokens: 100_020, cost },
  }));
  manager.appendCompaction("summary", before, 100_000);
  manager.appendMessage({ role: "user", content: "after", timestamp: 2_500 });
  manager.appendMessage(assistantMessage([], {
    timestamp: 3_000,
    usage: { input: 10_000, output: 20, cacheRead: 20_000, cacheWrite: 70_000, totalTokens: 100_020, cost },
  }));

  const records = restore(manager);
  assert.equal(records[1]!.classification.cause?.kind, "compaction");
  assert.deepEqual(records[1]!.postCompaction, { modelSwitched: false });
  assert.match(renderLedger(records).join("\n"), /compaction rewrote history/);
});
