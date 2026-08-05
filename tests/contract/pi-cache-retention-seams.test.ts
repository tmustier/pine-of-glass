// Contract test for the installed Pi request shapes that Cachemire uses as route evidence.
// Public OpenAI API documentation does not automatically govern the Codex OAuth backend.
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

test("official OpenAI and Codex OAuth expose different cache-policy request shapes", () => {
  const direct = source("openai-responses.js");
  assert.match(direct, /prompt_cache_key:/, "direct OpenAI lost its cache key");
  assert.match(direct, /prompt_cache_retention:/, "legacy maximum-retention policy seam moved");
  assert.match(direct, /prompt_cache_options:/, "GPT-5.6 cache-options seam moved");

  const codex = source("openai-codex-responses.js");
  assert.match(codex, /prompt_cache_key:/, "Codex cache-key seam moved");
  assert.doesNotMatch(codex, /prompt_cache_retention:/, "Codex gained a retention policy: review the evidence table");
  assert.doesNotMatch(codex, /prompt_cache_options:/, "Codex gained cache options: review the evidence table");
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
