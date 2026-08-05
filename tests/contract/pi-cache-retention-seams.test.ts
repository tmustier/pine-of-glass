import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isJsonObject } from "../../extensions/_lib/boundary.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const piAiRoot = join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist");

function source(name: string): string {
  return readFileSync(join(piAiRoot, "api", name), "utf8");
}

test("direct OpenAI keeps the legacy retention field", () => {
  assert.match(source("openai-responses.js"), /prompt_cache_retention:/);
});

function modelRecord(name: string, api: string, model: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(join(piAiRoot, "providers", "data", name), "utf8"));
  if (!isJsonObject(raw) || !isJsonObject(raw[api]) || !isJsonObject(raw[api][model])) {
    throw new Error(`Installed Pi model record missing: ${name} ${api} ${model}`);
  }
  return raw[api][model];
}

test("installed GPT-5.6 models keep direct API and Codex routes distinct", () => {
  const direct = modelRecord("openai.json", "openai-responses", "gpt-5.6-sol");
  const codex = modelRecord("openai-codex.json", "openai-codex-responses", "gpt-5.6-sol");
  assert.equal(direct.provider, "openai");
  assert.ok(isJsonObject(direct.compat));
  assert.equal(direct.compat.supportsExplicitPromptCacheMode, true);
  assert.equal(codex.provider, "openai-codex");
  assert.equal(codex.baseUrl, "https://chatgpt.com/backend-api");
});

test("installed provider records keep Cachemire's new routes exact", () => {
  for (const [file, api, model, provider] of [
    ["minimax.json", "anthropic-messages", "MiniMax-M2.7", "minimax"],
    ["minimax-cn.json", "anthropic-messages", "MiniMax-M2.7-highspeed", "minimax-cn"],
    ["amazon-bedrock.json", "bedrock-converse-stream", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "amazon-bedrock"],
    ["groq.json", "openai-completions", "openai/gpt-oss-120b", "groq"],
    ["cerebras.json", "openai-completions", "zai-glm-4.7", "cerebras"],
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
