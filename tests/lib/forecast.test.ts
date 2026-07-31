// Unit tests for _lib/forecast.ts: target-currency prompt forecasting (issue #57).
// The transform rules themselves are pinned against the real pi-ai transformMessages
// in tests/contract/pi-transform-messages.test.ts; these tests cover the counting math.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  forecastHistoryForTarget,
  forecastTargetPrompt,
  type ForecastMessage,
  type TargetModel,
} from "../../extensions/_lib/forecast.ts";

const luna: TargetModel = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
  api: "openai-codex-responses",
  contextWindow: 272_000,
  input: ["text", "image"],
};

const opus: TargetModel = {
  provider: "anthropic",
  id: "claude-opus-4-8",
  api: "anthropic-messages",
  contextWindow: 200_000,
  input: ["text", "image"],
};

function solTurn(content: unknown[], overrides: Partial<ForecastMessage> = {}): ForecastMessage {
  return {
    role: "assistant",
    content,
    provider: "openai-codex",
    api: "openai-codex-responses",
    model: "gpt-5.6-sol",
    stopReason: "stop",
    ...overrides,
  };
}

test("cross-model: readable thinking counts as text, signatures count as dropped", () => {
  const history: ForecastMessage[] = [
    { role: "user", content: "hello there" }, // 11 chars
    solTurn([
      { type: "thinking", thinking: "readable summary", thinkingSignature: "X".repeat(400) },
      { type: "thinking", thinking: "  ", thinkingSignature: "Y".repeat(300) },
      { type: "text", text: "answer" },
    ]),
  ];
  const forecast = forecastHistoryForTarget(history, luna);
  assert.equal(forecast.textChars, 11 + "readable summary".length + "answer".length);
  assert.equal(forecast.keptReasoningChars, 0);
  assert.equal(forecast.droppedReasoningChars, 700, "both encrypted payloads drop for the foreign target");
  assert.equal(forecast.messageCount, 2);
});

test("same-model: signature payloads are kept, readable summary is not double-counted", () => {
  const history: ForecastMessage[] = [
    solTurn([
      { type: "thinking", thinking: "readable summary", thinkingSignature: "X".repeat(400) },
      { type: "text", text: "answer" },
    ]),
  ];
  const target: TargetModel = { ...luna, id: "gpt-5.6-sol" };
  const forecast = forecastHistoryForTarget(history, target);
  assert.equal(forecast.keptReasoningChars, 400, "same-model replay counts the encrypted payload, not the summary");
  assert.equal(forecast.textChars, "answer".length);
  assert.equal(forecast.droppedReasoningChars, 0);
});

test("redacted thinking: kept same-model, dropped cross-model", () => {
  const history = [solTurn([{ type: "thinking", thinking: "", thinkingSignature: "R".repeat(50), redacted: true }])];
  assert.equal(forecastHistoryForTarget(history, { ...luna, id: "gpt-5.6-sol" }).keptReasoningChars, 50);
  assert.equal(forecastHistoryForTarget(history, opus).droppedReasoningChars, 50);
});

test("toolCall: arguments always count, thoughtSignature only for the same model", () => {
  const call = { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" }, thoughtSignature: "T".repeat(80) };
  const argChars = JSON.stringify({ id: "t1", name: "read", arguments: { path: "/tmp/x" } }).length;
  const history = [solTurn([call], { stopReason: "toolUse" })];
  const cross = forecastHistoryForTarget(history, opus);
  assert.equal(cross.textChars, argChars);
  assert.equal(cross.droppedReasoningChars, 80);
  const same = forecastHistoryForTarget(history, { ...luna, id: "gpt-5.6-sol" });
  assert.equal(same.keptReasoningChars, 80);
});

test("aborted and error assistant turns contribute nothing", () => {
  const history = [
    solTurn([{ type: "text", text: "half an answer" }], { stopReason: "aborted" }),
    solTurn([{ type: "text", text: "failed" }], { stopReason: "error" }),
  ];
  const forecast = forecastHistoryForTarget(history, opus);
  assert.equal(forecast.textChars, 0);
  assert.equal(forecast.messageCount, 0);
});

test("images: pi's flat char convention for vision targets, placeholder for non-vision", () => {
  const history: ForecastMessage[] = [
    { role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
  ];
  const vision = forecastHistoryForTarget(history, luna);
  assert.equal(vision.imageCount, 1);
  assert.equal(vision.imageChars, 4800, "matches pi's compaction image estimate");
  const blind = forecastHistoryForTarget(history, { ...luna, input: ["text"] });
  assert.equal(blind.imageCount, 1);
  assert.ok(blind.imageChars < 100, "non-vision targets get a small placeholder");
});

test("tool results count text content", () => {
  const history: ForecastMessage[] = [
    { role: "toolResult", content: [{ type: "text", text: "result text" }] },
  ];
  assert.equal(forecastHistoryForTarget(history, luna).textChars, "result text".length);
});

test("forecastTargetPrompt composes system, tools and history in target currency", () => {
  const history: ForecastMessage[] = [
    { role: "user", content: "a".repeat(3500) },
    solTurn([
      { type: "thinking", thinking: "b".repeat(1000), thinkingSignature: "S".repeat(2000) },
      { type: "text", text: "c".repeat(500) },
    ]),
  ];
  const forecast = forecastTargetPrompt({
    history,
    systemPromptChars: 2600,
    tools: [],
    target: opus,
  });
  assert.equal(forecast.heuristic.label, "Claude 4.7+ heuristic");
  // 2600 system chars / 2.6 + (3500 + 1000 + 500) history chars / 2.6; the 2000-char
  // encrypted payload never reaches the anthropic target.
  assert.equal(forecast.tokens, 1000 + Math.ceil(5000 / 2.6));
});

test("forecastTargetPrompt uses the cookbook tool formula for codex targets", () => {
  const tools = [{ name: "read", description: "Read a file.", schema: { type: "object", properties: { path: { type: "string" } } } }];
  const withTools = forecastTargetPrompt({ history: [], systemPromptChars: 0, tools, target: luna });
  const withoutTools = forecastTargetPrompt({ history: [], systemPromptChars: 0, tools: [], target: luna });
  assert.equal(withTools.heuristic.label, "OpenAI-Codex heuristic");
  assert.ok(withTools.tokens > withoutTools.tokens + 12, "tool definitions must contribute the cookbook overhead");
});

test("unknown targets fall back to the family chars/4 heuristic", () => {
  const forecast = forecastTargetPrompt({
    history: [{ role: "user", content: "x".repeat(400) }],
    systemPromptChars: 0,
    tools: [],
    target: { provider: "acme", id: "mystery-1", api: "acme-chat" },
  });
  assert.equal(forecast.heuristic.label, "fallback chars/4");
  assert.equal(forecast.tokens, 100);
});
