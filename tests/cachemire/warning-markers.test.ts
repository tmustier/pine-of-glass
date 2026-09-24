import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { restoreLineageSnapshots } from "../../extensions/pi-cachemire/lineage-persistence.ts";
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

function payload(system: string, messages: string[]) {
  return {
    model: model.id,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: messages.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
  };
}

test("only DEBUG=1 records a break warning, even when cache warming precedes its response", async () => {
  const previousDebug = process.env.DEBUG;
  try {
    for (const debug of ["1", undefined]) {
      if (debug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = debug;
      const project = new IsolatedProject();
      const manager = SessionManager.inMemory(project.dir);
      const host = await hostExtension(piCachemire, { project, model, sessionManager: manager });
      const runner = host.session.extensionRunner;
      try {
        manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
        await runner.emitContext([]);
        await runner.emitBeforeProviderRequest(payload("initial", ["first"]));
        const first = billed(0, 100_000);
        await runner.emitMessageEnd({ type: "message_end", message: first });
        manager.appendMessage(first);

        manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
        await runner.emitContext([]);
        await runner.emitBeforeProviderRequest(payload("changed", ["first", "second"]));
        assert.match(host.ui.notifications.at(-1)!, /cache breaking.*system prompt changed/);
        const warnings = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "cachemire-warning");
        assert.equal(warnings.length, debug === "1" ? 1 : 0);
        const warm = manager.appendUsage("cache_warm", model.provider, model.id, billed(99_900, 0).usage);
        const second = billed(100_000, 300);
        await runner.emitMessageEnd({ type: "message_end", message: second });
        const resultId = manager.appendMessage(second);
        const result = manager.getEntry(resultId);
        assert.equal(result?.parentId, warm.id);
        if (debug === "1") {
          const warning = warnings[0];
          assert.ok(warning && warning.type === "custom");
          assert.deepEqual(warning.data, { cause: "system" });
          assert.equal(warm.parentId, warning.id);
          assert.equal(restoreLineageSnapshots(manager.getEntries()).find((call) => call.responseEntryId === resultId)?.requestLeafId, warning.id);
        }
        assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role),
          ["user", "assistant", "user", "assistant"]);

        await host.session.prompt("/cache");
        manager.appendMessage({ role: "user", content: "third", timestamp: Date.now() });
        await runner.emitContext([]);
        await runner.emitBeforeProviderRequest(payload("changed again", ["first", "second", "third"]));
        assert.match(host.ui.notifications.at(-1)!, /cache breaking.*system prompt changed/);
        assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "cachemire-warning").length,
          debug === "1" ? 2 : 0);
      } finally {
        await host.dispose();
        project.dispose();
      }
    }
  } finally {
    if (previousDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previousDebug;
  }
});
