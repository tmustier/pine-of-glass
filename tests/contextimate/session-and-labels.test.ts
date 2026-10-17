// Session-residual math (the unattributed bucket) and the token-column layout
// invariant that past alignment fixes were made for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { renderSummary } from "../../extensions/pi-contextimate/render.ts";
import { scanSession } from "../../extensions/pi-contextimate/session-accounting.ts";
import { tokenLabelLayout, estimatedTokenField, estimatedTokenLabel, exactTokenLabel } from "../../extensions/pi-contextimate/metric-rows.ts";
import { buildSnapshot, estimateSnapshotSession, totalTokens, type PrefixSnapshot } from "../../extensions/pi-contextimate/snapshot.ts";
import { assistantMessage, fakePi, fixtureSystemPrompt, anthropicModel, plainTheme, stripAnsi } from "../helpers.ts";

function snapshotWith(session: PrefixSnapshot["session"], usage: PrefixSnapshot["contextUsage"]): PrefixSnapshot {
  const snapshot = buildSnapshot(fakePi(), { systemPrompt: fixtureSystemPrompt(), contextUsage: usage, model: anthropicModel });
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
  measuredToolOutputTokens: 0,
  measuredToolOutputChars: 0,
};

test("with Pi usage: total anchors to (Pi current − estimated harness) and residual is clamped", () => {
  const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
  const snapshot = snapshotWith(session, usage);
  const estimate = estimateSnapshotSession(snapshot)!;
  assert.equal(estimate.totalSource, "pi");
  assert.equal(estimate.totalTokens, Math.max(0, Math.round(50000 - totalTokens(snapshot))));
  // Visible buckets use the session denominator (2.6 for the Claude 4.7+ heuristic).
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
  const tiny = estimateSnapshotSession(snapshotWith(session, { tokens: 100, contextWindow: 200000, percent: 0.1 }))!;
  assert.equal(tiny.unattributedTokens, 0);
});

test("without Pi usage (or null tokens): heuristic fallback over all session chars", () => {
  for (const usage of [undefined, { tokens: null, contextWindow: 200000, percent: null }]) {
    const estimate = estimateSnapshotSession(snapshotWith(session, usage))!;
    assert.equal(estimate.totalSource, "heuristic");
    assert.equal(estimate.totalTokens, Math.ceil((1200 + 5200 + 1300) / 2.6) + 12000);
    assert.equal(estimate.thinkingSummaryTokens, Math.ceil(1200 / 2.6));
    assert.equal(estimate.reasoningTokens, 12000);
    assert.ok(estimate.unattributedTokens <= 1, "heuristic rounding leaves no material accounting gap");
  }
});

test("session walk estimates a summary when the provider omits its reasoning breakdown", () => {
  const unreported = SessionManager.inMemory("/tmp/contextimate-unreported-reasoning");
  const summary = "summary only";
  unreported.appendMessage(assistantMessage([
    { type: "thinking", thinking: summary, thinkingSignature: "opaque-signature" },
  ]));
  const breakdown = scanSession(unreported).breakdown!;
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
  const breakdown = scanSession(fable).breakdown!;
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

test("trailing excluded bash keeps Pi's estimate marker", () => {
  const manager = SessionManager.inMemory("/tmp/contextimate-excluded-bash");
  manager.appendMessage(assistantMessage([{ type: "text", text: "done" }]));
  manager.appendMessage({
    role: "bashExecution",
    command: "printf hidden",
    output: "hidden",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 2,
    excludeFromContext: true,
  });
  const breakdown = scanSession(manager).breakdown!;
  assert.equal(breakdown.contextUsageEstimated, true);
  const rendered = stripAnsi(renderSummary(
    snapshotWith(breakdown, { tokens: 50000, contextWindow: 200000, percent: 25 }),
    plainTheme,
    120,
  ).join("\n"));
  assert.match(rendered, /Total request\s+~50\.0k tokens \(25\.0% · Pi est\.\)/);
});

test("pre-switch usage names its old currency without losing Pi's estimate marker", () => {
  const manager = SessionManager.inMemory("/tmp/contextimate-pre-switch-currency");
  manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  manager.appendMessage(assistantMessage(
    [{ type: "text", text: "old-model answer" }],
    {
      provider: "openai-codex",
      api: "openai-codex-responses",
      model: "gpt-5.6-sol",
      timestamp: 2,
      usage: {
        input: 2,
        output: 10,
        cacheRead: 40_000,
        cacheWrite: 0,
        reasoning: 600,
        totalTokens: 40_012,
        cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    },
  ));
  const usage = { tokens: 50_000, contextWindow: 200_000, percent: 25 };
  const build = () => buildSnapshot(fakePi(), {
    systemPrompt: fixtureSystemPrompt(), sessionManager: manager, contextUsage: usage, model: anthropicModel,
  });

  const switched = build();
  assert.deepEqual(switched.preSwitchUsage, { billedModel: "gpt-5.6-sol" });
  const switchedEstimate = estimateSnapshotSession(switched)!;
  assert.equal(switchedEstimate.totalSource, "heuristic");
  assert.equal(switchedEstimate.reasoningTokens, undefined, "old-model reasoning cannot be reused in the target currency");
  assert.equal(switched.session!.firstPrompt?.tokens, 40_002);
  assert.equal(switchedEstimate.harnessSource, "estimate", "nor can the old model's measured harness");
  const exact = stripAnsi(renderSummary(switched, plainTheme, 80).join("\n"));
  assert.match(exact, /Total request\s+50\.0k tokens\s+\(pre-switch usage · gpt-5\.6-sol tokens\)/);
  assert.doesNotMatch(exact, /Reasoning context|\/ 200k ctx|free /, "old counts must not use the new model's currency");

  manager.appendMessage({ role: "user", content: "next question", timestamp: 3 });
  const estimated = build();
  assert.equal(estimated.session!.contextUsageEstimated, true);
  assert.match(
    stripAnsi(renderSummary(estimated, plainTheme, 120).join("\n")),
    /Total request\s+~50\.0k tokens \(pre-switch total · gpt-5\.6-sol usage \+ Pi est\.\)/,
  );

  manager.appendMessage(assistantMessage(
    [{ type: "text", text: "aborted" }],
    { stopReason: "aborted", timestamp: 4 },
  ));
  assert.deepEqual(build().preSwitchUsage, { billedModel: "gpt-5.6-sol" });
  manager.appendMessage(assistantMessage([{ type: "text", text: "new-model answer" }], { timestamp: 5 }));
  assert.equal(build().preSwitchUsage, undefined, "the first trusted target response re-baselines the currency");
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
    assert.equal(exact.length, estimated.length);
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

test("summary names small context shares and the window budget", () => {
  const snapshot = snapshotWith(session, { tokens: 50_000, contextWindow: 200_000, percent: 25 });
  const rendered = stripAnsi(renderSummary(snapshot, plainTheme, 120).join("\n"));
  assert.match(rendered, /Total request\s+50\.0k tokens \(25\.0% \/ 200k ctx\)/);
  assert.match(rendered, /Total session.*~25% ctx/);

  snapshot.contextUsage = { tokens: 50_000, contextWindow: 10_000_000, percent: 0.5 };
  assert.match(stripAnsi(renderSummary(snapshot, plainTheme, 120).join("\n")), /Total harness.*<1% ctx/);
});

test("the header discloses session and tool methods only when they differ", () => {
  const snapshot = snapshotWith(undefined, undefined);
  const header = () => stripAnsi(renderSummary(snapshot, plainTheme, 120).join("\n"));
  assert.match(header(), /counts ch ÷ 2\.6 \(Claude 4\.7\+ heuristic\)/);
  snapshot.heuristic = {
    source: "configured defaults", label: "custom ratios", textDenominator: 3.8,
    sessionDenominator: 3.5, toolDenominator: 3.3, toolNumerator: "anthropic",
  };
  assert.match(header(), /counts ch ÷ 3\.8 · session ÷ 3\.5 · tools ÷ 3\.3 \(custom ratios\)/);
  snapshot.heuristic = {
    source: "configured defaults", label: "custom render", textDenominator: 4,
    sessionDenominator: 4, toolDenominator: 5.5, toolNumerator: "openai-cookbook",
  };
  assert.match(header(), /counts ch ÷ 4 · tools: OpenAI render \(custom render\)/);
});

test("snapshot signatures are stable and invalidate for active tools, models and config", () => {
  const build = (active: string[], model = anthropicModel, config = {}) =>
    buildSnapshot(fakePi({ activeTools: active }), { systemPrompt: fixtureSystemPrompt(), model, config });

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
