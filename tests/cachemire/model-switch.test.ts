// Model-switch forecasting (issue #57): the clock's target-currency states, the sized
// break prediction, and computeSwitchForecast wiring over real pi session machinery.
// The event flow lives in model-switch-events.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";
import { computeSwitchForecast, type SwitchTarget } from "../../extensions/pi-cachemire/forecast.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const {
  cacheClock, nextClockUpdateMs, OPENAI_MINIMUM_WINDOW, predictBreak, renderBreakingLine,
  restoreLineageSnapshots, withinWarmHorizon,
} = internals;

const CONTRACT_5M = { kind: "contract", ttlMs: 5 * 60_000, source: "observed" } as const;
const UNKNOWN = { kind: "unknown" } as const;
const RATES = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const MIN = 60_000;

const FORECAST = {
  targetId: "gpt-5.6-sol", targetProvider: "openai-codex",
  estTokens: 96_400, basis: "direct" as const,
};

test("clock: model switch forecasts in the target currency, always marked est", () => {
  // Per-model caches everywhere: the last call's entry is dead for the new model, and
  // the stored count is in the old tokenizer's currency, so it is never shown.
  const switched = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 142_300, rewriteUsd: 2.67, modelSwitched: true, switchForecast: FORECAST });
  assert.equal(switched.phase, "cold");
  assert.equal(switched.text, "cache cold expected \u00b7 model switched \u00b7 next send ~96.4k uncached to openai-codex (est)");
  // Gateway routes may transform the request upstream: the claim is demoted.
  const gateway = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: { ...FORECAST, basis: "gateway" } });
  assert.equal(gateway.text, "cache cold expected \u00b7 model switched \u00b7 next send ~96.4k uncached to openai-codex (rough est \u00b7 gateway route)");
  // Without an estimate the number is withheld outright (and stays out of the old currency).
  const untagged = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 142_300, modelSwitched: true });
  assert.equal(untagged.text, "cache cold expected \u00b7 model switched \u00b7 prompt size known at next send");
});

test("clock: A\u2192B\u2192A switch-back defers to the target's own prior entry", () => {
  const anthropicForecast = {
    targetId: "claude-opus-4-8",
    targetProvider: "anthropic",
    estTokens: 96_400,
    basis: "direct" as const,
    prior: { requestAt: 0, window: CONTRACT_5M },
  };
  const back = cacheClock({ now: 4 * MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: anthropicForecast });
  assert.equal(back.phase, "warm-unknown");
  assert.equal(back.text, "cache may still be warm \u00b7 switched back to claude-opus-4-8 \u00b7 next send confirms");
  const backCold = cacheClock({ now: 5 * MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: anthropicForecast });
  assert.equal(backCold.phase, "cold", "the exact contract boundary is no longer warm");

  const unknown = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: { ...FORECAST, prior: { requestAt: 0, window: UNKNOWN } } });
  assert.equal(unknown.text, "cache state unknown \u00b7 model switched \u00b7 next send confirms");

  const minimumForecast = { ...FORECAST, prior: { requestAt: 0, window: OPENAI_MINIMUM_WINDOW } };
  assert.equal(
    cacheClock({ now: 29 * MIN, lastRequestAt: 0, window: UNKNOWN, modelSwitched: true, switchForecast: minimumForecast }).text,
    "cache may still be warm \u00b7 switched back to gpt-5.6-sol \u00b7 next send confirms",
  );
  assert.equal(
    cacheClock({ now: 30 * MIN, lastRequestAt: 0, window: UNKNOWN, modelSwitched: true, switchForecast: minimumForecast }).text,
    "cache state unknown \u00b7 model switched \u00b7 next send confirms",
  );

  const maximum = { kind: "maximum", maxMs: 24 * 60 * MIN } as const;
  const extendedForecast = { ...FORECAST, prior: { requestAt: 0, window: maximum } };
  assert.equal(
    cacheClock({ now: 60 * MIN, lastRequestAt: 0, window: UNKNOWN, modelSwitched: true, switchForecast: extendedForecast }).text,
    "cache state unknown \u00b7 model switched \u00b7 next send confirms",
  );
  assert.equal(nextClockUpdateMs({
    now: 60 * MIN,
    lastRequestAt: 0,
    window: UNKNOWN,
    modelSwitched: true,
    switchForecast: extendedForecast,
  }), 23 * 60 * MIN);
  const atMaximum = { now: 24 * 60 * MIN, lastRequestAt: 0, window: UNKNOWN, modelSwitched: true, switchForecast: extendedForecast };
  assert.equal(cacheClock(atMaximum).phase, "cold");
  assert.equal(nextClockUpdateMs(atMaximum), undefined);

  const compacted = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, compacted: true, switchForecast: anthropicForecast });
  assert.equal(compacted.text, "cache stale after compaction \u00b7 next send may re-write changed history");
});

test("warm horizon requires a contract or minimum", () => {
  assert.equal(withinWarmHorizon(CONTRACT_5M, 4 * MIN), true);
  assert.equal(withinWarmHorizon(CONTRACT_5M, 5 * MIN), false, "the exact TTL boundary is expired");
  assert.equal(withinWarmHorizon(OPENAI_MINIMUM_WINDOW, 29 * MIN), true);
  assert.equal(withinWarmHorizon(OPENAI_MINIMUM_WINDOW, 30 * MIN), false, "the minimum has ended");
  assert.equal(
    withinWarmHorizon({ kind: "maximum", maxMs: 24 * 60 * MIN }, 4 * MIN),
    false,
    "a maximum does not promise minimum warmth",
  );
  assert.equal(withinWarmHorizon(undefined, 1 * MIN), false, "unknown retention must not guess at warmth");
});

test("break prediction: model switch sized in the target currency, or silent when warm", () => {
  const base = { isFirst: false, inCompaction: false, compacted: false, expectedRead: 138_200, rates: RATES };
  const modelCause = { kind: "model", detail: "model switched a \u2192 b" } as const;

  // Without a forecast: certain break, but the size is in the old tokenizer \u2014 withheld.
  const model = predictBreak({ ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause })!;
  assert.equal(model.expectedRewriteTokens, undefined);
  assert.equal(renderBreakingLine(model), "cache breaking \u00b7 re-writing the full prompt \u00b7 cause: model switched a \u2192 b");

  // With a target-currency forecast: sized, est-marked, est-priced.
  const sized = predictBreak({
    ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
    switchForecast: { estTokens: 96_400, basis: "direct", priorMayBeWarm: false, targetProvider: "openai-codex" },
  })!;
  assert.equal(sized.estimatedRewriteTokens, 96_400);
  assert.equal(sized.expectedRewriteTokens, undefined, "the old-currency size stays withheld");
  assert.equal(sized.estimatedUsd, 1.807_5); // 96.4k at $18.75/M write, still an estimate
  assert.equal(
    renderBreakingLine(sized),
    "cache breaking \u00b7 sending ~96.4k uncached to openai-codex (est \u00b7 ~$1.81) \u00b7 cause: model switched a \u2192 b",
  );
  assert.equal(
    renderBreakingLine(predictBreak({
      ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
      switchForecast: { estTokens: 96_400, basis: "gateway", priorMayBeWarm: false, targetProvider: "openai-codex" },
    })!),
    "cache breaking \u00b7 sending ~96.4k uncached to openai-codex (rough est \u00b7 gateway route \u00b7 ~$1.81) \u00b7 cause: model switched a \u2192 b",
  );

  // A\u2192B\u2192A switch-back with the target's own contract entry still warm: no
  // in-flight claim. The resolved line reports the truth when usage arrives.
  assert.equal(
    predictBreak({
      ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
      switchForecast: { estTokens: 96_400, basis: "direct", priorMayBeWarm: true, targetProvider: "openai-codex" },
    }),
    undefined,
  );

  // Pricing tiers are request-wide: a switch estimate above the threshold prices the
  // whole request at the tier's write rate.
  const tiered = predictBreak({
    ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
    rates: { ...RATES, tiers: [{ inputTokensAbove: 90_000, input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 }] },
    switchForecast: { estTokens: 96_400, basis: "direct", priorMayBeWarm: false, targetProvider: "openai-codex" },
  })!;
  assert.equal(tiered.estimatedUsd, 3.615); // 96.4k at the $37.50/M tier write rate
});

// --- computeSwitchForecast over real pi session machinery --------------------------------

function usage(input: number, cacheRead: number, cacheWrite: number) {
  return { input, output: 10, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function solAssistant(timestamp: number, prompt: number) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "r".repeat(2600), thinkingSignature: "S".repeat(2600) },
      { type: "text", text: "a".repeat(2600) },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason: "stop",
    timestamp,
    usage: usage(2, prompt - 2, 0),
  };
}

function entriesFixture(): SessionEntry[] {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "b".repeat(2600), timestamp: 1_000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T10:00:05.000Z", message: solAssistant(5_000, 80_000) },
  ] as unknown as SessionEntry[];
}

const OPUS: SwitchTarget = { provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages", input: ["text", "image"] };

test("restored lineage anchors freshness at the parent request, not response end", () => {
  const restored = restoreLineageSnapshots(entriesFixture());
  assert.equal(restored[0]?.requestAt, 1_000);
  assert.equal(restored[0]?.responseAt, 5_000);
});

test("computeSwitchForecast: estimates from canonical history in the target currency", () => {
  const forecast = computeSwitchForecast({
    target: OPUS,
    entries: entriesFixture(),
    activeLeafId: "a1",
    systemPromptChars: 2_600,
    tools: [],
    snapshots: [],
  });
  assert.equal(forecast.targetId, "claude-opus-4-8");
  assert.equal(forecast.basis, "direct");
  // Claude 4.7+ heuristic (chars/2.6): 2.6k system + 2.6k user + 2.6k readable thinking
  // (converted to text cross-model) + 2.6k assistant text = 4000 tokens; the 2.6k-char
  // encrypted payload never reaches the anthropic target.
  assert.equal(forecast.estTokens, 4_000);
  assert.equal(forecast.prior, undefined);
});

test("computeSwitchForecast: a source-model bill never rescales the target estimate", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "b".repeat(5200), timestamp: 1_000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T10:00:05.000Z", message: {
      role: "assistant", content: [{ type: "text", text: "a".repeat(2600) }],
      api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol",
      stopReason: "stop", timestamp: 5_000, usage: usage(2, 2_898, 0),
    } },
  ] as unknown as SessionEntry[];
  const sourceSnapshot = {
    requestLeafId: "u1", responseEntryId: "a1", responseAt: 5_000, requestAt: 1_000,
    promptTokens: 2_925,
    provider: "openai-codex", model: "gpt-5.6-sol", api: "openai-codex-responses",
  };
  const base = { target: OPUS, entries, activeLeafId: "a1", systemPromptChars: 0, tools: [] };
  // Target estimate: 7.8k history chars / 2.6 = 3000. The unrelated source bill is
  // exact in its own currency, but its density is not transferable to this tokenizer.
  assert.equal(computeSwitchForecast({ ...base, snapshots: [sourceSnapshot] }).estTokens, 3_000);
  assert.equal(computeSwitchForecast({ ...base, snapshots: [] }).estTokens, 3_000);
});

test("computeSwitchForecast: a switch-back prior needs an exact api and an uncompacted path", () => {
  const sol: SwitchTarget = { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" };
  const snapshot = {
    requestLeafId: "u1", responseEntryId: "a1", responseAt: 5_000, requestAt: 1_000,
    promptTokens: 80_000,
    provider: "openai-codex", model: "gpt-5.6-sol", api: "openai-codex-responses",
  };
  const base = { target: sol, entries: entriesFixture(), activeLeafId: "a1", systemPromptChars: 0, tools: [] };
  assert.deepEqual(
    computeSwitchForecast({ ...base, snapshots: [snapshot] }).prior,
    { requestAt: 1_000, window: undefined },
  );
  // Same id via a different (or unrecorded) wire API is a different cache: no warmth hint.
  assert.equal(computeSwitchForecast({ ...base, snapshots: [{ ...snapshot, api: "openai-responses" }] }).prior, undefined);
  assert.equal(computeSwitchForecast({ ...base, snapshots: [{ ...snapshot, api: undefined }] }).prior, undefined);
  // A compaction between the prior call and the leaf rewrote the prefix it cached.
  const compacted = [
    ...entriesFixture(),
    { type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-07-01T10:01:00.000Z" },
  ] as unknown as SessionEntry[];
  assert.equal(
    computeSwitchForecast({ ...base, entries: compacted, activeLeafId: "c1", snapshots: [snapshot] }).prior,
    undefined,
  );
});

test("computeSwitchForecast: gateway targets are labelled, not refused a number", () => {
  const forecast = computeSwitchForecast({
    target: { provider: "radius", id: "auto", api: "pi-messages" },
    entries: entriesFixture(),
    activeLeafId: "a1",
    systemPromptChars: 0,
    tools: [],
    snapshots: [],
  });
  assert.equal(forecast.basis, "gateway");
  assert.ok(forecast.estTokens !== undefined && forecast.estTokens > 0);
});

test("computeSwitchForecast: finds the target's own prior call on the active path only", () => {
  const entries = entriesFixture();
  const snapshots = restoreLineageSnapshots(entries);
  // Switching back to sol itself: its billed call at a1 is on the path.
  const backToSol = computeSwitchForecast({
    target: { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" },
    entries, activeLeafId: "a1", systemPromptChars: 0, tools: [], snapshots,
  });
  assert.ok(backToSol.prior, "the target's own billed call must be found");
  assert.equal(backToSol.prior!.window, OPENAI_MINIMUM_WINDOW);
  // Switching to a model that never billed on this path: no prior.
  const toOpus = computeSwitchForecast({
    target: OPUS, entries, activeLeafId: "a1", systemPromptChars: 0, tools: [], snapshots,
  });
  assert.equal(toOpus.prior, undefined);
});
