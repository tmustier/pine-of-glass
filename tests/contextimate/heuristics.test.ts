// Heuristic resolution precedence and built-in model routing. A precedence bug here
// silently misprices every row in the estimator, so each layer is pinned explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import type { ContextimateConfig, ModelSummary } from "../../extensions/pi-contextimate/index.ts";
import { anthropicModel, codexModel } from "../helpers.ts";

const { resolveHeuristic, cleanDenominator } = internals;

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

test("built-in model routing boundaries", () => {
  // Claude 4.7/4.8 family.
  assert.equal(resolveHeuristic(anthropicModel, {}).label, "Claude 4.7+ heuristic");
  assert.equal(resolveHeuristic(anthropicModel, {}).textDenominator, 2.6);
  // Claude 4.5/4.6 family.
  const sonnet45 = resolveHeuristic(model("anthropic", "claude-sonnet-4-5", "anthropic-messages"), {});
  assert.equal(sonnet45.label, "Claude 4.5/4.6 heuristic");
  assert.equal(sonnet45.textDenominator, 3.8);
  assert.equal(sonnet45.toolDenominator, 3.3);
  // "3-5" must NOT match the 4.5/4.6 regex — falls through to generic Anthropic.
  const haiku35 = resolveHeuristic(model("anthropic", "claude-haiku-3-5", "anthropic-messages"), {});
  assert.equal(haiku35.label, "Anthropic heuristic");
  assert.equal(haiku35.textDenominator, 3.5);
  // Codex routes to the cookbook formula.
  const codex = resolveHeuristic(codexModel, {});
  assert.equal(codex.label, "OpenAI-Codex heuristic");
  assert.equal(codex.toolNumerator, "openai-cookbook");
  assert.equal(codex.toolDenominator, 5.5);
  // Other providers.
  assert.equal(resolveHeuristic(model("openai", "gpt-5.5", "openai-responses"), {}).label, "OpenAI Responses heuristic");
  assert.equal(resolveHeuristic(model("google", "gemini-2.5-pro", "google-generative-ai"), {}).toolNumerator, "gemini");
  assert.equal(resolveHeuristic(model("bedrock", "claude-x", "bedrock-converse-stream"), {}).toolNumerator, "bedrock");
  assert.equal(resolveHeuristic(model("mistral", "mistral-large", "mistral-conversations"), {}).toolNumerator, "openai-chat");
});

test("precedence: defaults < built-in rule < config rules, in rule order", () => {
  const config: ContextimateConfig = { defaults: { textDenominator: 9 } };
  // Built-in model rule overrides flat config defaults.
  assert.equal(resolveHeuristic(anthropicModel, config).textDenominator, 2.6);
  // ...but defaults apply when no built-in rule matches.
  assert.equal(resolveHeuristic(undefined, config).textDenominator, 9);

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

test("invalid config denominators fall back instead of poisoning estimates", () => {
  const h = resolveHeuristic(anthropicModel, { rules: [{ match: { provider: "anthropic" }, textDenominator: 0 }] });
  assert.equal(h.textDenominator, 2.6); // keeps the built-in value
});
