// Cachemire compares history only through the last cache marker on routes that cache
// only through markers (docs/pi-cachemire.md). This pins where Pi's Anthropic builder
// puts that marker relative to its managed effort messages.
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeContext, type Context, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";

import { isJsonObject, type JsonFields } from "../../extensions/_lib/boundary.ts";
import { diffFingerprints, fingerprintPayload } from "../../extensions/pi-cachemire/classify.ts";

const opus: Model<"anthropic-messages"> = {
  id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://anthropic.example.test", reasoning: true, input: ["text"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 400_000, maxTokens: 8_000,
  compat: { supportsMidConvoEffort: true },
};

async function payloadFor(context: Context): Promise<JsonFields> {
  let captured: unknown;
  const fetch: FetchFunction = async () => new Response("unavailable", { status: 503 });
  const stream = streamAnthropic(opus, normalizeContext(context), {
    apiKey: "test",
    fetch,
    reasoning: "high",
    onPayload: (payload) => {
      captured = payload;
      return undefined;
    },
  });
  await stream.result();
  assert.ok(isJsonObject(captured), "Pi built an Anthropic payload");
  return captured;
}

test("an aborted turn on a mid-conversation-effort model keeps the cached prefix", async () => {
  // Pi's prompts carry array content; the marker lands on their last block.
  const first = { role: "user" as const, content: [{ type: "text" as const, text: "first" }], timestamp: 1 };
  const aborted = {
    role: "assistant" as const, content: [], api: opus.api, provider: opus.provider, model: opus.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted" as const, timestamp: 2,
  };
  const next = { role: "user" as const, content: [{ type: "text" as const, text: "second" }], timestamp: 3 };
  const before = await payloadFor({ messages: [first] });
  const after = await payloadFor({ messages: [first, aborted, next] });

  const route = { provider: opus.provider, model: opus.id, api: opus.api, supportsMidConvoEffort: true };
  assert.equal(
    diffFingerprints(fingerprintPayload(before, route), fingerprintPayload(after, route)),
    undefined,
    "the replaced effort message sat after the cache marker",
  );
});
