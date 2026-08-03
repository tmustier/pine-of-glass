// Session-residual math (the unattributed bucket) and the token-column layout
// invariant that past alignment fixes were made for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import type { PrefixSnapshot } from "../../extensions/pi-contextimate/index.ts";
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
  thinkingSummaryChars: 1200,
  reasoningTokens: 12000,
  toolOutputChars: 5200,
  messageChars: 1300,
  messageCount: 6,
  contextUsageEstimated: false,
};

test("with Pi usage: total anchors to (Pi current − estimated harness) and residual is clamped", () => {
  const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
  const snapshot = snapshotWith(session, usage);
  const estimate = buildSessionEstimate(snapshot)!;
  assert.equal(estimate.totalSource, "pi");
  assert.equal(estimate.totalTokens, Math.max(0, Math.round(50000 - totalTokens(snapshot))));
  // Visible buckets use the session denominator (2.6 for the modern Claude heuristic).
  assert.equal(estimate.toolOutputTokens, Math.ceil(5200 / 2.6));
  assert.equal(estimate.messageTokens, Math.ceil(1300 / 2.6));
  assert.equal(estimate.thinkingSummaryTokens, Math.ceil(1200 / 2.6));
  assert.equal(estimate.reasoningTokens, 12000, "reasoning stays provider-exact");
  assert.equal(
    estimate.unattributedTokens,
    Math.max(0, Math.round(
      estimate.totalTokens
      - estimate.toolOutputTokens
      - estimate.messageTokens
      - estimate.thinkingSummaryTokens
      - estimate.reasoningTokens!,
    )),
  );

  // Pi usage smaller than the visible buckets must clamp at zero, never go negative.
  const tiny = buildSessionEstimate(snapshotWith(session, { tokens: 100, contextWindow: 200000, percent: 0.1 }))!;
  assert.equal(tiny.unattributedTokens, 0);
});

test("without Pi usage (or null tokens): heuristic fallback over all session chars", () => {
  for (const usage of [undefined, { tokens: null, contextWindow: 200000, percent: null }]) {
    const estimate = buildSessionEstimate(snapshotWith(session, usage))!;
    assert.equal(estimate.totalSource, "heuristic");
    assert.equal(estimate.totalTokens, Math.ceil((1200 + 5200 + 1300) / 2.6) + 12000);
    assert.equal(estimate.thinkingSummaryTokens, Math.ceil(1200 / 2.6));
    assert.equal(estimate.reasoningTokens, 12000);
    assert.ok(estimate.unattributedTokens <= 1, "heuristic rounding leaves no material accounting gap");
  }
});

test("no session → no estimate", () => {
  assert.equal(buildSessionEstimate(snapshotWith(undefined, undefined)), undefined);
});

test("session walk estimates a summary when the provider omits its reasoning breakdown", () => {
  const unreported = SessionManager.inMemory("/tmp/contextimate-unreported-reasoning");
  const summary = "summary only";
  unreported.appendMessage(assistantMessage([
    { type: "thinking", thinking: summary, thinkingSignature: "opaque-signature" },
  ]));
  const breakdown = buildSessionBreakdown(unreported)!;
  assert.equal(breakdown.reasoningTokens, undefined);
  assert.equal(breakdown.thinkingSummaryChars, summary.length);
  const rows = stripAnsi(renderSummary(snapshotWith(breakdown, undefined), plainTheme, 120).join("\n"));
  assert.doesNotMatch(rows, /Reasoning context/, "an absent provider breakdown gets no exact row");
});

test("reported zero reasoning stays exact while the accounting gap remains separate", () => {
  const fable = SessionManager.inMemory("/tmp/contextimate-fable-zero-reasoning");
  fable.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  fable.appendMessage(assistantMessage(
    [{ type: "text", text: "Hello! How can I help you today?" }],
    {
      model: "claude-fable-5",
      usage: {
        input: 2,
        output: 71,
        cacheRead: 0,
        cacheWrite: 30971,
        reasoning: 0,
        totalTokens: 31044,
        cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
  ));
  const breakdown = buildSessionBreakdown(fable)!;
  assert.equal(breakdown.reasoningTokens, 0);
  const rendered = stripAnsi(renderSummary(
    snapshotWith(breakdown, { tokens: 31044, contextWindow: 200000, percent: 15.5 }),
    plainTheme,
    120,
  ).join("\n"));
  assert.match(rendered, /Reasoning context\s+0\.0k tokens \(provider\)/);
  assert.match(rendered, /Unattributed\s+~\d+\.\dk tokens \(accounting gap\)/);
});

test("Total request keeps the estimate marker when Pi adds trailing local estimates", () => {
  const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
  const snapshot = snapshotWith({ ...session, contextUsageEstimated: true }, usage);
  const rendered = stripAnsi(renderSummary(snapshot, plainTheme, 120).join("\n"));
  assert.match(rendered, /Thinking summaries\s+~0\.5k tokens/);
  assert.match(rendered, /Reasoning context\s+12\.0k tokens \(provider\)/);
  assert.doesNotMatch(rendered, /Reasoning context\s+~12\.0k/, "exact reasoning has no estimate marker");
  assert.match(rendered, /Unattributed\s+~\d+\.\dk tokens \(accounting gap\)/);
  assert.match(rendered, /Total request\s+~50\.0k tokens \(25\.0% · Pi est\.\)/);
  const narrowSessionRows = stripAnsi(renderSummary(snapshot, plainTheme, 80).join("\n"))
    .split("\n")
    .filter((line) => /Thinking summaries|Reasoning context|Unattributed|Total session|Total request/.test(line));
  assert.ok(narrowSessionRows.every((line) => line.length <= 80), "session rows stay inside the narrow panel");
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
    methodologyHint(heuristic({ label: "Modern Claude heuristic", textDenominator: 2.6, sessionDenominator: 2.6, toolDenominator: 2.6 })),
    "counts ch ÷ 2.6 (Modern Claude heuristic)",
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
