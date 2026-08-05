// Heuristic resolution precedence and built-in model routing. A precedence bug here
// silently misprices every row in the estimator, so each layer is pinned explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import {
  keepsAllClaudeThinking,
  keepsAllOpenAIReasoning,
} from "../../extensions/pi-contextimate/model-heuristics.ts";
import type { ContextimateConfig, ModelSummary } from "../../extensions/pi-contextimate/index.ts";
import { anthropicModel, codexModel } from "../helpers.ts";
import { tokenizerFamilies } from "./heuristic-family-fixtures.ts";

const { parseContextimateConfig, resolveHeuristic, cleanDenominator } = internals;

function model(provider: string, id: string, api: string): ModelSummary {
  return { provider, id, api };
}

test("no model, no config → chars/4 fallback with openai-responses shape", () => {
  const h = resolveHeuristic(undefined, {});
  assert.equal(h.label, "fallback chars/4");
  assert.equal(h.textDenominator, 4);
  assert.equal(h.sessionDenominator, 4);
  assert.equal(h.toolDenominator, 4);
  assert.equal(h.toolNumerator, "openai-responses");
});

test("Claude thinking-retention boundaries follow Anthropic's model policy", () => {
  for (const keepAll of [
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-5",
    "claude-sonnet-4-6",
    "anthropic.claude-sonnet-4-6-20250514-v1:0",
    "claude-fable-5",
    "claude-mythos-5",
    "anthropic.claude-mythos-preview-v1:0",
  ]) assert.equal(keepsAllClaudeThinking(keepAll), true, keepAll);
  for (const lastTurnOnly of [
    "claude-opus-4-4",
    "claude-opus-4-20250514",
    "claude-sonnet-4-5",
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-20250219",
    "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "claude-haiku-4-5",
  ]) assert.equal(keepsAllClaudeThinking(lastTurnOnly), false, lastTurnOnly);
});

test("OpenAI reasoning-retention boundaries follow the effective context default", () => {
  for (const keepAll of ["gpt-5.6", "gpt-5.6-sol", "openai/gpt-5-6-20260801", "gpt-6"]) {
    assert.equal(keepsAllOpenAIReasoning(keepAll), true, keepAll);
  }
  for (const currentTurn of ["gpt-5.5", "gpt-5-20250807", "o3", "gpt-oss-120b"]) {
    assert.equal(keepsAllOpenAIReasoning(currentTurn), false, currentTurn);
  }
});

test("Claude profiles follow the model through supported routes", () => {
  for (const current of [
    anthropicModel,
    model("anthropic", "claude-fable-5", "anthropic-messages"),
    model("radius", "claude-opus-4-8", "pi-messages"),
    model("openrouter", "anthropic/claude-fable-5", "openai-completions"),
    model("github-copilot", "claude-fable-5", "openai-completions"),
    model("amazon-bedrock", "anthropic.claude-opus-4-8-v1:0", "bedrock-converse-stream"),
  ]) {
    const heuristic = resolveHeuristic(current, {});
    assert.equal(heuristic.label, "Claude 4.7+ heuristic");
    assert.equal(heuristic.textDenominator, 2.6);
  }

  const sonnet = resolveHeuristic(model("anthropic", "claude-sonnet-4-5", "anthropic-messages"), {});
  assert.equal(sonnet.label, "Claude 4.5/4.6 heuristic");
  assert.equal(sonnet.textDenominator, 3.8);
  assert.equal(resolveHeuristic(model("anthropic", "claude-3-haiku", "anthropic-messages"), {}).label, "Anthropic heuristic");

  const bedrock = resolveHeuristic(model("amazon-bedrock", "anthropic.claude-opus-4-8-v1:0", "bedrock-converse-stream"), {});
  assert.equal(bedrock.toolNumerator, "bedrock");
  assert.equal(bedrock.toolDenominator, 4);
  const openrouter = resolveHeuristic(model("openrouter", "anthropic/claude-fable-5", "openai-completions"), {});
  assert.equal(openrouter.toolNumerator, "openai-chat");
  assert.equal(openrouter.toolDenominator, 4);
  const radius = resolveHeuristic(model("radius", "claude-opus-4-8", "pi-messages"), {});
  assert.equal(radius.toolNumerator, "pi-messages");
  assert.equal(radius.toolDenominator, 4);
});

test("measured tokenizer families match their published model IDs", () => {
  for (const [label, textDenominator, sessionDenominator, ids] of tokenizerFamilies) {
    for (const id of ids) {
      const heuristic = resolveHeuristic(model("relay", id, "openai-completions"), {});
      assert.equal(heuristic.label, label, id);
      assert.equal(heuristic.textDenominator, textDenominator, id);
      assert.equal(heuristic.sessionDenominator, sessionDenominator, id);
    }
  }
});

test("measured tokenizer families remain independent of their wire API", () => {
  const cases = [
    [model("kimi-coding", "k3-256k", "anthropic-messages"), "Kimi tokenizer", "anthropic"],
    [model("amazon-bedrock", "zai.glm-4.7", "bedrock-converse-stream"), "GLM 4.5 tokenizer", "bedrock"],
    [model("xai", "grok-4.5", "openai-responses"), "Grok 4.5 tokenizer", "openai-responses"],
    [model("vercel-ai-gateway", "google/gemini-3.5-flash", "anthropic-messages"), "Gemini 2/3 countTokens", "anthropic"],
    [model("vercel-ai-gateway", "deepseek/deepseek-v3.2", "anthropic-messages"), "DeepSeek tokenizer", "anthropic"],
    [model("amazon-bedrock", "qwen.qwen3-coder-next", "bedrock-converse-stream"), "Qwen 2.5/3 tokenizer", "bedrock"],
  ] as const;

  for (const [current, label, toolNumerator] of cases) {
    const heuristic = resolveHeuristic(current, {});
    assert.equal(heuristic.label, label);
    assert.equal(heuristic.toolNumerator, toolNumerator);
  }
});

test("dynamic selectors and unverified variants keep the fallback tokenizer", () => {
  for (const current of [
    model("openrouter", "~moonshotai/kimi-latest", "openai-completions"),
    model("openrouter", "~x-ai/grok-latest", "openai-completions"),
    model("radius", "auto", "pi-messages"),
    model("openrouter", "free", "openai-completions"),
    model("openrouter", "z-ai/glm-4.7-flashx", "openai-completions"),
    model("zai", "glm-5-turbo", "openai-completions"),
    model("zai", "glm-5v-turbo", "openai-completions"),
    model("vercel-ai-gateway", "xai/grok-4.20-reasoning-beta", "anthropic-messages"),
    model("xai", "grok-build-latest", "openai-completions"),
    model("openrouter", "deepseek/deepseek-chat", "openai-completions"),
    model("openrouter", "qwen/qwen-plus", "openai-completions"),
    model("openrouter", "qwen/qwen3-coder", "openai-completions"),
    model("openrouter", "qwen/qwen3-max", "openai-completions"),
    model("openrouter", "qwen/qwen3.5-flash-02-23", "openai-completions"),
    model("vercel-ai-gateway", "alibaba/qwen3.5-plus", "anthropic-messages"),
    model("openrouter", "qwen/qwen3.6-27b", "openai-completions"),
  ]) {
    assert.equal(
      resolveHeuristic(current, {}).label,
      "fallback chars/4",
      `${current.provider}/${current.id}`,
    );
  }
});

test("unmeasured Gemini routes keep the existing generic estimate", () => {
  for (const id of [
    "~google/gemini-flash-latest",
    "google/gemini-2.5-pro-preview",
    "google/gemini-2.5-pro-preview-05-06",
    "google/gemini-3-flash",
    "gemini-3.1-pro",
    "gemini-3.1-flash-live-preview",
  ]) {
    const heuristic = resolveHeuristic(model("relay", id, "openai-completions"), {});
    assert.equal(heuristic.label, "Gemini/Vertex heuristic", id);
    assert.equal(heuristic.textDenominator, 4, id);
    assert.equal(heuristic.sessionDenominator, 4, id);
  }
});

test("wire compatibility does not select a tokenizer family", () => {
  for (const compatible of [
    model("kimi-coding", "unknown-coding-model", "anthropic-messages"),
    model("minimax", "MiniMax-M2.7", "anthropic-messages"),
    model("vercel-ai-gateway", "alibaba/qwen-3.5-plus", "anthropic-messages"),
  ]) {
    const heuristic = resolveHeuristic(compatible, {});
    assert.equal(heuristic.label, "fallback chars/4");
    assert.equal(heuristic.toolNumerator, "anthropic");
    assert.equal(heuristic.toolDenominator, 4);
  }

  const codex = resolveHeuristic(codexModel, {});
  assert.equal(codex.toolNumerator, "openai-cookbook");
  assert.equal(codex.toolDenominator, 5.5);
  const openai = resolveHeuristic(model("openai", "gpt-5.5", "openai-responses"), {});
  assert.equal(openai.label, "OpenAI Responses heuristic");
  assert.equal(openai.toolDenominator, 5.5);
  assert.equal(resolveHeuristic(model("zai", "glm-4.7", "openai-completions"), {}).toolDenominator, 4);
  assert.equal(resolveHeuristic(model("opencode", "qwen3-coder", "openai-responses"), {}).toolDenominator, 4);
  assert.equal(resolveHeuristic(model("google", "gemini-3.6-flash", "google-generative-ai"), {}).toolNumerator, "gemini");
  assert.equal(resolveHeuristic(model("amazon-bedrock", "amazon.nova-2-lite-v1:0", "bedrock-converse-stream"), {}).toolNumerator, "bedrock");
  const mistral = resolveHeuristic(model("mistral", "mistral-large", "mistral-conversations"), {});
  assert.equal(mistral.toolNumerator, "openai-chat");
  assert.equal(mistral.toolDenominator, 4);
});

test("precedence: defaults < built-in rule < config rules, in rule order", () => {
  const config: ContextimateConfig = { defaults: { textDenominator: 9 } };
  // Built-in model rule overrides flat config defaults.
  assert.equal(resolveHeuristic(anthropicModel, config).textDenominator, 2.6);
  // ...but defaults apply when no tokenizer profile matches.
  assert.equal(resolveHeuristic(undefined, config).textDenominator, 9);
  assert.equal(resolveHeuristic(model("kimi-coding", "kimi-latest", "anthropic-messages"), config).textDenominator, 9);
  assert.equal(resolveHeuristic(model("ollama", "llama-4", "llama-local-api"), config).textDenominator, 9);

  // Config rules override built-in rules; later rules override earlier ones.
  const ruled: ContextimateConfig = {
    rules: [
      { match: { provider: "anthropic" }, textDenominator: 7, label: "first" },
      { match: { model: "claude-*" }, textDenominator: 8, label: "second" },
      { match: { provider: "nomatch" }, textDenominator: 99, label: "never" },
    ],
  };
  const h = resolveHeuristic(anthropicModel, ruled);
  assert.equal(h.textDenominator, 8);
  assert.equal(h.label, "second");
  // Unpatched fields keep the built-in rule's values.
  assert.equal(h.toolNumerator, "anthropic");
});

test("rule matching: glob, regex, exact (case-insensitive)", () => {
  const base = (match: NonNullable<ContextimateConfig["rules"]>[number]["match"]): ContextimateConfig => ({
    rules: [{ match, textDenominator: 7 }],
  });
  assert.equal(resolveHeuristic(anthropicModel, base({ model: "claude-*" })).textDenominator, 7);
  assert.equal(resolveHeuristic(anthropicModel, base({ model: "/OPUS/i" })).textDenominator, 7);
  assert.equal(resolveHeuristic(anthropicModel, base({ provider: "ANTHROPIC" })).textDenominator, 7);
  assert.equal(resolveHeuristic(anthropicModel, base({ model: "gpt-*" })).textDenominator, 2.6); // no match → built-in
});

test("profiles apply via defaults.profile and rule.profile", () => {
  const config: ContextimateConfig = {
    profiles: { tight: { textDenominator: 5, label: "tight profile" } },
    defaults: { profile: "tight" },
  };
  assert.equal(resolveHeuristic(undefined, config).textDenominator, 5);

  const ruleProfile: ContextimateConfig = {
    profiles: { wide: { textDenominator: 6 } },
    rules: [{ match: { provider: "anthropic" }, profile: "wide" }],
  };
  assert.equal(resolveHeuristic(anthropicModel, ruleProfile).textDenominator, 6);
});

test("unknown provider keeps a defined label (regression: renderHeader crash)", () => {
  // applyHeuristicPatch used to let `label: undefined` clobber the fallback label,
  // crashing methodologyHint for providers with no built-in rule.
  const h = resolveHeuristic(model("ollama", "llama-4", "llama-local-api"), {});
  assert.equal(h.label, "fallback chars/4");
  const profiled = resolveHeuristic(anthropicModel, {
    profiles: { quiet: { textDenominator: 5 } },
    rules: [{ match: { provider: "anthropic" }, profile: "quiet" }],
  });
  assert.equal(profiled.label, "Claude 4.7+ heuristic", "label survives a label-less profile patch");
});

test("cleanDenominator rejects non-finite/non-positive values", () => {
  assert.equal(cleanDenominator(0), 4);
  assert.equal(cleanDenominator(-2), 4);
  assert.equal(cleanDenominator(Number.NaN), 4);
  assert.equal(cleanDenominator("3"), 4);
  assert.equal(cleanDenominator(undefined, 2.6), 2.6);
  assert.equal(cleanDenominator(3.3, 2.6), 3.3);
});

test("runtime config parsing drops invalid denominators before heuristic resolution", () => {
  const config = parseContextimateConfig({
    rules: [{ match: { provider: "anthropic" }, textDenominator: 0 }],
  });
  assert.deepEqual(config, { rules: [{ match: { provider: "anthropic" } }] });
  assert.equal(resolveHeuristic(anthropicModel, config).textDenominator, 2.6);
});
