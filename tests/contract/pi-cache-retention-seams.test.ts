import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeContext, type Context, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { isJsonObject, type JsonFields } from "../../extensions/_lib/boundary.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const piAiRoot = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));

function source(name: string): string {
  return readFileSync(join(piAiRoot, "api", name), "utf8");
}

test("direct OpenAI keeps the legacy retention field", () => {
  assert.match(source("openai-responses.js"), /prompt_cache_retention:/);
});

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

function modelRecord(name: string, api: string, model: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(join(piAiRoot, "providers", "data", name), "utf8"));
  assert(isJsonObject(raw), `invalid provider catalogue: ${name}`);
  const models = raw[api];
  assert(isJsonObject(models), `missing provider API: ${name} ${api}`);
  // Pi 0.99 keys catalogue entries by model type (`chat:<id>`); older records were bare.
  const record = models[`chat:${model}`] ?? models[model];
  assert(isJsonObject(record), `missing provider model: ${name} ${api} ${model}`);
  return record;
}

test("installed GPT-5.6 and GPT-6 Astra models keep direct API and Codex routes distinct", () => {
  for (const model of ["gpt-5.6-sol", "gpt-6-astra"]) {
    const direct = modelRecord("openai.json", "openai-responses", model);
    const codex = modelRecord("openai-codex.json", "openai-codex-responses", model);
    assert.equal(direct.provider, "openai");
    assert.ok(isJsonObject(direct.compat));
    assert.equal(direct.compat.supportsExplicitPromptCacheMode, true);
    assert.equal(codex.provider, "openai-codex");
    assert.equal(codex.baseUrl, "https://chatgpt.com/backend-api");
  }
});

test("installed Claude Fable 5.1 declares Pi's cache-safe effort protocol", () => {
  const fable = modelRecord("anthropic.json", "anthropic-messages", "claude-fable-5-1");
  assert.equal(fable.provider, "anthropic");
  assert.ok(isJsonObject(fable.compat));
  assert.equal(fable.compat.supportsMidConvoEffort, true);

  const anthropic = source("anthropic-messages.js");
  assert.match(anthropic, /insertThinkingLevelMessages\(converted, activeEffort\)/);
  assert.match(anthropic, /prefix_mismatch_behavior: "drop_block"/);
  assert.match(anthropic, /params\.output_config = \{ effort: "high" \}/);
  assert.match(anthropic, /providerThinkingLevel/);
});

// Capture real Pi requests, including its ChatGPT sign-in exception.
async function directOpenAIRequest(apiKey: string): Promise<JsonFields> {
  const model = openaiProvider().getModels().find((model) => model.id === "gpt-6.1-sol");
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

// Cachemire reads the request at its own hook position. Pi runs before_provider_request
// per extension in load order and threads each replacement payload into later handlers
// only, so a later-loaded rewrite (for example an append-only configuration_update for
// Astra) is invisible to Cachemire: the billed usage, not the payload, is the verdict.
test("Pi threads before_provider_request replacements through later extensions in load order", () => {
  const runner = readFileSync(join(piRoot, "dist", "core", "extensions", "runner.js"), "utf8");
  const emit = runner.match(/async emitBeforeProviderRequest\(payload\) \{[\s\S]*?\n {4}\}\n/)?.[0];
  assert.ok(emit, "emitBeforeProviderRequest moved: re-verify Cachemire's evidence model against the new hook order");
  assert.match(emit, /snapshotEventHandlers\(this\.extensions, "before_provider_request"\)/);
  assert.match(emit, /payload: currentPayload,/);
  assert.match(emit, /if \(handlerResult !== undefined\) \{\s*currentPayload = handlerResult;/);
});

// A resumed session seeds the route's billed efforts from Pi's persisted level changes.
test("Pi persists thinking level changes as session entries Cachemire can replay", () => {
  const declarations = readFileSync(join(piRoot, "dist", "core", "session-manager.d.ts"), "utf8");
  assert.match(declarations, /interface SessionEntryBase \{\s*type: string;\s*id: string;\s*parentId: string \| null;\s*timestamp: string;/);
  assert.match(declarations, /interface ThinkingLevelChangeEntry extends SessionEntryBase \{\s*type: "thinking_level_change";\s*thinkingLevel: string;/);
  assert.match(declarations, /appendThinkingLevelChange\(thinkingLevel: string\): string;/);
});

test("installed provider records keep Cachemire's new routes exact", () => {
  for (const [file, api, model, provider] of [
    ["minimax.json", "anthropic-messages", "MiniMax-M2.7", "minimax"],
    ["minimax-cn.json", "anthropic-messages", "MiniMax-M2.7-highspeed", "minimax-cn"],
    ["amazon-bedrock.json", "bedrock-converse-stream", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "amazon-bedrock"],
    ["groq.json", "openai-completions", "openai/gpt-oss-120b", "groq"],
    ["cerebras.json", "openai-completions", "gpt-oss-120b", "cerebras"],
  ]) {
    assert.equal(modelRecord(file, api, model).provider, provider);
  }
});

test("Bedrock exposes cache points and normalized read/write usage", () => {
  const bedrock = source("bedrock-converse-stream.js");
  assert.match(bedrock, /cachePoint: \{ type: CachePointType\.DEFAULT/);
  assert.match(bedrock, /ttl: CacheTTL\.ONE_HOUR/);
  assert.match(bedrock, /usage\.cacheRead = event\.usage\.cacheReadInputTokens/);
  assert.match(bedrock, /usage\.cacheWrite = event\.usage\.cacheWriteInputTokens/);
});
