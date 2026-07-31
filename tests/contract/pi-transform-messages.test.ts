// Contract tests: the size-material rules of pi-ai's transformMessages that
// _lib/forecast.ts mirrors for the model-switch prompt forecast (issue #57).
// The forecast cannot import transformMessages at runtime (pi's loader only aliases
// the compat surface, and compiled binaries have no filesystem resolution), so this
// suite pins the mirror against the real function through the repo's node_modules.
// When one of these fails after `pi update`, update extensions/_lib/forecast.ts to match.
import { test } from "node:test";
import assert from "node:assert/strict";

import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { Message, Model, Api } from "@earendil-works/pi-ai";

import { assistantMessage } from "../helpers.ts";

function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    ...overrides,
  } as Model<Api>;
}

const anthropicModel = fakeModel({
  id: "claude-opus-4-8",
  api: "anthropic-messages",
  provider: "anthropic",
  contextWindow: 200_000,
});

type AssistantContent = Extract<Message, { role: "assistant" }>["content"];

function contentTypes(message: Message): string[] {
  return Array.isArray(message.content)
    ? (message.content as Array<{ type: string }>).map((block) => block.type)
    : [];
}

test("cross-model transform: readable thinking becomes text, encrypted payloads drop", () => {
  // A Sol-style turn switching to Luna: same provider+api, different model id.
  const solTurn = assistantMessage(
    [
      { type: "thinking", thinking: "readable summary", thinkingSignature: "ENCRYPTED" },
      { type: "thinking", thinking: "", thinkingSignature: "SIGNATURE-ONLY" },
      { type: "text", text: "the answer" },
    ] as AssistantContent,
    { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-sol" },
  );
  const out = transformMessages([solTurn], fakeModel());
  assert.equal(out.length, 1, "cross-model turns are transformed, not dropped");
  assert.deepEqual(
    contentTypes(out[0]),
    ["text", "text"],
    "readable thinking must convert to text and signature-only thinking must vanish — forecast countThinking mirrors this",
  );
  const texts = (out[0].content as Array<{ type: string; text?: string }>).map((block) => block.text);
  assert.ok(texts[0]?.includes("readable summary"), "converted thinking keeps the readable chars the forecast counts");
  assert.equal(texts[1], "the answer");
});

test("cross-model transform: redacted thinking is dropped entirely", () => {
  const turn = assistantMessage(
    [
      { type: "thinking", thinking: "", thinkingSignature: "REDACTED-PAYLOAD", redacted: true },
      { type: "text", text: "visible" },
    ] as AssistantContent,
    { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-4-8" },
  );
  const out = transformMessages([turn], fakeModel());
  assert.deepEqual(contentTypes(out[0]), ["text"], "redacted thinking must drop cross-model — forecast droppedReasoningChars mirrors this");
});

test("same-model transform: signature-bearing thinking is kept for replay", () => {
  const turn = assistantMessage(
    [{ type: "thinking", thinking: "readable", thinkingSignature: "ENCRYPTED" }, { type: "text", text: "hi" }] as AssistantContent,
    { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-4-8" },
  );
  const out = transformMessages([turn], anthropicModel);
  assert.deepEqual(contentTypes(out[0]), ["thinking", "text"], "same-model thinking must survive — forecast keptReasoningChars mirrors this");
});

test("cross-model transform: toolCall thoughtSignature is stripped", () => {
  const turn = assistantMessage(
    [
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" }, thoughtSignature: "TOOL-THOUGHT" },
    ] as AssistantContent,
    { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-sol", stopReason: "toolUse" },
  );
  const out = transformMessages([turn], fakeModel());
  const call = (out[0].content as Array<{ type: string; thoughtSignature?: string }>).find((block) => block.type === "toolCall");
  assert.ok(call, "tool call survives cross-model");
  assert.equal(call.thoughtSignature, undefined, "thoughtSignature must strip cross-model — forecast never counts it for a foreign target");
});

test("transform skips aborted and error assistant turns", () => {
  const messages: Message[] = [
    { role: "user", content: "hello", timestamp: 1 } as Message,
    assistantMessage([{ type: "text", text: "half an answer" }] as AssistantContent, { stopReason: "aborted" }),
    assistantMessage([{ type: "text", text: "failed" }] as AssistantContent, { stopReason: "error", errorMessage: "boom" }),
  ];
  const out = transformMessages(messages, anthropicModel);
  assert.equal(out.filter((message) => message.role === "assistant").length, 0, "aborted/error turns must vanish — forecast skips them");
});

test("non-vision target: images become placeholder text", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 1 } as Message,
  ];
  const out = transformMessages(messages, fakeModel({ input: ["text"] }));
  const types = contentTypes(out[0]);
  assert.ok(!types.includes("image"), "images must not reach a non-vision target");
  assert.ok(types.includes("text"), "a small text placeholder replaces the image — forecast counts placeholder chars");
});
