import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import { assistantMessage } from "../helpers.ts";

const { buildSessionBreakdown } = internals;

function usageWithReasoning(reasoning: number, promptTokens = 20000, cacheRead = 0) {
  return {
    input: promptTokens - cacheRead,
    output: reasoning + 10,
    cacheRead,
    cacheWrite: 0,
    reasoning,
    totalTokens: promptTokens + reasoning + 10,
    cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function encryptedReasoning(id: string): string {
  return JSON.stringify({ type: "reasoning", id, encrypted_content: `opaque-${id}` });
}

function usageWithoutReasoning(promptTokens: number, output = 10) {
  return {
    input: promptTokens,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: promptTokens + output,
    cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

test("Claude reasoning follows keep-all, current-turn and exact-identity boundaries", () => {
  const keepAll = SessionManager.inMemory("/tmp/contextimate-anthropic-thinking");
  keepAll.appendMessage({ role: "user", content: "first", timestamp: 1 });
  keepAll.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "think", thinkingSignature: "signed-first" }],
    { model: "claude-fable-5", usage: usageWithReasoning(800) },
  ));
  keepAll.appendMessage({ role: "user", content: "second", timestamp: 2 });
  keepAll.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { model: "claude-fable-5", usage: usageWithReasoning(25) },
  ));
  const keepAllBreakdown = buildSessionBreakdown(keepAll)!;
  assert.equal(keepAllBreakdown.thinkingSummaryChars, 0, "exact retained reasoning covers the summary");
  assert.equal(keepAllBreakdown.reasoningTokens, 825, "Fable keeps every same-model turn");
  assert.equal(keepAllBreakdown.contextUsageEstimated, false);

  keepAll.appendMessage({ role: "user", content: "trailing", timestamp: 3 });
  const trailing = buildSessionBreakdown(keepAll)!;
  assert.equal(trailing.contextUsageEstimated, true);
  assert.equal(trailing.reasoningTokens, 825, "a local estimate preserves the last provider anchor");

  const currentTurn = SessionManager.inMemory("/tmp/contextimate-last-turn-thinking");
  currentTurn.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: "signed-old" }],
    { model: "claude-opus-4-4", usage: usageWithReasoning(100) },
  ));
  currentTurn.appendMessage({ role: "user", content: "second", timestamp: 2 });
  currentTurn.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "new", thinkingSignature: "signed-new" }],
    { model: "claude-opus-4-4", usage: usageWithReasoning(20) },
  ));
  currentTurn.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { model: "claude-opus-4-4", usage: usageWithReasoning(30) },
  ));
  const currentTurnBreakdown = buildSessionBreakdown(currentTurn)!;
  assert.equal(currentTurnBreakdown.reasoningTokens, 50, "older Claude keeps the active assistant turn");
  assert.equal(currentTurnBreakdown.thinkingSummaryChars, 0, "older same-model thinking is stripped");

  const changedModel = SessionManager.inMemory("/tmp/contextimate-changed-model-thinking");
  changedModel.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "think", thinkingSignature: "signed-fable" }],
    { model: "claude-fable-5", usage: usageWithReasoning(800) },
  ));
  changedModel.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { model: "claude-opus-4-8", usage: usageWithReasoning(25) },
  ));
  const changedBreakdown = buildSessionBreakdown(changedModel)!;
  assert.equal(changedBreakdown.reasoningTokens, 25, "replay requires Pi's exact model identity");
  assert.equal(changedBreakdown.thinkingSummaryChars, 5, "cross-model thinking becomes summary text");

  const relay = SessionManager.inMemory("/tmp/contextimate-radius-claude-thinking");
  relay.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "think", thinkingSignature: "signed-relay" }],
    { api: "pi-messages", provider: "radius", model: "claude-fable-5", usage: usageWithReasoning(700) },
  ));
  assert.equal(buildSessionBreakdown(relay)!.reasoningTokens, 700, "relay usage stays exact");
});

test("OpenAI uses encrypted carriers and the model's effective context default", () => {
  const allTurns = SessionManager.inMemory("/tmp/contextimate-codex-thinking");
  allTurns.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "summary", thinkingSignature: encryptedReasoning("rs_1") }],
    { api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: usageWithReasoning(900) },
  ));
  allTurns.appendMessage({ role: "user", content: "next", timestamp: 2 });
  allTurns.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    {
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: usageWithReasoning(100, 900, 900),
    },
  ));
  const allTurnsBreakdown = buildSessionBreakdown(allTurns)!;
  assert.equal(allTurnsBreakdown.thinkingSummaryChars, 0, "opaque carriers are not sized as text");
  assert.equal(allTurnsBreakdown.reasoningTokens, 1000, "GPT-5.6 defaults to all turns");

  const currentTurn = SessionManager.inMemory("/tmp/contextimate-openai-current-turn");
  currentTurn.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: encryptedReasoning("rs_old") }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: usageWithReasoning(600) },
  ));
  currentTurn.appendMessage({ role: "user", content: "next", timestamp: 2 });
  currentTurn.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "tool step", thinkingSignature: encryptedReasoning("rs_tool") }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: usageWithReasoning(50) },
  ));
  currentTurn.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.5", usage: usageWithReasoning(40, 90) },
  ));
  assert.equal(buildSessionBreakdown(currentTurn)!.reasoningTokens, 90, "older models default to current turn");

  const ordinaryTextItem = SessionManager.inMemory("/tmp/contextimate-openai-text-signature");
  ordinaryTextItem.appendMessage(assistantMessage(
    [{ type: "text", text: "first", textSignature: JSON.stringify({ v: 1, id: "msg_1" }) }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.2", usage: usageWithReasoning(600) },
  ));
  ordinaryTextItem.appendMessage({ role: "user", content: "next", timestamp: 2 });
  ordinaryTextItem.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.2", usage: usageWithReasoning(40) },
  ));
  assert.equal(buildSessionBreakdown(ordinaryTextItem)!.reasoningTokens, 40, "text item ids are not reasoning");

  const idOnlyReasoning = SessionManager.inMemory("/tmp/contextimate-openai-id-only-reasoning");
  idOnlyReasoning.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: JSON.stringify({ id: "rs_missing" }) }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usageWithReasoning(600) },
  ));
  idOnlyReasoning.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usageWithReasoning(40) },
  ));
  assert.equal(buildSessionBreakdown(idOnlyReasoning)!.reasoningTokens, 40, "id-only items cannot replay reasoning");
});

test("Gemini accumulates exact reasoning behind valid replay signatures", () => {
  const gemini = SessionManager.inMemory("/tmp/contextimate-gemini-thinking");
  gemini.appendMessage(assistantMessage(
    [{ type: "text", text: "first", textSignature: "QUJDRA==" }],
    { api: "google-generative-ai", provider: "google", model: "gemini-3-pro", usage: usageWithReasoning(600) },
  ));
  gemini.appendMessage({ role: "user", content: "next", timestamp: 2 });
  gemini.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    {
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3-pro",
      usage: usageWithReasoning(50, 2000, 1024),
    },
  ));
  assert.equal(buildSessionBreakdown(gemini)!.reasoningTokens, 650);

  const toolCarrier = SessionManager.inMemory("/tmp/contextimate-gemini-tool-signature");
  toolCarrier.appendMessage(assistantMessage(
    [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {}, thoughtSignature: "QUJDRA==" }],
    { api: "google-vertex", provider: "google", model: "gemini-3-pro", usage: usageWithReasoning(300) },
  ));
  toolCarrier.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "google-vertex", provider: "google", model: "gemini-3-pro", usage: usageWithReasoning(50) },
  ));
  assert.equal(buildSessionBreakdown(toolCarrier)!.reasoningTokens, 350);

  for (const [name, signature, firstModel] of [
    ["invalid", "not base64!", "gemini-3-pro"],
    ["changed-model", "QUJDRA==", "gemini-2.5-pro"],
  ]) {
    const rejected = SessionManager.inMemory(`/tmp/contextimate-gemini-${name}`);
    rejected.appendMessage(assistantMessage(
      [{ type: "text", text: "first", textSignature: signature }],
      { api: "google-generative-ai", provider: "google", model: firstModel, usage: usageWithReasoning(600) },
    ));
    rejected.appendMessage(assistantMessage(
      [{ type: "text", text: "done" }],
      { api: "google-generative-ai", provider: "google", model: "gemini-3-pro", usage: usageWithReasoning(50) },
    ));
    assert.equal(buildSessionBreakdown(rejected)!.reasoningTokens, 50, name);
  }
});

test("reported prompt usage rejects impossible historical attribution", () => {
  const session = SessionManager.inMemory("/tmp/contextimate-impossible-history");
  session.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: encryptedReasoning("rs_large") }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usageWithReasoning(900) },
  ));
  session.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usageWithReasoning(100, 100) },
  ));
  assert.equal(buildSessionBreakdown(session)!.reasoningTokens, 100);

  const noAnchorBreakdown = SessionManager.inMemory("/tmp/contextimate-impossible-history-no-anchor-breakdown");
  noAnchorBreakdown.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: encryptedReasoning("rs_only") }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usageWithReasoning(900) },
  ));
  noAnchorBreakdown.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usageWithoutReasoning(100) },
  ));
  assert.equal(buildSessionBreakdown(noAnchorBreakdown)!.reasoningTokens, undefined);

  const totalOnlyPrompt = SessionManager.inMemory("/tmp/contextimate-total-only-prompt");
  totalOnlyPrompt.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "old", thinkingSignature: encryptedReasoning("rs_total") }],
    { api: "openai-responses", provider: "openai", model: "gpt-5.6", usage: usageWithReasoning(50) },
  ));
  totalOnlyPrompt.appendMessage(assistantMessage(
    [{ type: "text", text: "done" }],
    {
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6",
      usage: { ...usageWithReasoning(10, 0), totalTokens: 90 },
    },
  ));
  assert.equal(buildSessionBreakdown(totalOnlyPrompt)!.reasoningTokens, 60);
});
