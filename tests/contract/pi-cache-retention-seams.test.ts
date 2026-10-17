import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeContext, type Context, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonFields } from "../../extensions/_lib/boundary.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const CONTEXT: Context = {
  messages: [{ role: "user", content: "Reply with OK", timestamp: 1 }],
};

async function accountCompletionUsage(provider: string, usage: Record<string, unknown>) {
  const model: Model<"openai-completions"> = {
    id: "fixture-model",
    name: "Fixture model",
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.example.test/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12 },
    contextWindow: 128_000,
    maxTokens: 1_000,
  };
  const chunk = {
    id: "chatcmpl-contract",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  };
  const fetch: FetchFunction = async () => new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
  return streamOpenAICompletions(model, normalizeContext(CONTEXT), { apiKey: "test", fetch }).result();
}

test("native OpenAI Completions accounts top-level cached_tokens for affected providers", async () => {
  for (const provider of ["moonshotai", "moonshotai-cn", "together"]) {
    const result = await accountCompletionUsage(provider, {
      prompt_tokens: 100,
      completion_tokens: 5,
      cached_tokens: 40,
    });
    assert.deepEqual(
      { input: result.usage.input, cacheRead: result.usage.cacheRead, output: result.usage.output, total: result.usage.totalTokens },
      { input: 60, cacheRead: 40, output: 5, total: 105 },
      `${provider} must use Pi's native cached_tokens accounting`,
    );
    const expectedCost = (60 * 10 + 40 * 1 + 5 * 20) / 1_000_000;
    assert.ok(Math.abs(result.usage.cost.total - expectedCost) < 1e-12);
  }
});

test("native OpenAI Completions keeps documented cache-field precedence", async () => {
  const detailed = await accountCompletionUsage("together", {
    prompt_tokens: 100,
    completion_tokens: 5,
    cached_tokens: 40,
    prompt_cache_hit_tokens: 30,
    prompt_tokens_details: { cached_tokens: 20 },
  });
  assert.equal(detailed.usage.cacheRead, 20, "prompt_tokens_details.cached_tokens wins");

  const legacy = await accountCompletionUsage("moonshotai", {
    prompt_tokens: 100,
    completion_tokens: 5,
    cached_tokens: 40,
    prompt_cache_hit_tokens: 30,
  });
  assert.equal(legacy.usage.cacheRead, 30, "prompt_cache_hit_tokens wins over top-level cached_tokens");

  for (const nativeField of [
    { prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 30 },
    { prompt_cache_hit_tokens: 0 },
  ]) {
    const uncached = await accountCompletionUsage("together", {
      prompt_tokens: 100,
      completion_tokens: 5,
      cached_tokens: 40,
      ...nativeField,
    });
    assert.equal(uncached.usage.cacheRead, 0, "explicit zero must not fall through to cached_tokens");
    assert.equal(uncached.usage.input, 100);
  }
});

// Capture real Pi requests, including its ChatGPT sign-in exception.
async function directOpenAIRequest(apiKey: string, modelId = "gpt-6.1-sol"): Promise<JsonFields> {
  const model = openaiProvider().getModels().find((model) => model.id === modelId);
  assert(model);
  const prior: Context["messages"][number] = {
    role: "assistant",
    content: [{ type: "text", text: "first answer" }],
    provider: model.provider,
    api: model.api,
    model: model.id,
    providerThinkingLevel: "low",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
  };
  const context: Context = {
    messages: [
      { role: "user", content: "first", timestamp: 1 },
      prior,
      { role: "user", content: "second", timestamp: 3 },
    ],
  };
  let request: JsonFields | undefined;
  const fetch: FetchFunction = async () => new Response("{}", { status: 400 });
  await streamOpenAIResponses(model, normalizeContext(context), {
    apiKey,
    fetch,
    reasoning: "high",
    cacheRetention: "long",
    onPayload: (params) => {
      assert(isJsonObject(params));
      request = params;
      return undefined;
    },
  }).result();
  assert(request, "Pi built no OpenAI Responses request");
  return request;
}

test("Pi appends GPT-6 effort updates with API keys but changes request-level effort with ChatGPT sign-in", async () => {
  const apiKey = await directOpenAIRequest("sk-contract");
  assert.deepEqual(apiKey.reasoning, { effort: "medium", summary: "auto" }, "request-level effort stays fixed");
  assert(Array.isArray(apiKey.input));
  assert.deepEqual(apiKey.input.filter((item) => isJsonObject(item) && item.type === "configuration_update"), [
    { type: "configuration_update", reasoning: { effort: "low" } },
    { type: "configuration_update", reasoning: { effort: "high" } },
  ], "the prior turn's effort stays in the prefix and the new one is appended");
  assert.deepEqual(apiKey.input.at(-1), { type: "configuration_update", reasoning: { effort: "high" } });

  const signIn = await directOpenAIRequest("chatgpt-access-token");
  assert.deepEqual(signIn.reasoning, { effort: "high", summary: "auto" }, "a ChatGPT sign-in changes request-level effort");
  assert(Array.isArray(signIn.input));
  assert.equal(signIn.input.some((item) => isJsonObject(item) && item.type === "configuration_update"), false);
});

test("direct OpenAI sends the legacy retention field when long caching is selected", async () => {
  const payload = await directOpenAIRequest("sk-contract", "gpt-5.2");
  assert.equal(payload.prompt_cache_retention, "24h");
});

test("Pi threads request replacements through extensions in load order", async () => {
  const project = new IsolatedProject();
  const seen: unknown[] = [];
  const host = await hostExtension([
    (pi) => { pi.on("before_provider_request", ({ payload }) => { seen.push(payload); return { replacement: true }; }); },
    (pi) => { pi.on("before_provider_request", ({ payload }) => { seen.push(payload); }); },
  ], { project });
  try {
    const result = await host.session.extensionRunner.emitBeforeProviderRequest({ original: true });
    assert.deepEqual(seen, [{ original: true }, { replacement: true }]);
    assert.deepEqual(result, { replacement: true });
  } finally {
    await host.dispose();
    project.dispose();
  }
});

test("Pi records thinking level changes on the active session branch", () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendThinkingLevelChange("high");
  const [entry] = manager.getBranch();
  assert(entry?.type === "thinking_level_change");
  assert.equal(entry.id, id);
  assert.equal(entry.parentId, null);
  assert.equal(entry.thinkingLevel, "high");
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
});
