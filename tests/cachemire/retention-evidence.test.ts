import assert from "node:assert/strict";
import test from "node:test";
import { TTL_LONG_MS, TTL_SHORT_MS } from "../../extensions/pi-cachemire/classify.ts";
import {
  confirmedWindow,
  OPENAI_EXTENDED_WINDOW,
  OPENAI_MINIMUM_WINDOW,
  RETENTION_EVIDENCE_SOURCES,
  RETENTION_POLICIES,
  retentionForModel,
  retentionForRequest,
} from "../../extensions/pi-cachemire/retention.ts";

const CACHE_WRITE = { cacheRead: 0, cacheWrite: 1_024 };
const CACHE_READ = { cacheRead: 1_024, cacheWrite: 0 };

test("model retention is limited to documented provider, API and model routes", () => {
  assert.deepEqual(
    retentionForModel("anthropic", "claude-sonnet-4-6", "anthropic-messages", {})?.window,
    { kind: "contract", ttlMs: TTL_SHORT_MS, source: "inferred" },
  );
  assert.equal(
    retentionForModel("openai-codex", "gpt-5.6-sol", "openai-codex-responses")?.window,
    OPENAI_MINIMUM_WINDOW,
  );
  assert.equal(
    retentionForModel("openai", "gpt-5.6", "openai-responses")?.window,
    OPENAI_MINIMUM_WINDOW,
  );
  assert.equal(retentionForModel("openai", "gpt-5.5", "openai-responses"), undefined);
  assert.deepEqual(
    retentionForModel("minimax-cn", "MiniMax-M2.7-highspeed", "anthropic-messages")?.window,
    { kind: "contract", ttlMs: TTL_SHORT_MS, source: "inferred" },
  );
  assert.equal(
    retentionForModel(
      "amazon-bedrock",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "bedrock-converse-stream",
    ),
    undefined,
  );
  assert.deepEqual(
    retentionForModel("groq", "openai/gpt-oss-120b", "openai-completions")?.window,
    { kind: "contract", ttlMs: 2 * TTL_LONG_MS, source: "observed" },
  );
  assert.equal(retentionForModel("groq", "qwen/qwen3-32b", "openai-completions"), undefined);
  assert.equal(
    retentionForModel("cerebras", "gpt-oss-120b", "openai-completions")?.window.kind,
    "maximum",
  );
});

test("live request evidence resolves the supported retention contracts", () => {
  assert.deepEqual(
    retentionForRequest({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      api: "anthropic-messages",
      ttlMs: TTL_LONG_MS,
      payload: {},
    })?.window,
    { kind: "contract", ttlMs: TTL_LONG_MS, source: "observed" },
  );
  assert.equal(
    retentionForRequest({
      provider: "openai",
      model: "gpt-5.6",
      api: "openai-responses",
      payload: {},
    })?.window,
    OPENAI_MINIMUM_WINDOW,
  );
  assert.equal(
    retentionForRequest({
      provider: "openai",
      model: "gpt-5.5-codex",
      api: "openai-responses",
      payload: { prompt_cache_retention: "24h" },
    })?.window,
    OPENAI_EXTENDED_WINDOW,
  );
  assert.equal(
    retentionForRequest({
      provider: "openai-codex",
      model: "gpt-5.5-codex",
      api: "openai-codex-responses",
      payload: { prompt_cache_retention: "24h" },
    }),
    undefined,
  );
  assert.deepEqual(
    retentionForRequest({
      provider: "minimax",
      model: "MiniMax-M2.7",
      api: "anthropic-messages",
      ttlMs: TTL_SHORT_MS,
      payload: {},
    })?.window,
    { kind: "contract", ttlMs: TTL_SHORT_MS, source: "observed" },
  );
  assert.deepEqual(
    retentionForRequest({
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      api: "bedrock-converse-stream",
      payload: { system: [{ text: "prompt" }, { cachePoint: { type: "default", ttl: "1h" } }] },
    })?.window,
    { kind: "contract", ttlMs: TTL_LONG_MS, source: "observed" },
  );
  assert.equal(
    retentionForRequest({
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-6-v1",
      api: "bedrock-converse-stream",
      payload: { system: [{ cachePoint: { type: "default", ttl: "1h" } }] },
    }),
    undefined,
  );
  assert.equal(
    retentionForRequest({
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      api: "bedrock-converse-stream",
      payload: {
        messages: [{
          role: "user",
          content: [{ toolUse: { name: "search", input: { cachePoint: { type: "default", ttl: "1h" } } } }],
        }],
      },
    }),
    undefined,
  );
  assert.deepEqual(
    retentionForRequest({
      provider: "groq",
      model: "openai/gpt-oss-20b",
      api: "openai-completions",
      payload: {},
    })?.window,
    { kind: "contract", ttlMs: 2 * TTL_LONG_MS, source: "observed" },
  );
  assert.deepEqual(
    retentionForRequest({
      provider: "cerebras",
      model: "zai-glm-4.7",
      api: "openai-completions",
      payload: {},
    })?.window,
    { kind: "maximum", maxMs: TTL_LONG_MS },
  );
  assert.equal(
    retentionForRequest({
      provider: "openrouter",
      model: "openai/gpt-oss-120b",
      api: "openai-completions",
      payload: {},
    }),
    undefined,
  );
});

test("usage activates only the evidence each provider exposes", () => {
  const anthropic = retentionForRequest({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    api: "anthropic-messages",
    ttlMs: TTL_SHORT_MS,
    payload: {},
  });
  const groq = retentionForRequest({
    provider: "groq",
    model: "openai/gpt-oss-120b",
    api: "openai-completions",
    payload: {},
  });
  const openaiExtended = retentionForRequest({
    provider: "openai",
    model: "gpt-5.5-codex",
    api: "openai-responses",
    payload: { prompt_cache_retention: "24h" },
  });

  assert.deepEqual(confirmedWindow(anthropic, CACHE_WRITE), anthropic?.window);
  assert.equal(confirmedWindow(groq, CACHE_WRITE), undefined);
  assert.deepEqual(confirmedWindow(groq, CACHE_READ), groq?.window);
  assert.equal(confirmedWindow(openaiExtended, CACHE_WRITE), undefined);
  assert.equal(confirmedWindow(openaiExtended, CACHE_READ), OPENAI_EXTENDED_WINDOW);
  assert.equal(confirmedWindow(anthropic, { cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("every retention policy cites a registered evidence source", () => {
  assert.ok(RETENTION_POLICIES.length > 0);
  for (const policy of RETENTION_POLICIES) {
    assert.ok(policy.sourceIds.length > 0, `${policy.route} has no evidence source`);
    for (const sourceId of policy.sourceIds) assert.ok(sourceId in RETENTION_EVIDENCE_SOURCES);
  }
});
