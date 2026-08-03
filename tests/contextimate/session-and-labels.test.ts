// Session-residual math and the token-column layout invariant that past
// alignment fixes were made for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import type { PrefixSnapshot } from "../../extensions/pi-contextimate/index.ts";
import { correctedContextTokens } from "../../extensions/pi-contextimate/session-accounting.ts";
import { assistantMessage, fakePi, fixtureSystemPrompt, anthropicModel, plainTheme, stripAnsi } from "../helpers.ts";

const { buildSnapshot, buildSessionBreakdown, buildSessionEstimate, totalTokens, tokenLabelLayout, estimatedTokenField, estimatedTokenLabel, exactTokenLabel, ctxShareLabel, contextWindowLabel, methodologyHint, renderSummary } = internals;

function snapshotWith(session: PrefixSnapshot["session"], usage: PrefixSnapshot["contextUsage"]): PrefixSnapshot {
  const snapshot = buildSnapshot(
    fakePi(),
    () => fixtureSystemPrompt(),
    undefined,
    () => usage,
    () => anthropicModel,
    {},
  );
  snapshot.session = session;
  return snapshot;
}

const session = {
  toolOutputChars: 5200,
  messageChars: 1300,
  contextUsageEstimated: false,
};

function codexBreakdown(options: {
  api?: string;
  provider?: string;
  firstModel?: string;
  finalModel?: string;
  signature?: string;
} = {}) {
  const sessionManager = SessionManager.inMemory("/tmp/contextimate-codex-reasoning");
  const api = options.api ?? "openai-codex-responses";
  const provider = options.provider ?? "openai-codex";
  const firstModel = options.firstModel ?? "gpt-5.5";
  const usage = (reasoning: number, input: number, output: number) => ({
    input, output, reasoning, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  sessionManager.appendMessage(assistantMessage(
    [{ type: "thinking", thinking: "summary", thinkingSignature: options.signature
      ?? JSON.stringify({ type: "reasoning", encrypted_content: "opaque" }) }],
    { api, provider, model: firstModel, usage: usage(216, 578, 228) },
  ));
  sessionManager.appendMessage({ role: "user", content: "next", timestamp: 2 });
  sessionManager.appendMessage(assistantMessage(
    [{ type: "text", text: "OK" }],
    { api, provider, model: options.finalModel ?? firstModel, usage: usage(0, 598, 5) },
  ));
  return buildSessionBreakdown(sessionManager)!;
}

test("Codex correction follows the measured route", () => {
  const corrected = codexBreakdown();
  assert.equal(corrected.providerOmittedReasoningTokens, 216);
  assert.equal(correctedContextTokens(corrected, 603), 819);
  assert.equal(codexBreakdown({ firstModel: "gpt-5.6-sol" }).providerOmittedReasoningTokens, undefined);
  assert.equal(codexBreakdown({ api: "openai-responses", provider: "openai" }).providerOmittedReasoningTokens, undefined);
  assert.equal(codexBreakdown({ finalModel: "gpt-5.4" }).providerOmittedReasoningTokens, undefined);
  assert.equal(codexBreakdown({
    signature: JSON.stringify({ type: "reasoning", id: "no-encrypted-content" }),
  }).providerOmittedReasoningTokens, undefined);
});

test("with Pi usage: total anchors to (Pi current − estimated harness) and residual is clamped", () => {
  const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
  const snapshot = snapshotWith(session, usage);
  const estimate = buildSessionEstimate(snapshot)!;
  assert.equal(estimate.totalSource, "pi");
  assert.equal(estimate.totalTokens, Math.max(0, Math.round(50000 - totalTokens(snapshot))));
  assert.equal(estimate.toolOutputTokens, Math.ceil(5200 / 2.6));
  assert.equal(estimate.messageTokens, Math.ceil(1300 / 2.6));
  assert.equal(
    estimate.otherTokens,
    Math.max(0, Math.round(estimate.totalTokens - estimate.toolOutputTokens - estimate.messageTokens)),
  );

  const tiny = buildSessionEstimate(snapshotWith(session, { tokens: 100, contextWindow: 200000, percent: 0.1 }))!;
  assert.equal(tiny.otherTokens, 0);
});

test("Codex correction changes the number, not the label", () => {
  const correctedSession = { ...session, providerOmittedReasoningTokens: 600 };
  const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
  const snapshot = snapshotWith(correctedSession, usage);
  assert.equal(
    buildSessionEstimate(snapshot)!.totalTokens,
    Math.max(0, Math.round(50600 - totalTokens(snapshot))),
  );
  const rendered = stripAnsi(renderSummary(snapshot, plainTheme, 120).join("\n"));
  assert.match(rendered, /Total request\s+50\.6k tokens \(25\.3% \/ 200k ctx\)/);
  assert.doesNotMatch(rendered, /Pi \+ prior/);

  const estimated = stripAnsi(renderSummary(
    snapshotWith({ ...correctedSession, contextUsageEstimated: true }, usage),
    plainTheme,
    120,
  ).join("\n"));
  assert.match(estimated, /Total request\s+~50\.6k tokens \(25\.3%\)/);
});

test("without Pi usage (or null tokens): heuristic fallback uses session characters", () => {
  for (const usage of [undefined, { tokens: null, contextWindow: 200000, percent: null }]) {
    const estimate = buildSessionEstimate(snapshotWith(session, usage))!;
    assert.equal(estimate.totalSource, "heuristic");
    assert.equal(estimate.totalTokens, Math.ceil((5200 + 1300) / 2.6));
  }
});

test("no session → no estimate", () => {
  assert.equal(buildSessionEstimate(snapshotWith(undefined, undefined)), undefined);
});

test("session estimates do not count reasoning summaries or signatures", () => {
  const unreported = SessionManager.inMemory("/tmp/contextimate-unreported-reasoning");
  unreported.appendMessage(assistantMessage([
    { type: "thinking", thinking: "summary only", thinkingSignature: "opaque-signature".repeat(100) },
  ]));
  assert.equal(buildSessionBreakdown(unreported)!.messageChars, 0);
});

test("Total request keeps the estimate marker when Pi adds trailing local estimates", () => {
  const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
  const snapshot = snapshotWith({ ...session, contextUsageEstimated: true }, usage);
  const rendered = stripAnsi(renderSummary(snapshot, plainTheme, 120).join("\n"));
  assert.match(rendered, /Total request\s+~50\.0k tokens \(25\.0%\)/);
});

test("token labels align to one shared column width across magnitudes", () => {
  const values = [12, 950, 64321, 1234567];
  const layout = tokenLabelLayout(values);
  const widths = new Set(values.map((value) => stripAnsi(estimatedTokenField(value, layout)).length));
  assert.equal(widths.size, 1, "all estimated fields share one width");
  // The exact (non-~) variant pads one extra column so digits align with ~-prefixed rows.
  for (const value of values) {
    const estimated = estimatedTokenLabel(value, layout);
    const exact = exactTokenLabel(value, layout);
    assert.equal(exact.length, estimated.length + (estimated.includes("~") ? 0 : 1));
    assert.equal(exact.replace(/^\s+/, ""), estimated.replace(/^\s*~/, ""));
  }
});

test("token labels speak the family fixed-k grammar (design language §4)", () => {
  // The private integer-k formatter is gone: labels delegate to the shared compactCount,
  // so 1k+ values keep one decimal and columns compare uniformly.
  assert.equal(estimatedTokenLabel(0), "~0.0k");
  assert.equal(estimatedTokenLabel(950), "~0.9k"); // float 0.95 rounds down via toFixed
  assert.equal(estimatedTokenLabel(1499), "~1.5k");
  assert.equal(estimatedTokenLabel(64321), "~64.3k");
  assert.equal(exactTokenLabel(64321), " 64.3k");
});

test("context-window shares: integer percent, <1% over a dishonest 0%, budget label", () => {
  const usage = { tokens: 64321, contextWindow: 200000, percent: 32.2 };
  assert.equal(ctxShareLabel(64321, usage), "32% ctx");
  assert.equal(ctxShareLabel(900, usage), "<1% ctx");
  assert.equal(ctxShareLabel(0, usage), "0% ctx");
  assert.equal(ctxShareLabel(900, undefined), undefined);
  assert.equal(ctxShareLabel(900, { tokens: null, contextWindow: 200000, percent: null }), undefined);
  // The window is a budget label, not a measurement: 200k, not 200.0k.
  assert.equal(contextWindowLabel(200000), "200k");
  assert.equal(contextWindowLabel(128500), "128.5k");
  assert.equal(contextWindowLabel(1000000), "1M");
});

test("methodology states session/tool methods only when they deviate from the text ratio", () => {
  const heuristic = (patch: Record<string, unknown>) => ({
    source: "test", toolNumerator: "anthropic", ...patch,
  }) as Parameters<typeof methodologyHint>[0];
  // Everything counted at the text ratio: one clause, no qualifiers.
  assert.equal(
    methodologyHint(heuristic({ label: "Claude 4.7+ heuristic", textDenominator: 2.6, sessionDenominator: 2.6, toolDenominator: 2.6 })),
    "counts ch ÷ 2.6 (Claude 4.7+ heuristic)",
  );
  // Session and tool denominators each disclose their own deviation.
  assert.equal(
    methodologyHint(heuristic({ label: "Claude 4.5/4.6 heuristic", textDenominator: 3.8, sessionDenominator: 3.5, toolDenominator: 3.3 })),
    "counts ch ÷ 3.8 · session ÷ 3.5 · tools ÷ 3.3 (Claude 4.5/4.6 heuristic)",
  );
  assert.equal(
    methodologyHint(heuristic({ label: "OpenAI Responses heuristic", textDenominator: 4, sessionDenominator: 4, toolDenominator: 5.5 })),
    "counts ch ÷ 4 · tools ÷ 5.5 (OpenAI Responses heuristic)",
  );
  // Formula-counted tools are not a ch ratio at all — the hint must not pretend they are.
  assert.equal(
    methodologyHint(heuristic({ label: "OpenAI-Codex heuristic", textDenominator: 4, sessionDenominator: 4, toolDenominator: 5.5, toolNumerator: "openai-cookbook" })),
    "counts ch ÷ 4 · tools: OpenAI formula (OpenAI-Codex heuristic)",
  );
});

test("snapshot signature changes exactly when inputs that affect rendering change", () => {
  const build = (active: string[], model = anthropicModel, config = {}) =>
    buildSnapshot(fakePi({ activeTools: active }), () => fixtureSystemPrompt(), undefined, () => undefined, () => model, config);

  const base = build(["read", "bash", "search"]);
  assert.equal(build(["read", "bash", "search"]).signature, base.signature, "same inputs → same signature");
  assert.notEqual(build(["read", "bash"]).signature, base.signature, "active tool set must invalidate");
  assert.notEqual(
    build(["read", "bash", "search"], { provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" }).signature,
    base.signature,
    "model must invalidate",
  );
  assert.notEqual(
    build(["read", "bash", "search"], anthropicModel, { defaults: { textDenominator: 9 } }).signature,
    base.signature,
    "config must invalidate",
  );
});
