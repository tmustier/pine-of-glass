// Pi's compaction summary request does not pass through the extension provider hooks. Cachemire
// relies on this: it reads compaction from the session path and has no summarizer-call state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

test("a compaction summary reaches the provider without context or payload hooks", async () => {
  const project = new IsolatedProject();
  project.writeProjectConfig("settings", { compaction: { enabled: false, keepRecentTokens: 1 } });
  const hooks: string[] = [];
  const providerCalls: string[] = [];
  const fixture: ExtensionFactory = (pi) => {
    pi.on("context", () => { hooks.push("context"); });
    pi.on("before_provider_request", () => { hooks.push("before_provider_request"); });
    pi.on("after_provider_response", () => { hooks.push("after_provider_response"); });
    pi.on("message_end", () => { hooks.push("message_end"); });
    pi.registerProvider("compaction-fixture", {
      baseUrl: "http://127.0.0.1:9", apiKey: "fixture-never-sent", api: "openai-completions",
      models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000 }],
      streamSimple: (model, context, options) => {
        const summary = options?.cacheRetention === "none";
        providerCalls.push(summary ? "summary" : "agent");
        const stream = createAssistantMessageEventStream();
        void (async () => {
          await options?.onPayload?.({ model: model.id, messages: context.messages }, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          const message = assistantMessage([{ type: "text", text: summary ? "A summary." : "OK" }], {
            provider: model.provider, model: model.id, api: model.api,
          });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        })();
        return stream;
      },
    });
  };
  const host = await hostExtension(fixture, { project, reason: "new" });
  try {
    await host.session.setModel(host.session.modelRuntime.getModel("compaction-fixture", "fixture")!);
    await host.session.prompt("Remember this older conversation. ".repeat(20));
    await host.session.prompt("And this.");
    assert.ok(hooks.includes("before_provider_request"), "agent requests reach the payload hook");
    hooks.length = 0;
    await host.session.compact();
    assert.equal(providerCalls.at(-1), "summary", "Pi asked the provider for a summary");
    assert.deepEqual(hooks, [], "the summary request passed through extension hooks");
  } finally {
    await host.dispose();
    project.dispose();
  }
});
