import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { assistantMessage } from "../helpers.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { payloadTextAdditions } from "../../extensions/pi-contextimate/request-messages.ts";

function route<T extends Api>(api: T): Model<T> {
  return { provider: "fixture", id: "fixture", name: "Fixture", api, baseUrl: "http://127.0.0.1:9",
    reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

const saved = [{ role: "user" as const, content: "same", timestamp: 1 }];
const item = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });

test("payload attribution preserves duplicate occurrences and ignores system and tool material", async () => {
  const payload = { instructions: "not an addition", tools: [{ description: "nor this" }], input: [
    { role: "developer", content: [{ type: "input_text", text: "not session text" }] },
    item("same"), item("same"), item("extra"),
    { type: "function_call_output", output: "not user text" },
  ] };
  assert.deepEqual(await payloadTextAdditions(saved, payload, route("openai-codex-responses")), { chars: 9, additive: true });
});

test("deletions, replacements and reordering are not falsely presented as additive counts", async () => {
  assert.deepEqual(await payloadTextAdditions(saved, { input: [item("replacement")] }, route("openai-responses")),
    { additive: false });
  assert.deepEqual(await payloadTextAdditions(saved, { input: [] }, route("openai-responses")),
    { additive: false });
  assert.deepEqual(await payloadTextAdditions([...saved, { role: "user", content: "next", timestamp: 2 }],
    { input: [item("next"), item("same")] }, route("openai-responses")), { additive: false });
});

test("unknown routes and malformed payloads do not claim outgoing text coverage", async () => {
  for (const payload of [null, {}, { input: "not an array" }]) {
    assert.equal(await payloadTextAdditions(saved, payload, route("openai-responses")), undefined);
  }
  assert.equal(await payloadTextAdditions(saved, { input: [item("extra")] }, route("unknown-api")), undefined);
});

test("native OpenAI replay drops aborted replies without losing genuine additions", async () => {
  const model = route("openai-responses");
  const history = [...saved,
    assistantMessage([{ type: "text", text: "partial aborted reply" }], { stopReason: "aborted" }),
  ];
  const context = normalizeContext({ messages: history });
  const input = convertResponsesMessages(model, context, new Set());
  assert.deepEqual(await payloadTextAdditions(history, { input }, model), { chars: 0, additive: true });
  assert.deepEqual(await payloadTextAdditions(history, { input: [...input, item("injected")] }, model),
    { chars: 8, additive: true });
});

test("native Anthropic unsigned thinking is not counted a second time", async () => {
  const model = route("anthropic-messages");
  const history = [...saved, assistantMessage([
    { type: "thinking", thinking: "unsigned thinking" }, { type: "text", text: "reply" },
  ], { provider: model.provider, model: model.id, api: model.api })];
  let payload: unknown;
  const stream = streamAnthropic(model, normalizeContext({ messages: history }), { apiKey: "fixture-never-sent",
    onPayload: (body) => { payload = body; throw new Error("fixture stops before HTTP"); } });
  const response = await stream.result();
  assert.equal(response.stopReason, "error");
  assert.ok(payload);
  assert.deepEqual(await payloadTextAdditions(history, payload, model), { chars: 0, additive: true });
});

test("image conversions retain only hook coverage rather than mistaking generated captions for additions", async () => {
  const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
  const user = { role: "user" as const, content: [image], timestamp: 2 };
  assert.equal(await payloadTextAdditions([user], { input: [item("Image reading is disabled.")] }, route("openai-responses")), undefined);
  const tool = { role: "toolResult" as const, toolCallId: "call_abc|fc_def", toolName: "read",
    content: [image], isError: true, timestamp: 3 };
  assert.equal(await payloadTextAdditions([tool], { messages: [{ role: "user", content: "provider-generated caption" }] },
    route("anthropic-messages")), undefined);
});

test("Anthropic tool-result blocks and system instructions are not request-only conversation additions", async () => {
  const payload = { system: "instructions", messages: [
    { role: "user", content: [{ type: "text", text: "same" }, { type: "tool_result", content: "tool output" }] },
    { role: "assistant", content: [{ type: "text", text: "injected" }] },
  ] };
  assert.deepEqual(await payloadTextAdditions(saved, payload, route("anthropic-messages")), { chars: 8, additive: true });
});
