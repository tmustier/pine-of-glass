// Unit tests for _lib/heuristics.ts rule selection: model ids must land on the rule
// for their tokenizer family, especially across the 3-5/4-5/5 generation boundary.
import { test } from "node:test";
import assert from "node:assert/strict";

import { builtInHeuristicForModel } from "../../extensions/_lib/heuristics.ts";

const anthropic = (id: string) => ({ provider: "anthropic", id, api: "anthropic-messages" });

test("claude 5-generation ids get the Claude 5 heuristic", () => {
  assert.equal(builtInHeuristicForModel(anthropic("claude-fable-5"))?.label, "Claude 5 heuristic");
  assert.equal(builtInHeuristicForModel(anthropic("claude-opus-5"))?.label, "Claude 5 heuristic");
  assert.equal(builtInHeuristicForModel(anthropic("claude-opus-5-20260601"))?.label, "Claude 5 heuristic");
  assert.equal(builtInHeuristicForModel(anthropic("claude-fable-5"))?.sessionDenominator, 2.6);
});

test("4.x and 3.5 ids keep their own rules despite trailing 5s", () => {
  assert.equal(builtInHeuristicForModel(anthropic("claude-opus-4-5"))?.label, "Claude 4.5/4.6 heuristic");
  assert.equal(builtInHeuristicForModel(anthropic("claude-opus-4-8"))?.label, "Claude 4.7+ heuristic");
  assert.equal(builtInHeuristicForModel(anthropic("claude-3-5-sonnet-20241022"))?.label, "Anthropic heuristic");
});

test("codex ids are untouched by the claude rules", () => {
  assert.equal(
    builtInHeuristicForModel({ provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" })?.label,
    "OpenAI-Codex heuristic",
  );
});
