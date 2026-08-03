import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import { accountProviderContext } from "../../extensions/pi-contextimate/session-accounting.ts";
import { assistantMessage } from "../helpers.ts";

const { buildSessionBreakdown } = internals;

function usage(reasoning: number, promptTokens = 20000, output = reasoning + 10) {
  return {
    input: promptTokens,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning,
    totalTokens: promptTokens + output,
    cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function encryptedReasoning(id: string): string {
  return JSON.stringify({ type: "reasoning", id, encrypted_content: `opaque-${id}` });
}

test("Claude reasoning follows keep-all, current-turn and exact-identity boundaries", () => {
  const keepAll = SessionManager.inMemory("/tmp/contextimate-anthropic-thinking");
  keepAll.appendMessage({ role: "user", content: "first", timestamp: 1 });
  keepAll.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "think", thinkingSignature: "signed-first" }],
    { model: "claude-fable-5", usage: usage(800) },
  ));
  keepAll.appendMessage({ role: "user", content: "second", timestamp: 2 });
  keepAll.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { model: "claude-fable-5", usage: usage(25) },
  ));
  const keepAllBreakdown = buildSessionBreakdown(keepAll)!;
  assert.equal(keepAllBreakdown.thinkingSummaryChars, 0);
  assert.equal(keepAllBreakdown.reasoningTokens, 825);
  assert.equal(keepAllBreakdown.contextUsageEstimated, false);

  keepAll.appendMessage({ role: "user", content: "trailing", timestamp: 3 });
  const trailing = buildSessionBreakdown(keepAll)!;
  assert.equal(trailing.contextUsageEstimated, true);
  assert.equal(trailing.reasoningTokens, 825);

  const currentTurn = SessionManager.inMemory("/tmp/contextimate-last-turn-thinking");
  currentTurn.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: "signed-old" }],
    { model: "claude-opus-4-4", usage: usage(100) },
  ));
  currentTurn.appendMessage({ role: "user", content: "second", timestamp: 2 });
  currentTurn.appendMessage(assistantMessage(
    [
      { type: "thinking", thinking: "new", thinkingSignature: "signed-new" },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ],
    { model: "claude-opus-4-4", usage: usage(20), stopReason: "toolUse" },
  ));
  currentTurn.appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "lookup",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 3,
  });
  currentTurn.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { model: "claude-opus-4-4", usage: usage(30) },
  ));
  const currentTurnBreakdown = buildSessionBreakdown(currentTurn)!;
  assert.equal(currentTurnBreakdown.reasoningTokens, 50);
  assert.equal(currentTurnBreakdown.thinkingSummaryChars, 0);

  const changedModel = SessionManager.inMemory("/tmp/contextimate-changed-model-thinking");
  changedModel.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "think", thinkingSignature: "signed-fable" }],
    { model: "claude-fable-5", usage: usage(800) },
  ));
  changedModel.appendMessage({ role: "user", content: "next", timestamp: 2 });
  changedModel.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { model: "claude-opus-4-8", usage: usage(25) },
  ));
  const changedBreakdown = buildSessionBreakdown(changedModel)!;
  assert.equal(changedBreakdown.reasoningTokens, 25);
  assert.equal(changedBreakdown.thinkingSummaryChars, 5);
});

test("raw GPT-5.5 Codex usage restores replayed reasoning exactly once", () => {
  const session = SessionManager.inMemory("/tmp/contextimate-raw-codex-usage");
  session.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "summary", thinkingSignature: encryptedReasoning("rs_raw") }],
    {
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.5",
      usage: usage(216, 578, 228),
    },
  ));
  session.appendMessage({ role: "user", content: "next", timestamp: 2 });
  session.appendMessage(assistantMessage(
    [{ type: "text", text: "OK" }],
    {
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.5",
      usage: usage(0, 598, 5),
    },
  ));

  const breakdown = buildSessionBreakdown(session)!;
  assert.equal(breakdown.reasoningTokens, 216);
  assert.equal(breakdown.providerOmittedReasoningTokens, 216);
  assert.deepEqual(accountProviderContext(breakdown, 603), { tokens: 819, corrected: true });
});

test("GPT-5.6 Codex totals already include replayed reasoning", () => {
  const session = SessionManager.inMemory("/tmp/contextimate-codex-5-6-thinking");
  session.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "summary", thinkingSignature: encryptedReasoning("rs_1") }],
    { api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: usage(900) },
  ));
  session.appendMessage({ role: "user", content: "next", timestamp: 2 });
  session.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: usage(100) },
  ));
  const breakdown = buildSessionBreakdown(session)!;
  assert.equal(breakdown.reasoningTokens, 1000);
  assert.equal(breakdown.providerOmittedReasoningTokens, undefined);
});

test("only measured Codex routes correct the provider total", () => {
  const responses = SessionManager.inMemory("/tmp/contextimate-openai-responses");
  responses.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: encryptedReasoning("rs_old") }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: usage(600) },
  ));
  responses.appendMessage({ role: "user", content: "next", timestamp: 2 });
  responses.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: usage(40) },
  ));
  const breakdown = buildSessionBreakdown(responses)!;
  assert.equal(breakdown.reasoningTokens, 640);
  assert.equal(breakdown.providerOmittedReasoningTokens, undefined);

  const idOnly = SessionManager.inMemory("/tmp/contextimate-openai-id-only-reasoning");
  idOnly.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: JSON.stringify({ id: "rs_missing" }) }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usage(600) },
  ));
  idOnly.appendMessage({ role: "user", content: "next", timestamp: 2 });
  idOnly.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usage(40) },
  ));
  assert.equal(buildSessionBreakdown(idOnly)!.reasoningTokens, 40);
});

test("Gemini retains reasoning behind text and tool thought signatures", () => {
  const textCarrier = SessionManager.inMemory("/tmp/contextimate-gemini-thinking");
  textCarrier.appendMessage(assistantMessage(
    [{ type: "text", text: "first", textSignature: "QUJDRA==" }],
    { api: "google-generative-ai", provider: "google", model: "gemini-3-pro", usage: usage(600) },
  ));
  textCarrier.appendMessage({ role: "user", content: "next", timestamp: 2 });
  textCarrier.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "google-generative-ai", provider: "google", model: "gemini-3-pro", usage: usage(50) },
  ));
  assert.equal(buildSessionBreakdown(textCarrier)!.reasoningTokens, 650);

  const toolCarrier = SessionManager.inMemory("/tmp/contextimate-gemini-tool-signature");
  toolCarrier.appendMessage(assistantMessage(
    [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {}, thoughtSignature: "QUJDRA==" }],
    {
      api: "google-vertex",
      provider: "google",
      model: "gemini-3-pro",
      usage: usage(300),
      stopReason: "toolUse",
    },
  ));
  toolCarrier.appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "lookup",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: 2,
  });
  toolCarrier.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "google-vertex", provider: "google", model: "gemini-3-pro", usage: usage(50) },
  ));
  assert.equal(buildSessionBreakdown(toolCarrier)!.reasoningTokens, 350);
});
