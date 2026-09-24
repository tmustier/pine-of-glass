import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const model: Model<"anthropic-messages"> = {
  id: "claude-opus-4-8", name: "Claude Opus", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  contextWindow: 200_000, maxTokens: 8_000,
};

function billed(input: number, cacheRead: number, cacheWrite: number): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "answer" }],
    provider: model.provider, model: model.id, api: model.api, stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input, cacheRead, cacheWrite, output: 10, totalTokens: input + cacheRead + cacheWrite + 10,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    },
  };
}

function payload(system: string, messages: string[]) {
  return {
    model: model.id,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: messages.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
  };
}

test("a displayed break warning is a non-context session marker before its billed result", async () => {
  const project = new IsolatedProject();
  const manager = SessionManager.inMemory(project.dir);
  const host = await hostExtension(piCachemire, { project, model, sessionManager: manager });
  const runner = host.session.extensionRunner;
  const entries = () => manager.getEntries();
  try {
    const send = async (system: string, messages: string[], result: AssistantMessage) => {
      manager.appendMessage({ role: "user", content: messages.at(-1)!, timestamp: Date.now() });
      await runner.emitContext([]);
      await runner.emitBeforeProviderRequest(payload(system, messages));
      await runner.emitMessageEnd({ type: "message_end", message: result });
      manager.appendMessage(result);
    };
    await send("initial", ["first"], billed(0, 0, 100_000));
    assert.equal(entries().filter((entry) => entry.type === "custom" && entry.customType === "cachemire-warning").length, 0);

    await send("changed", ["first", "second"], billed(200, 100_000, 300));
    const warning = entries().find((entry) => entry.type === "custom" && entry.customType === "cachemire-warning");
    assert.ok(warning && warning.type === "custom");
    assert.deepEqual(warning.data, { cause: "system" });
    const result = entries().find((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.parentId === warning.id);
    assert.ok(result, "the next billed response is a child of the warning marker");
    assert.equal(result.type === "message" && result.message.role === "assistant" && result.message.usage.cacheRead, 100_000);

    await send("changed", ["first", "second", "third"], billed(200, 100_500, 300));
    assert.equal(entries().filter((entry) => entry.type === "custom" && entry.customType === "cachemire-warning").length, 1);

    manager.appendMessage({ role: "user", content: "fourth", timestamp: Date.now() });
    await runner.emitContext([]);
    await runner.emitBeforeProviderRequest(payload("changed again", ["first", "second", "third", "fourth"]));
    await runner.emit({ type: "agent_end", messages: [] });
    const tail = entries().slice(-2);
    assert.equal(tail[0]?.type, "custom");
    assert.equal(tail[0]?.type === "custom" && tail[0].customType, "cachemire-warning");
    assert.equal(tail[1]?.type === "custom" && tail[1].customType, "cachemire-warning-aborted");
  } finally {
    await host.dispose();
    project.dispose();
  }
});
