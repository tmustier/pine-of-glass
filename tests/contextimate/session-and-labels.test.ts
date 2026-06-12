// Session-residual math (the "Other / reasoning" bucket) and the token-column layout
// invariant that past alignment fixes were made for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import type { PrefixSnapshot } from "../../extensions/pi-contextimate/index.ts";
import { fakePi, fixtureSystemPrompt, anthropicModel, stripAnsi } from "../helpers.ts";

const { buildSnapshot, buildSessionEstimate, totalTokens, tokenLabelLayout, estimatedTokenField, estimatedTokenLabel, exactTokenLabel, ctxShareLabel, contextWindowLabel, methodologyHint } = internals;

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

const session = { thinkingChars: 12000, toolOutputChars: 5200, messageChars: 1300, messageCount: 6 };

test("with Pi usage: total anchors to (Pi current − harness) and residual is clamped", () => {
  const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
  const snapshot = snapshotWith(session, usage);
  const estimate = buildSessionEstimate(snapshot)!;
  assert.equal(estimate.totalSource, "pi");
  assert.equal(estimate.totalTokens, Math.max(0, Math.round(50000 - totalTokens(snapshot))));
  // Visible buckets use the session denominator (2.6 for the Claude 4.7+ heuristic).
  assert.equal(estimate.toolOutputTokens, Math.ceil(5200 / 2.6));
  assert.equal(estimate.messageTokens, Math.ceil(1300 / 2.6));
  assert.equal(estimate.otherTokens, Math.max(0, Math.round(estimate.totalTokens - estimate.toolOutputTokens - estimate.messageTokens)));

  // Pi usage smaller than the visible buckets must clamp at zero, never go negative.
  const tiny = buildSessionEstimate(snapshotWith(session, { tokens: 100, contextWindow: 200000, percent: 0.1 }))!;
  assert.equal(tiny.otherTokens, 0);
});

test("without Pi usage (or null tokens): heuristic fallback over all session chars", () => {
  for (const usage of [undefined, { tokens: null, contextWindow: 200000, percent: null }]) {
    const estimate = buildSessionEstimate(snapshotWith(session, usage))!;
    assert.equal(estimate.totalSource, "heuristic");
    assert.equal(estimate.totalTokens, Math.ceil((12000 + 5200 + 1300) / 2.6));
  }
});

test("no session → no estimate", () => {
  assert.equal(buildSessionEstimate(snapshotWith(undefined, undefined)), undefined);
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

test("methodology states the session denominator only when it deviates", () => {
  const heuristic = (patch: Record<string, unknown>) => ({
    source: "test", toolDenominator: 4, toolNumerator: "anthropic", ...patch,
  }) as Parameters<typeof methodologyHint>[0];
  assert.equal(
    methodologyHint(heuristic({ label: "Claude 4.7+ heuristic", textDenominator: 2.6, sessionDenominator: 2.6 })),
    "counts ch ÷ 2.6 (Claude 4.7+ heuristic)",
  );
  assert.equal(
    methodologyHint(heuristic({ label: "Claude 4.5/4.6 heuristic", textDenominator: 3.8, sessionDenominator: 3.5 })),
    "counts ch ÷ 3.8 · session ÷ 3.5 (Claude 4.5/4.6 heuristic)",
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
