// Cachemire anchors a cache entry's TTL at the provider's response start (docs/pi-cachemire.md).
import { test } from "node:test";
import assert from "node:assert/strict";

import { fauxAssistantMessage, fauxProvider, normalizeContext, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const anthropic: Model<"anthropic-messages"> = {
  id: "claude-opus-4-8", name: "Claude Opus", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://anthropic.example.test", reasoning: false, input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  contextWindow: 200_000, maxTokens: 8_000,
};

function sse(type: string, data: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

test("Anthropic reports the response before Pi reads the stream body", async () => {
  const order: string[] = [];
  const chunks = [
    sse("message_start", {
      message: {
        id: "msg_contract", type: "message", role: "assistant", model: anthropic.id, content: [], stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    sse("message_stop", {}),
  ];
  const fetch: FetchFunction = async () => {
    order.push("headers");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        order.push("body");
        controller.enqueue(encoder.encode(chunks.join("")));
        controller.close();
      },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const stream = streamAnthropic(anthropic, normalizeContext({ messages: [{ role: "user", content: "Reply OK", timestamp: 1 }] }), {
    apiKey: "test",
    fetch,
    onResponse: () => {
      order.push("onResponse");
    },
  });
  for await (const event of stream) order.push(event.type);
  assert.deepEqual(order.slice(0, 3), ["headers", "onResponse", "body"],
    "pi-cachemire's response-start anchor needs onResponse at the headers, before the body is read");
});

test("Pi forwards the provider response to extensions before the assistant message", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("OK")]);
  const seen: string[] = [];
  const project = new IsolatedProject();
  const host = await hostExtension((pi) => {
    pi.on("after_provider_response", () => {
      seen.push("after_provider_response");
    });
    pi.on("message_end", ({ message }) => {
      if (message.role === "assistant") seen.push("message_end");
    });
  }, { project, model: faux.getModel() });
  try {
    host.session.modelRuntime.registerNativeProvider(faux.provider);
    await host.session.prompt("hello");
  } finally {
    await host.dispose();
    project.dispose();
  }
  assert.deepEqual(seen, ["after_provider_response", "message_end"],
    "pi-cachemire reads the response start from after_provider_response");
});
