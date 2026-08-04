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
  input: ["text", "image"],
};

const opus: TargetModel = {
  provider: "anthropic",
  id: "claude-opus-4-8",
  api: "anthropic-messages",
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

test("cross-model: readable thinking counts as text, encrypted payloads vanish", () => {
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
  assert.equal(forecast.keptReasoningChars, 0, "both encrypted payloads drop for the foreign target");
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
});

test("redacted thinking: kept same-model, dropped cross-model", () => {
  const history = [solTurn([{ type: "thinking", thinking: "", thinkingSignature: "R".repeat(50), redacted: true }])];
  assert.equal(forecastHistoryForTarget(history, { ...luna, id: "gpt-5.6-sol" }).keptReasoningChars, 50);
  assert.equal(forecastHistoryForTarget(history, opus).keptReasoningChars, 0);
});

test("toolCall: stored ID and arguments count, thoughtSignature only for the same model", () => {
  const id = "call|foreign/item";
  const call = { type: "toolCall", id, name: "read", arguments: { path: "/tmp/x" }, thoughtSignature: "T".repeat(80) };
  const argChars = JSON.stringify({ id, name: "read", arguments: { path: "/tmp/x" } }).length;
  const history = [solTurn([call], { stopReason: "toolUse" })];
  const cross = forecastHistoryForTarget(history, opus);
  assert.equal(cross.textChars, argChars);
  assert.equal(cross.keptReasoningChars, 0);
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
});

test("images: pi's flat char convention for vision targets, placeholder for non-vision", () => {
  const history: ForecastMessage[] = [
    { role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
  ];
  const vision = forecastHistoryForTarget(history, luna);
  assert.equal(vision.imageChars, 4800, "matches pi's compaction image estimate");
  const blind = forecastHistoryForTarget(history, { ...luna, input: ["text"] });
  assert.ok(blind.imageChars > 0 && blind.imageChars < 100, "non-vision targets get a small placeholder");
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

// --- calibration: source-anchored density correction ---------------------------------

const solSource: TargetModel = { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" };

test("calibration: the source's billed/estimated ratio re-prices the target estimate", () => {
  const history: ForecastMessage[] = [{ role: "user", content: "x".repeat(2600) }];
  // Source (codex, chars/4) estimate: 650 tokens; billed 975 → the content ran 1.5x
  // denser than the heuristic. Target (opus, chars/2.6) estimate: 1000 → 1500.
  const forecast = forecastTargetPrompt({
    history, systemPromptChars: 0, tools: [], target: opus,
    calibration: { source: solSource, billedPromptTokens: 975 },
  });
  assert.equal(forecast.calibration, 1.5);
  assert.equal(forecast.tokens, 1500);
});

test("calibration: the correction is clamped to 0.5..2", () => {
  const history: ForecastMessage[] = [{ role: "user", content: "x".repeat(2600) }];
  const args = { history, systemPromptChars: 0, tools: [], target: opus };
  assert.equal(forecastTargetPrompt({ ...args, calibration: { source: solSource, billedPromptTokens: 65_000 } }).tokens, 2000);
  assert.equal(forecastTargetPrompt({ ...args, calibration: { source: solSource, billedPromptTokens: 65 } }).tokens, 500);
});

test("calibration: skipped when encrypted reasoning dominates the source serialization", () => {
  const history: ForecastMessage[] = [
    { role: "user", content: "u".repeat(1500) },
    solTurn([
      { type: "thinking", thinking: "t".repeat(100), thinkingSignature: "S".repeat(2000) },
      { type: "text", text: "a".repeat(500) },
    ]),
  ];
  // Source serialization: 2000 payload chars vs 2000 text chars. The char length of an
  // encrypted payload is a convention, not a measurement — the ratio is untrusted.
  const forecast = forecastTargetPrompt({
    history, systemPromptChars: 0, tools: [], target: opus,
    calibration: { source: solSource, billedPromptTokens: 5_000 },
  });
  assert.equal(forecast.calibration, undefined);
  assert.equal(forecast.tokens, Math.ceil(2100 / 2.6));
});

test("calibration: absent or nonsensical anchors leave the heuristic estimate untouched", () => {
  const history: ForecastMessage[] = [{ role: "user", content: "x".repeat(2600) }];
  const plain = forecastTargetPrompt({ history, systemPromptChars: 0, tools: [], target: opus });
  const zero = forecastTargetPrompt({
    history, systemPromptChars: 0, tools: [], target: opus,
    calibration: { source: solSource, billedPromptTokens: 0 },
  });
  assert.equal(plain.calibration, undefined);
  assert.deepEqual(zero, plain);
});

test("calibration: dropped-thinking term prices what the source billed but the target loses", () => {
  const history: ForecastMessage[] = [
    { role: "user", content: "u".repeat(2600) },
    solTurn([
      { type: "thinking", thinking: "", thinkingSignature: "S".repeat(800) },
      { type: "text", text: "a".repeat(200) },
    ]),
  ];
  // Source serialization: 2800 text + 800 kept payload chars (share 0.22, inside the
  // guard). Source estimate ceil(3600/4) = 900; billed 1350 → ratio 1.5. Dropped
  // thinking: 800/4 × 1.5 = 300 for any different identity; only the exact source
  // provider, API and model keeps it.
  const cross = forecastTargetPrompt({
    history, systemPromptChars: 0, tools: [], target: opus,
    calibration: { source: solSource, billedPromptTokens: 1350 },
  });
  assert.equal(cross.calibration, 1.5);
  assert.equal(cross.droppedThinkingTokens, 300);
  const sameId = forecastTargetPrompt({
    history, systemPromptChars: 0, tools: [], target: { ...luna, id: "gpt-5.6-sol" },
    calibration: { source: solSource, billedPromptTokens: 1350 },
  });
  assert.equal(sameId.droppedThinkingTokens, 0);
  const sameIdOtherApi = forecastTargetPrompt({
    history, systemPromptChars: 0, tools: [], target: { ...luna, id: "gpt-5.6-sol", api: "openai-responses" },
    calibration: { source: solSource, billedPromptTokens: 1350 },
  });
  assert.equal(sameIdOtherApi.droppedThinkingTokens, 300);
});
