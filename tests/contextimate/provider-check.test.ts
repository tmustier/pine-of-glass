import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAnthropicFullRequest,
  buildAnthropicRequests,
  buildBedrockFullRequest,
  buildBedrockRequests,
  buildCohereRequests,
  buildGoogleFullRequest,
  buildGoogleRequests,
  buildKimiRequests,
  buildOpenAIFullRequest,
  buildOpenAIRequests,
  buildVertexRequests,
  buildZaiRequests,
  detectPayloadKind,
  geminiCountUrl,
  parsePayloadFile,
  PROVIDERS,
  summarizeCounts,
  vertexCountRequest,
} from "../../scripts/contextimate/provider-token-counts.ts";
import { isJsonObject } from "../../extensions/_lib/boundary.ts";
import { internals } from "../../extensions/pi-contextimate/index.ts";
import { anthropicModel, fakePi, fixtureSystemPrompt } from "../helpers.ts";

const { buildSnapshot, toolPayloadForShape } = internals;

function capturedAnthropicPayload() {
  const snapshot = buildSnapshot(fakePi(), () => fixtureSystemPrompt(), undefined, () => undefined, () => anthropicModel, {});
  const tools = snapshot.tools.slice(0, 3).map((tool) => {
    const payload = toolPayloadForShape(tool, "anthropic");
    assert.ok(isJsonObject(payload));
    return payload;
  });
  return {
    model: "claude-opus-4-8",
    max_tokens: 8192,
    system: [{ type: "text", text: fixtureSystemPrompt() }],
    messages: [{ role: "user", content: [{ type: "text", text: "real conversation" }] }],
    tools,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    metadata: { user_id: "fixture" },
  };
}

function rowsById<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

test("captured Pi payloads resolve to their wire shape", () => {
  assert.equal(detectPayloadKind(capturedAnthropicPayload()), "anthropic");
  assert.equal(detectPayloadKind({ model: "gpt-5.6", input: [{ role: "developer", content: "system" }] }), "openai-responses");
  assert.equal(detectPayloadKind({ model: "glm-4.7", messages: [], stream: true }), "openai-chat");
  assert.equal(detectPayloadKind({ model: "gemini-3.6-flash", contents: [], config: {} }), "google");
  assert.equal(detectPayloadKind({ modelId: "amazon.nova-2-lite-v1:0", messages: [] }), "bedrock");

  const first = capturedAnthropicPayload();
  const parsed = parsePayloadFile(`${JSON.stringify(first)}\n${JSON.stringify({ ...first, system: "later" })}\n`);
  assert.equal(parsed.kind, "anthropic");
  assert.deepEqual(parsed.payload.system, first.system);
});

test("Anthropic and OpenAI count the sections Pi sends", () => {
  const anthropic = capturedAnthropicPayload();
  const anthropicRows = rowsById(buildAnthropicRequests(anthropic));
  assert.deepEqual(anthropicRows.system.body.system, anthropic.system);
  assert.deepEqual(anthropicRows.tools.body.tools, anthropic.tools);
  assert.deepEqual(anthropicRows["tool:read"].body.tools, [anthropic.tools[0]]);
  const anthropicFull = buildAnthropicFullRequest(anthropic).body;
  assert.deepEqual(anthropicFull.messages, anthropic.messages);
  assert.deepEqual(anthropicFull.output_config, anthropic.output_config);
  assert.equal(anthropicFull.metadata, undefined);

  const openai = {
    model: "gpt-5.6",
    input: [
      { role: "developer", content: "You are a fixture." },
      { role: "user", content: [{ type: "input_text", text: "real" }] },
    ],
    tools: [{ type: "function", name: "ping", description: "Send a ping.", parameters: { type: "object" }, strict: null }],
    reasoning: { effort: "high" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_retention: "24h",
    max_output_tokens: 128,
    store: false,
  };
  const openaiRows = rowsById(buildOpenAIRequests(openai));
  assert.deepEqual(openaiRows.system.body.input, [openai.input[0], { role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  assert.deepEqual(openaiRows["tool:ping"].body.tools, openai.tools);
  const full = buildOpenAIFullRequest(openai).body;
  assert.deepEqual(full.input, openai.input);
  assert.deepEqual(full.reasoning, openai.reasoning);
  assert.equal(full.include, undefined);
  assert.equal(full.prompt_cache_retention, undefined);
  assert.equal(full.max_output_tokens, undefined);
  assert.equal(full.store, undefined);
});

test("Google count requests translate Pi SDK parameters", () => {
  const payload = {
    model: "gemini-3.6-flash",
    contents: [{ role: "user", parts: [{ text: "real" }] }],
    config: {
      systemInstruction: "system",
      tools: [{ functionDeclarations: [{ name: "ping", description: "Ping", parametersJsonSchema: { type: "object" } }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      maxOutputTokens: 128,
      thinkingConfig: { thinkingLevel: "HIGH" },
    },
  };
  const rows = rowsById(buildGoogleRequests(payload));
  assert.deepEqual(rows.system.body.generateContentRequest, {
    model: "models/gemini-3.6-flash",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: payload.config.systemInstruction,
  });
  assert.deepEqual(rows.tools.body.generateContentRequest, {
    model: "models/gemini-3.6-flash",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    tools: payload.config.tools,
    toolConfig: payload.config.toolConfig,
  });
  assert.deepEqual(rows["tool:ping"].body.generateContentRequest, rows.tools.body.generateContentRequest);
  assert.equal(rows.tools.chars, JSON.stringify(payload.config.tools[0]).length);
  assert.deepEqual(buildGoogleFullRequest(payload).body.generateContentRequest, {
    model: "models/gemini-3.6-flash",
    contents: payload.contents,
    systemInstruction: payload.config.systemInstruction,
    tools: payload.config.tools,
    toolConfig: payload.config.toolConfig,
    generationConfig: { maxOutputTokens: 128, thinkingConfig: payload.config.thinkingConfig },
  });
  const vertexBody = buildVertexRequests(payload)[0].body;
  assert.deepEqual(vertexBody, {
    model: "models/gemini-3.6-flash",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  });
  assert.equal(geminiCountUrl(rows.baseline.body), "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:countTokens");
  assert.deepEqual(vertexCountRequest(vertexBody, "project", "europe-west1"), {
    url: "https://europe-west1-aiplatform.googleapis.com/v1/projects/project/locations/europe-west1/publishers/google/models/gemini-3.6-flash:countTokens",
    body: { contents: vertexBody.contents },
  });
  const vertexTools = rowsById(buildVertexRequests(payload)).tools.body;
  assert.deepEqual(vertexCountRequest(vertexTools, "project", "europe-west1").body, {
    contents: vertexTools.contents,
    tools: vertexTools.tools,
  });
  assert.match(vertexCountRequest(vertexBody, "project", "global").url, /^https:\/\/aiplatform\.googleapis\.com\//);
  assert.match(vertexCountRequest(vertexBody, "project", "eu").url, /^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\//);
});

test("Bedrock, Kimi, Cohere and Z.AI builders match their count APIs", () => {
  const bedrock = {
    modelId: "amazon.nova-2-lite-v1:0",
    messages: [{ role: "user", content: [{ text: "real" }] }],
    system: [{ text: "system" }],
    toolConfig: {
      tools: [{ toolSpec: { name: "ping", description: "Ping", inputSchema: { json: { type: "object" } } } }],
      toolChoice: { auto: {} },
    },
  };
  const bedrockRows = rowsById(buildBedrockRequests(bedrock));
  assert.deepEqual(bedrockRows.baseline.body, {
    modelId: bedrock.modelId,
    input: { converse: { messages: [{ role: "user", content: [{ text: "hi" }] }] } },
  });
  assert.deepEqual(bedrockRows["tool:ping"].body, {
    modelId: bedrock.modelId,
    input: { converse: { messages: [{ role: "user", content: [{ text: "hi" }] }], toolConfig: bedrock.toolConfig } },
  });
  assert.deepEqual(buildBedrockFullRequest(bedrock).body, {
    modelId: bedrock.modelId,
    input: { converse: { messages: bedrock.messages, system: bedrock.system, toolConfig: bedrock.toolConfig } },
  });

  const chat = {
    model: "glm-4.7",
    messages: [{ role: "system", content: "system" }, { role: "user", content: "real" }],
    tools: [{ type: "function", function: { name: "ping", description: "Ping", parameters: { type: "object" } } }],
  };
  const kimi = rowsById(buildKimiRequests({ ...chat, model: "kimi-k3" }));
  assert.deepEqual(kimi.system.body.messages, [chat.messages[0], { role: "user", content: "hi" }]);
  assert.equal(kimi.tools, undefined);

  const cohere = buildCohereRequests({
    ...chat,
    messages: [
      { role: "system", content: [{ type: "text", text: "first" }, { type: "text", text: " second" }] },
      { role: "system", content: "third" },
      chat.messages[1],
    ],
  }, { model: "command-r-08-2024" });
  assert.deepEqual(cohere, [{
    id: "system",
    label: "raw system text",
    body: { model: "command-r-08-2024", text: "first second\nthird" },
    chars: 18,
  }]);
  assert.throws(
    () => buildCohereRequests({ model: "command-r-08-2024", messages: [{ role: "user", content: "hi" }] }),
    /no system message text/,
  );

  assert.deepEqual(rowsById(buildZaiRequests(chat))["tool:ping"].body.tools, chat.tools);
});

test("Cohere live counting validates the raw tokenizer response", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.COHERE_API_KEY;
  process.env.COHERE_API_KEY = "fixture-key";
  let malformed = false;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.cohere.com/v1/tokenize");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, {
      "content-type": "application/json",
      authorization: "Bearer fixture-key",
    });
    assert.equal(init?.body, JSON.stringify({ model: "command-r-08-2024", text: "system" }));
    return Response.json(malformed ? { tokens: [1, "bad"] } : { tokens: [1, 2, 3] });
  };

  try {
    assert.equal(await PROVIDERS.cohere.execute({ model: "command-r-08-2024", text: "system" }), 3);
    malformed = true;
    await assert.rejects(
      PROVIDERS.cohere.execute({ model: "command-r-08-2024", text: "system" }),
      /no numeric tokens array/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.COHERE_API_KEY;
    else process.env.COHERE_API_KEY = originalKey;
  }
});

test("summary removes the shared tool-block overhead", () => {
  const requests = buildAnthropicRequests(capturedAnthropicPayload());
  const counts = {
    baseline: 10,
    system: 110,
    tools: 410,
    "tool:read": 210,
    "tool:bash": 220,
    "tool:search": 230,
    full: 510,
  };
  const summary = summarizeCounts(requests, counts);
  const rows = rowsById(summary.rows);
  assert.equal(summary.toolOverhead, 115);
  assert.equal(rows["tool:read"].netTokens, 85);
  assert.equal(rows.tools.netTokens, 285);
  assert.ok(rows.system.chars !== undefined);
  assert.equal(summary.suggestedHeuristic.textDenominator, Number((rows.system.chars / 100).toFixed(2)));
});
