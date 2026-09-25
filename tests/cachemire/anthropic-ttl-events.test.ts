import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const model: Model<"anthropic-messages"> = {
  id: "claude-opus-4-8", name: "Claude Opus", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  contextWindow: 200_000, maxTokens: 8_000,
};

function billed(cacheRead: number, cacheWrite: number): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "answer" }],
    provider: model.provider, model: model.id, api: model.api, stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 200, cacheRead, cacheWrite, output: 10, totalTokens: 210 + cacheRead + cacheWrite,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    },
  };
}

function payload(turns: string[]) {
  return {
    model: model.id,
    system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
    messages: turns.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
  };
}

test("a 5-minute Anthropic entry stays warm until 10s past its TTL, timed from the response start", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const project = new IsolatedProject();
  const host = await hostExtension(piCachemire, { project, model });
  const runner = host.session.extensionRunner;
  const breaking = () => host.ui.notifications.filter((text) => text.includes("cache breaking"));
  const turns: string[] = [];
  // Send, spend 20s in prefill, stream for 5s, then finish.
  const call = async (message: AssistantMessage) => {
    turns.push(`turn ${turns.length + 1}`);
    await runner.emitContext([]);
    await runner.emitBeforeProviderRequest(payload(turns));
    mock.timers.tick(20_000);
    await runner.emit({ type: "after_provider_response", status: 200, headers: {} });
    mock.timers.tick(5_000);
    await runner.emitMessageEnd({ type: "message_end", message: message });
  };
  try {
    await call(billed(0, 100_000));
    // 5m09s after the response started, 5m29s after the send: still warm.
    mock.timers.tick(5 * 60_000 + 9_000 - 5_000);
    await call(billed(100_000, 300));
    assert.deepEqual(breaking(), []);

    // The clock counts down from that response start too.
    const clock = () => host.ui.widgetLines("pi-cachemire")?.join("\n") ?? "";
    mock.timers.tick(5 * 60_000);
    assert.match(clock(), /cache expires in 5s/);
    mock.timers.tick(6_000);
    assert.match(clock(), /cache stale · TTL expired/);

    // 5m11s after the previous response started: the send re-writes the prefix.
    await runner.emitContext([]);
    await runner.emitBeforeProviderRequest(payload([...turns, "late"]));
    assert.equal(breaking().length, 1);
    assert.match(breaking()[0]!, /cause: 5m TTL reached after 5m11s idle$/);
  } finally {
    mock.timers.reset();
    await host.dispose();
    project.dispose();
  }
});
