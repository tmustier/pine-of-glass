import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const model: Model<"anthropic-messages"> = {
  id: "claude-opus-4-8", name: "Claude Opus", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  contextWindow: 200_000, maxTokens: 8_000,
};

function both(pi: ExtensionAPI): void {
  piCachemire(pi);
  piMeantime(pi);
}

test("two live clocks keep their widget positions across ticks and idle phases", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true });
  const host = await hostExtension(both, { project, model, reason: "new" });
  const runner = host.session.extensionRunner;
  const order = () => [...host.ui.widgets.keys()].filter((key) => key === "pi-cachemire" || key === "pi-meantime");
  const calls = () => host.ui.widgetCalls.filter((key) => key === "pi-cachemire" || key === "pi-meantime");
  const initial = order();
  try {
    assert.deepEqual(initial, ["pi-cachemire", "pi-meantime"]);
    assert.deepEqual(host.ui.widgetLines("pi-meantime"), [], "mounted but silent when idle");
    await runner.emit({ type: "agent_start" });
    await runner.emitContext([]);
    await runner.emitBeforeProviderRequest({
      model: model.id,
      system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: "answer" }],
      provider: model.provider, model: model.id, api: model.api, stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 200, cacheRead: 0, cacheWrite: 100_000, output: 10, totalTokens: 100_210,
        cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
      },
    };
    await runner.emitMessageEnd({ type: "message_end", message });
    await runner.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
    mock.timers.tick(4 * 60_000 + 57_000);
    assert.match(host.ui.widgetLines("pi-cachemire")?.join("\n") ?? "", /cache expires/);
    assert.match(host.ui.widgetLines("pi-meantime")?.join("\n") ?? "", /tools/);
    assert.deepEqual(order(), initial, "neither timer may move its neighbour");
    assert.deepEqual(calls(), initial,
      "both clocks mount once; ticks must not call setWidget again");
    await runner.emit({ type: "agent_end", messages: [] });
    assert.deepEqual(host.ui.widgetLines("pi-meantime"), [], "idle has no tempo line");
    assert.deepEqual(order(), initial, "hiding does not remove the widget slot");
    assert.deepEqual(calls(), initial);
  } finally {
    mock.timers.reset();
    await host.dispose();
    project.dispose();
  }
});
