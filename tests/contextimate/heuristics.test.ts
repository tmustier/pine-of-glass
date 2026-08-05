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

test("measured tokenizer families follow concrete models through serving routes", () => {
  const cases: Array<[ModelSummary, string, number, number]> = [
    [model("moonshotai", "kimi-k2-0905-preview", "openai-completions"), "Kimi tokenizer", 4.1, 3.8],
    [model("fireworks", "accounts/fireworks/routers/kimi-k2p6-fast", "anthropic-messages"), "Kimi tokenizer", 4.1, 3.8],
    [model("kimi-coding", "k3-256k", "anthropic-messages"), "Kimi tokenizer", 4.1, 3.8],
    [model("kimi-coding", "kimi-for-coding-highspeed", "anthropic-messages"), "Kimi tokenizer", 4.1, 3.8],
    [model("amazon-bedrock", "moonshot.kimi-k2-thinking", "bedrock-converse-stream"), "Kimi tokenizer", 4.1, 3.8],
    [model("openrouter", "z-ai/glm-4.5v", "openai-completions"), "GLM 4.5 tokenizer", 4, 3.9],
    [model("vercel-ai-gateway", "zai/glm-4.6v-flash", "anthropic-messages"), "GLM 4.5 tokenizer", 4, 3.9],
    [model("amazon-bedrock", "zai.glm-4.7", "bedrock-converse-stream"), "GLM 4.5 tokenizer", 4, 3.9],
    [model("openrouter", "z-ai/glm-4.7-flash", "openai-completions"), "GLM 5 tokenizer", 4, 3.9],
    [model("fireworks", "accounts/fireworks/routers/glm-5p2-fast", "openai-completions"), "GLM 5 tokenizer", 4, 3.9],
    [model("huggingface", "zai-org/GLM-5.1", "openai-completions"), "GLM 5 tokenizer", 4, 3.9],
    [model("openrouter", "cohere/command-r-plus-08-2024", "openai-completions"), "Command R tokenizer", 4, 3.4],
    [model("openrouter", "cohere/north-mini-code:free", "openai-completions"), "North Mini Code tokenizer", 4.2, 3.9],
    [model("opencode", "north-mini-code-free", "openai-completions"), "North Mini Code tokenizer", 4.2, 3.9],
    [model("xai", "grok-4.3", "openai-completions"), "Grok 4.20/4.3 tokenizer", 4.2, 3.9],
    [model("openrouter", "x-ai/grok-4.20", "openai-completions"), "Grok 4.20/4.3 tokenizer", 4.2, 3.9],
    [model("xai", "grok-4.20-0309-non-reasoning", "openai-completions"), "Grok 4.20/4.3 tokenizer", 4.2, 3.9],
    [model("vercel-ai-gateway", "xai/grok-4.20-multi-agent", "anthropic-messages"), "Grok 4.20/4.3 tokenizer", 4.2, 3.9],
    [model("xai", "grok-4.20-multi-agent-0309", "openai-completions"), "Grok 4.20/4.3 tokenizer", 4.2, 3.9],
    [model("opencode", "grok-build-0.1", "openai-completions"), "Grok 4.20/4.3 tokenizer", 4.2, 3.9],
    [model("xai", "grok-4.5", "openai-responses"), "Grok 4.5 tokenizer", 4.1, 3.6],
  ];

  for (const [current, label, textDenominator, sessionDenominator] of cases) {
    const heuristic = resolveHeuristic(current, {});
    assert.equal(heuristic.label, label, `${current.provider}/${current.id}`);
    assert.equal(heuristic.textDenominator, textDenominator, `${current.provider}/${current.id}`);
    assert.equal(heuristic.sessionDenominator, sessionDenominator, `${current.provider}/${current.id}`);
  }

  const relayedKimi = resolveHeuristic(
    model("fireworks", "accounts/fireworks/routers/kimi-k2p6-fast", "anthropic-messages"),
    {},
  );
  assert.equal(relayedKimi.toolNumerator, "anthropic");
  assert.equal(relayedKimi.toolDenominator, 4);
  const bedrockGlm = resolveHeuristic(model("amazon-bedrock", "zai.glm-4.7", "bedrock-converse-stream"), {});
  assert.equal(bedrockGlm.toolNumerator, "bedrock");
  const directGrok45 = resolveHeuristic(model("xai", "grok-4.5", "openai-responses"), {});
  assert.equal(directGrok45.toolNumerator, "openai-responses");
});

test("published tokenizer siblings stay inside their measured family boundary", () => {
  const families = [
    ["Kimi tokenizer", [
      "moonshotai/kimi-k2",
      "moonshotai/kimi-k2-0711-preview",
      "moonshotai/kimi-k2-0905",
      "moonshotai/kimi-k2-thinking-turbo",
      "moonshotai/kimi-k2.5",
      "@cf/moonshotai/kimi-k2.6",
      "moonshotai/kimi-k2.7-code-highspeed",
      "accounts/fireworks/models/kimi-k2p6",
      "accounts/fireworks/routers/kimi-k2p7-code-fast",
      "moonshotai/kimi-k3-fast",
    ]],
    ["GLM 4.5 tokenizer", [
      "z-ai/glm-4.5",
      "z-ai/glm-4.5-air",
      "z-ai/glm-4.5v",
      "z-ai/glm-4.6",
      "z-ai/glm-4.6v",
      "z-ai/glm-4.6v-flash",
      "zai-glm-4.7",
    ]],
    ["GLM 5 tokenizer", [
      "z-ai/glm-4.7-flash",
      "z-ai/glm-5",
      "z-ai/glm-5.1",
      "zai-org/glm-5.2",
      "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/routers/glm-5p2-fast",
    ]],
    ["Command R tokenizer", [
      "cohere/command-r-08-2024",
      "cohere/command-r-plus-08-2024",
    ]],
    ["North Mini Code tokenizer", [
      "cohere/north-mini-code:free",
      "north-mini-code-free",
      "coherelabs/north-mini-code-1.0",
    ]],
    ["Grok 4.20/4.3 tokenizer", [
      "x-ai/grok-4.20",
      "xai/grok-4.20-reasoning",
      "xai/grok-4.20-non-reasoning",
      "grok-4.20-0309-reasoning",
      "grok-4.20-multi-agent-0309",
      "xai.grok-4.3",
      "grok-build-0.1",
    ]],
    ["Grok 4.5 tokenizer", ["x-ai/grok-4.5"]],
  ] as const;

  for (const [label, ids] of families) {
    for (const id of ids) {
      assert.equal(resolveHeuristic(model("relay", id, "openai-completions"), {}).label, label, id);
    }
  }
});

test("dynamic selectors and unverified sibling models keep the fallback tokenizer", () => {
  for (const current of [
    model("openrouter", "~moonshotai/kimi-latest", "openai-completions"),
    model("openrouter", "~x-ai/grok-latest", "openai-completions"),
    model("radius", "auto", "pi-messages"),
    model("openrouter", "free", "openai-completions"),
    model("fireworks", "k3", "anthropic-messages"),
    model("openrouter", "z-ai/glm-4.7-flashx", "openai-completions"),
    model("zai", "glm-5-turbo", "openai-completions"),
    model("zai", "glm-5v-turbo", "openai-completions"),
    model("openrouter", "z-ai/glm-5.3", "openai-completions"),
    model("openrouter", "cohere/command-r", "openai-completions"),
    model("vercel-ai-gateway", "xai/grok-4.20-reasoning-beta", "anthropic-messages"),
    model("xai", "grok-build-latest", "openai-completions"),
    model("openrouter", "x-ai/grok-4.6", "openai-completions"),
  ]) {
    const heuristic = resolveHeuristic(current, {});
    assert.equal(heuristic.label, "fallback chars/4", `${current.provider}/${current.id}`);
    assert.equal(heuristic.textDenominator, 4, `${current.provider}/${current.id}`);
    assert.equal(heuristic.sessionDenominator, 4, `${current.provider}/${current.id}`);
  }

  const selector = resolveHeuristic(model("openrouter", "free", "openai-completions"), {});
  assert.equal(selector.toolNumerator, "openai-chat");
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
