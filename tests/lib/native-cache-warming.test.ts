// Pi's own cache warmer against the family's request tracking: the replay reaches the same
// provider hooks as the agent's requests (docs/state-machines-2026-11-03.md, "Provider request
// cycle"). The Anthropic stream is real; only fetch is scripted.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import contextimate from "../../extensions/pi-contextimate/index.ts";
import meantime from "../../extensions/pi-meantime/index.ts";
import { scanSession } from "../../extensions/pi-contextimate/session-accounting.ts";
import { isJsonObject } from "../../extensions/_lib/boundary.ts";
import { ANTHROPIC } from "../cachemire/event-fixtures.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const TTL_S = 300;
const WARM_DELAY_MS = 270_000; // Pi refreshes a 300s cache 30s before expiry.

/** What the scripted HTTP layer saw: the warmer's replay asks for one output token. */
type Sent = { warm: boolean; text: string };

function sent(body: unknown): Sent {
  return { warm: isJsonObject(body) && body.max_tokens === 1, text: JSON.stringify(body) };
}

function isReplay(payload: unknown): boolean {
  return isJsonObject(payload) && payload.max_tokens === 1;
}

/** An Anthropic provider whose HTTP layer answers from a script. Every body is recorded. */
function scriptedAnthropic(bodies: Sent[], toolRound: boolean): ExtensionFactory {
  return (pi) => {
    pi.registerProvider("anthropic", {
      baseUrl: ANTHROPIC.baseUrl, apiKey: "fixture-never-sent", api: "anthropic-messages",
      models: [{ ...ANTHROPIC, promptCache: { short: TTL_S } }],
      // SAFETY: Pi routes this provider's models, all declared above as anthropic-messages, here.
      streamSimple: (model, context, options) => streamAnthropic(model as typeof ANTHROPIC, context, {
        ...options,
        fetch: async (_url, init) => {
          const body = sent(JSON.parse(String(init?.body)));
          bodies.push(body);
          const warm = body.warm;
          const callTool = toolRound && !warm && !body.text.includes("tool_result");
          const content = callTool ? [{ type: "tool_use", id: "toolu_1", name: "fixture_tool", input: {} }] : [];
          const events = [
            { type: "message_start", message: {
              id: `msg_${bodies.length}`, type: "message", role: "assistant", model: model.id, content: [], stop_reason: null,
              usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: warm ? 100_000 : 0,
                cache_creation_input_tokens: warm ? 0 : 100_000 },
            } },
            ...content.flatMap((block, index) => [
              { type: "content_block_start", index, content_block: { ...block, input: {} } },
              { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } },
              { type: "content_block_stop", index },
            ]),
            { type: "message_delta", delta: { stop_reason: callTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ];
          return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } });
        },
      }),
    });
  };
}

function freezeClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
}

test("a refresh replay during the next request's context work does not start that request's clock", async (t) => {
  freezeClock(t);
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true, widget: false });
  const bodies: Sent[] = [];
  let contexts = 0;
  let warmed!: () => void;
  const warmFinished = new Promise<void>((resolve) => { warmed = resolve; });
  const slowContext: ExtensionFactory = (pi) => {
    pi.on("context", async () => {
      if (++contexts !== 2) return;
      // The warmer fires while an extension still prepares the next request.
      t.mock.timers.tick(WARM_DELAY_MS);
      await warmFinished;
      t.mock.timers.tick(10_000);
    });
    pi.on("message_end", ({ message }) => {
      if (message.role === "assistant" && contexts === 1) pi.sendUserMessage("follow up", { deliverAs: "followUp" });
    });
  };
  const host = await hostExtension([meantime, scriptedAnthropic(bodies, false), slowContext], { project, reason: "new" });
  const unsubscribe = host.session.subscribe((event) => {
    if (event.type === "entry_appended" && event.entry.type === "usage" && event.entry.kind === "cache_warm") warmed();
  });
  try {
    host.session.settingsManager.setCacheWarmingMode("streaming");
    await host.session.setModel(host.session.modelRuntime.getModel("anthropic", ANTHROPIC.id)!);
    await host.session.prompt("first");
    assert.deepEqual(bodies.map((body) => body.warm), [false, true, false], "Pi replayed the first request");
    await host.session.prompt("/pace");
    const pace = host.ui.notifications.at(-1)!;
    assert.match(pace, /totals: 2 calls/);
    assert.doesNotMatch(pace, /\b10s\b|\b4m\b/, `context work was charged to the model:\n${pace}`);
  } finally {
    unsubscribe();
    await host.dispose();
    project.dispose();
  }
});

test("an aborted refresh delivered after the next request keeps Contextimate's capture", async (t) => {
  freezeClock(t);
  const project = new IsolatedProject();
  const bodies: Sent[] = [];
  let contexts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const warmAtGate = new Promise<void>((resolve) => { reached = resolve; });
  const injections = ["FIRST", "SECOND, A LONGER ADDITION"];
  // Loaded before Contextimate: holds the replay in an earlier payload handler.
  const head: ExtensionFactory = (pi) => {
    pi.on("context_with_system", (event) => {
      const content = injections[contexts++];
      return content ? { messages: [...event.messages, { role: "user", content, timestamp: 1 }] } : undefined;
    });
    pi.on("before_provider_request", async ({ payload }) => {
      if (!isReplay(payload)) return;
      reached();
      await gate;
    });
    pi.registerTool({ name: "fixture_tool", label: "Fixture tool", description: "Return fixture output",
      parameters: Type.Object({}), execute: async () => {
        t.mock.timers.tick(WARM_DELAY_MS);
        await warmAtGate;
        return { content: [{ type: "text", text: "fixture tool output" }], details: {} };
      } });
  };
  // Loaded after Contextimate: lets the replay continue once the next request has passed.
  const order: string[] = [];
  const tail: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", ({ payload }) => {
      const warm = isReplay(payload);
      order.push(warm ? "replay" : "agent");
      if (!warm && contexts === 2) release();
    });
  };
  const host = await hostExtension([head, contextimate, scriptedAnthropic(bodies, true), tail], {
    project, reason: "new", interactive: false, noTools: "builtin",
  });
  try {
    host.session.settingsManager.setCacheWarmingMode("streaming");
    await host.session.setModel(host.session.modelRuntime.getModel("anthropic", ANTHROPIC.id)!);
    await host.session.prompt("run the fixture tool");
    assert.deepEqual(order, ["agent", "agent", "replay"], "the aborted refresh reached the hooks last");
    assert.equal(scanSession(host.session.sessionManager).breakdown?.requestOnly?.chars, injections[1]!.length);
  } finally {
    await host.dispose();
    project.dispose();
  }
});
