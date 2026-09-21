import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { syncWarmEntries, type WarmSyncState } from "../../extensions/pi-cachemire/warm.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const ANTHROPIC_PAYLOAD = {
  model: "claude-opus-4-8",
  system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "next" }] }],
};

test("a cache-warming payload hook without context cannot replace real-call evidence", async () => {
  const project = new IsolatedProject();
  const host = await hostExtension(piCachemire, { project });
  try {
    await host.session.extensionRunner.emitContext([]);
    await host.session.extensionRunner.emitBeforeProviderRequest(ANTHROPIC_PAYLOAD);
    const first = assistantMessage([], {
      provider: "anthropic", api: "anthropic-messages", model: "claude-opus-4-8",
      usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 100_000, totalTokens: 100_010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    await host.session.extensionRunner.emitMessageEnd({ type: "message_end", message: first });

    await host.session.extensionRunner.emitBeforeProviderRequest({
      ...ANTHROPIC_PAYLOAD,
      system: [{ type: "text", text: "warm replay must not become user-call evidence", cache_control: { type: "ephemeral" } }],
    });
    assert.equal(host.ui.notifications.length, 0, "background traffic must not post a break notice");

    await host.session.extensionRunner.emitContext([]);
    await host.session.extensionRunner.emitBeforeProviderRequest({
      ...ANTHROPIC_PAYLOAD,
      system: [{ type: "text", text: "a real changed request", cache_control: { type: "ephemeral" } }],
    });
    assert.equal(host.ui.notifications.length, 1, "the next context-armed request still diagnoses its own change");
    assert.match(host.ui.notifications[0]!, /cache breaking/);
  } finally {
    await host.dispose();
    project.dispose();
  }
});

test("warm usage observed after response persistence anchors to the assistant child", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const usage = {
    input: 100,
    output: 1,
    cacheRead: 49_900,
    cacheWrite: 0,
    totalTokens: 50_001,
    cost: { total: 0.01, input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0 },
  };
  manager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
  manager.appendUsage("cache_warm", "anthropic", "claude-opus-4-8", usage);
  const assistantId = manager.appendMessage(assistantMessage([], { usage }));
  const state: WarmSyncState = {
    records: [],
    lineages: [],
    seenWarmEntryIds: new Set(),
    window: { kind: "contract", ttlMs: 300_000, source: "observed" },
    modelSwitched: false,
    expectedRead: 50_000,
    compacted: false,
    inCompaction: false,
  };

  syncWarmEntries(state, { sessionManager: manager, model: undefined });
  assert.equal(state.lineages.at(-1)?.requestLeafId, assistantId);
});
