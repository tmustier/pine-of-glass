// Provider payload formats + the OpenAI tool render, checked against measured counts.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateToolPayload, toolPayload, estimateOpenAIToolDefinitionTokens,
  estimateOpenAIFunctionToolTokens, type ToolDefinition,
} from "../../extensions/_lib/tool-payloads.ts";

const ping: ToolDefinition = {
  name: "ping",
  description: "Send a ping.",
  schema: {
    type: "object",
    properties: { host: { type: "string", description: "Target host" } },
    required: ["host"],
  },
};

const mode: ToolDefinition = {
  name: "mode",
  description: "Pick a mode",
  schema: {
    type: "object",
    properties: { level: { type: "string", enum: ["a", "bb"], description: "" } },
  },
};

test("per-provider payload formats are exact", () => {
  assert.deepEqual(toolPayload(ping, "anthropic"), {
    name: "ping",
    description: "Send a ping.",
    input_schema: ping.schema,
  });
  assert.deepEqual(toolPayload(ping, "openai-responses"), {
    type: "function",
    name: "ping",
    description: "Send a ping.",
    parameters: ping.schema,
    strict: null,
  });
  assert.deepEqual(toolPayload(ping, "openai-chat"), {
    type: "function",
    function: { name: "ping", description: "Send a ping.", parameters: ping.schema, strict: null },
  });
  assert.deepEqual(toolPayload(ping, "bedrock"), {
    toolSpec: { name: "ping", description: "Send a ping.", inputSchema: { json: ping.schema } },
  });
  assert.deepEqual(toolPayload(ping, "pi-messages"), {
    name: "ping",
    description: "Send a ping.",
    parameters: ping.schema,
  });
  assert.deepEqual(aggregateToolPayload([ping, mode], "gemini"), {
    functionDeclarations: [
      { name: "ping", description: "Send a ping.", parametersJsonSchema: ping.schema },
      { name: "mode", description: "Pick a mode", parametersJsonSchema: mode.schema },
    ],
  });
});

test("unknown formats fall back to the OpenAI Responses payload", () => {
  assert.deepEqual(toolPayload(ping, "some-future-format"), toolPayload(ping, "openai-responses"));
});

test("OpenAI tool render tracks provider-measured counts", () => {
  const measured = JSON.parse(readFileSync(new URL("../fixtures/openai-codex-tool-counts.json", import.meta.url), "utf8"));
  const tools: Array<ToolDefinition & { measuredTokens: number }> = measured.tools;
  for (const tool of tools) {
    const estimate = estimateOpenAIToolDefinitionTokens(tool);
    assert.ok(Math.abs(estimate - tool.measuredTokens) <= tool.measuredTokens * 0.15, `${tool.name}: ${estimate} vs ${tool.measuredTokens}`);
  }
  const total = measured.blockTokens + tools.reduce((sum, tool) => sum + tool.measuredTokens, 0);
  const estimate = estimateOpenAIFunctionToolTokens(tools);
  assert.ok(Math.abs(estimate - total) <= total * 0.02, `${estimate} vs ${total}`);
});
