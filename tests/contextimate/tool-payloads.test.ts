// Provider payload shaping + the OpenAI cookbook-style formula. The displayed token
// number is only as honest as these shapes; the formula constants are pinned against
// hand-computed expectations so "harmless" refactors cannot drift them.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import type { ToolSummary } from "../../extensions/pi-contextimate/index.ts";

const {
  toolPayloadForShape,
  aggregateToolPayloadForShape,
  buildToolNumerator,
  buildToolDisplayEstimate,
  estimateOpenAIToolDefinitionTokens,
  estimateOpenAIFunctionToolTokens,
  resolveHeuristic,
} = internals;

const ping: ToolSummary = {
  name: "ping",
  description: "Send a ping.",
  source: "builtin",
  schema: {
    type: "object",
    properties: { host: { type: "string", description: "Target host" } },
    required: ["host"],
  },
  promptGuidelines: [],
};

const mode: ToolSummary = {
  name: "mode",
  description: "Pick a mode",
  source: "builtin",
  schema: {
    type: "object",
    properties: { level: { type: "string", enum: ["a", "bb"], description: "" } },
  },
  promptGuidelines: [],
};

test("per-provider payload shapes are exact", () => {
  assert.deepEqual(toolPayloadForShape(ping, "anthropic"), {
    name: "ping",
    description: "Send a ping.",
    input_schema: ping.schema,
  });
  assert.deepEqual(toolPayloadForShape(ping, "openai-responses"), {
    type: "function",
    name: "ping",
    description: "Send a ping.",
    parameters: ping.schema,
    strict: null,
  });
  assert.deepEqual(toolPayloadForShape(ping, "openai-chat"), {
    type: "function",
    function: { name: "ping", description: "Send a ping.", parameters: ping.schema, strict: null },
  });
  assert.deepEqual(toolPayloadForShape(ping, "bedrock"), {
    toolSpec: { name: "ping", description: "Send a ping.", inputSchema: { json: ping.schema } },
  });
  assert.deepEqual(toolPayloadForShape(ping, "pi-messages"), {
    name: "ping",
    description: "Send a ping.",
    parameters: ping.schema,
  });
  // Gemini aggregates into one functionDeclarations wrapper.
  assert.deepEqual(aggregateToolPayloadForShape([ping, mode], "gemini"), {
    functionDeclarations: [
      { name: "ping", description: "Send a ping.", parametersJsonSchema: ping.schema },
      { name: "mode", description: "Pick a mode", parametersJsonSchema: mode.schema },
    ],
  });
});

test("unknown shapes fall back to the OpenAI Responses payload", () => {
  assert.deepEqual(toolPayloadForShape(ping, "some-future-shape"), toolPayloadForShape(ping, "openai-responses"));
});

test("OpenAI cookbook formula matches hand-computed expectations", () => {
  // ping: 7 + ceil(len("ping:Send a ping")/6.6)=3 + 3(props) + [3 + ceil(len("host:string:Target host")/6.6)=4] = 20
  assert.equal(estimateOpenAIToolDefinitionTokens(ping), 20);
  // mode: 7 + ceil(len("mode:Pick a mode")/6.6)=3 + 3(props)
  //   + [3 + (-3 + (3+1) + (3+1)) + ceil(len("level:string:")/6.6)=2] = 23
  assert.equal(estimateOpenAIToolDefinitionTokens(mode), 23);
  // Aggregate adds +12 once.
  assert.equal(estimateOpenAIFunctionToolTokens([ping]), 32);
  assert.equal(estimateOpenAIFunctionToolTokens([ping, mode]), 55);
  assert.equal(estimateOpenAIFunctionToolTokens([]), 0);
});

test("displayed per-tool estimates count the same payload the section total counts", () => {
  // Anthropic shape: the aggregate content must be exactly the JSON array of the
  // per-tool payloads that buildToolDisplayEstimate measures.
  const heuristic = resolveHeuristic({ provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages" }, {});
  const numerator = buildToolNumerator([ping, mode], heuristic);
  const perTool = [ping, mode].map((tool) => JSON.stringify(toolPayloadForShape(tool, "anthropic")));
  assert.equal(numerator.content, `[${perTool.join(",")}]`);
  for (const tool of [ping, mode]) {
    const estimate = buildToolDisplayEstimate(tool, heuristic);
    assert.equal(estimate.chars, JSON.stringify(toolPayloadForShape(tool, "anthropic")).length);
    assert.equal(estimate.tokens, Math.ceil(estimate.chars / heuristic.toolDenominator));
  }

  // Cookbook shape: per-tool display uses the per-tool formula; the section total is the
  // sum of per-tool formulas + the once-per-request constant.
  const codexHeuristic = resolveHeuristic({ provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" }, {});
  const codexNumerator = buildToolNumerator([ping, mode], codexHeuristic);
  const perToolTokens = [ping, mode].map((tool) => buildToolDisplayEstimate(tool, codexHeuristic).tokens);
  assert.equal(codexNumerator.tokens, perToolTokens.reduce((a, b) => a + b, 0) + 12);
});
