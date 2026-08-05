import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Context, FetchFunction, Model } from "@earendil-works/pi-ai";

import {
  cachedTokenNormalizingFetch,
  installProviderUsageOverlays,
  normalizeCachedTokenSseLine,
} from "../../extensions/pi-cachemire/provider-usage.ts";

const MODEL: Model<"openai-completions"> = {
  id: "fixture-model",
  name: "Fixture model",
  api: "openai-completions",
  provider: "together",
  baseUrl: "https://api.together.xyz/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 },
  contextWindow: 128_000,
  maxTokens: 1_000,
};

const CONTEXT: Context = {
  messages: [{ role: "user", content: "Reply with OK", timestamp: 1 }],
};

const CUSTOM_STREAM = (() => {
  throw new Error("not called");
}) as NonNullable<ProviderConfig["streamSimple"]>;

function providerHarness(initial: Iterable<readonly [string, ProviderConfig]> = []) {
  const registrations: string[] = [];
  const registered = new Map(initial);
  const pi = {
    registerProvider(provider: string, config: ProviderConfig): void {
      registrations.push(provider);
      registered.set(provider, { ...registered.get(provider), ...config });
    },
    unregisterProvider(provider: string): void {
      registered.delete(provider);
    },
  } as Pick<ExtensionAPI, "registerProvider" | "unregisterProvider">;
  return {
    pi,
    registrations,
    registered,
    registry: {
      getRegisteredNativeProvider: (_provider: string) => undefined,
      getRegisteredProviderConfig: (provider: string) => registered.get(provider),
    },
  };
}

test("does not override Pi-supported cache fields", () => {
  for (const line of [
    'data: {"usage":{"cached_tokens":40,"prompt_tokens_details":{"cached_tokens":0}}}\n',
    'data: {"usage":{"cached_tokens":40,"prompt_cache_hit_tokens":0}}\n',
  ]) assert.equal(normalizeCachedTokenSseLine(line), line);
});

test("streams fragmented UTF-8 and CRLF while preserving response metadata", async () => {
  const source = [
    'data: {"choices":[{"delta":{"content":"café"}}]}\r\n\r\n',
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":5,"cached_tokens":40}}\r\n\r\n',
    "data: [DONE]\r\n\r\n",
  ].join("");
  const bytes = new TextEncoder().encode(source);
  const ends = [7, bytes.indexOf(0xc3) + 1, bytes.indexOf(0x0d) + 1, bytes.length];
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      let start = 0;
      for (const end of ends) {
        controller.enqueue(bytes.slice(start, end));
        start = end;
      }
      controller.close();
    },
  });
  const wrapped = cachedTokenNormalizingFetch(async () => new Response(body, {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "content-length": String(bytes.length),
      "x-cachemire-test": "preserved",
    },
  }));

  const response = await wrapped("https://example.test");
  assert.equal(response.statusText, "OK");
  assert.equal(response.headers.get("x-cachemire-test"), "preserved");
  assert.equal(response.headers.get("content-length"), null);
  const text = await response.text();
  assert.match(text, /café/);
  assert.match(text, /"prompt_tokens_details":\{"cached_tokens":40\}/);
  assert.match(text, /\r\n\r\ndata: \[DONE\]\r\n\r\n$/);
});

test("leaves failed responses untouched", async () => {
  const response = new Response("failed", { status: 500 });
  assert.equal(await cachedTokenNormalizingFetch(async () => response)("https://example.test"), response);
});

test("feeds normalized usage through Pi's accounting", async () => {
  const harness = providerHarness();
  const cleanup = installProviderUsageOverlays(harness.pi, harness.registry);
  const streamSimple = harness.registered.get("together")?.streamSimple;
  assert.ok(streamSimple);
  const chunk = {
    id: "chatcmpl-cachemire",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL.id,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 40 },
  };
  const fetch: FetchFunction = async () => new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
  const result = await streamSimple(MODEL, CONTEXT, { apiKey: "test", fetch }).result();
  assert.equal(result.usage.input, 60);
  assert.equal(result.usage.cacheRead, 40);
  assert.equal(result.usage.output, 5);
  assert.equal(result.usage.totalTokens, 105);
  assert.ok(Math.abs(result.usage.cost.total - 0.00074) < 1e-12);
  cleanup();
});

test("registers the intended providers and respects existing provider streams", () => {
  const all = providerHarness();
  const cleanup = installProviderUsageOverlays(all.pi, all.registry);
  assert.deepEqual(all.registrations, ["moonshotai", "moonshotai-cn", "together"]);
  cleanup();
  assert.equal(all.registered.size, 0);

  const previous: ProviderConfig = { name: "Moonshot config" };
  const collisions = providerHarness([
    ["moonshotai", previous],
    ["together", { streamSimple: CUSTOM_STREAM }],
  ]);
  collisions.registry.getRegisteredNativeProvider = (provider) => provider === "moonshotai-cn" ? ({} as never) : undefined;
  const restore = installProviderUsageOverlays(collisions.pi, collisions.registry);
  assert.deepEqual(collisions.registrations, ["moonshotai"]);
  restore();
  assert.deepEqual(collisions.registered.get("moonshotai"), previous);
  assert.equal(collisions.registered.get("together")?.streamSimple, CUSTOM_STREAM);
});

test("does not remove a provider stream installed after its own", () => {
  const harness = providerHarness();
  const cleanup = installProviderUsageOverlays(harness.pi, harness.registry);
  harness.registered.set("together", { streamSimple: CUSTOM_STREAM });
  cleanup();
  assert.equal(harness.registered.get("together")?.streamSimple, CUSTOM_STREAM);
});
