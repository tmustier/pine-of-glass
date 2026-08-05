// Cachemire economics (hand-computed) and the exact user-facing strings.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";
import type { CallRecord } from "../../extensions/pi-cachemire/index.ts";

const {
  uncachedCostUsd, rewriteCostUsd, sessionSavings,
  compactCount, formatUsd, formatDuration,
  cacheClock, renderRunSummary, renderMissLine, renderLedger,
  inferAnthropicTtlMs, predictBreak, renderBreakingLine, renderHeldLine,
  OPENAI_EXTENDED_WINDOW, OPENAI_MINIMUM_WINDOW,
  thinkingLevelsDiffer, wireThinkingEffort, nextClockUpdateMs,
} = internals;

const CONTRACT_5M = { kind: "contract", ttlMs: 5 * 60_000, source: "observed" } as const;
const CONTRACT_1H = { kind: "contract", ttlMs: 60 * 60_000, source: "observed" } as const;

// claude-opus-4-8-style rates, USD per Mtok (write carries the 1.25x premium already).
const RATES = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const MIN = 60_000;

test("counterfactual and rewrite math, hand-computed", () => {
  const usage = { input: 1_000, output: 2_000, cacheRead: 100_000, cacheWrite: 4_000 };
  // uncached = (1k + 100k + 4k) * $15/M + 2k * $75/M = 1.575 + 0.15
  assert.equal(uncachedCostUsd(usage, RATES), 1.725);
  assert.equal(uncachedCostUsd(usage, undefined), undefined);
  // 142k tokens re-written at $18.75/M
  assert.equal(rewriteCostUsd(142_000, RATES), 2.6625);
});

test("session savings aggregate only over priced calls", () => {
  const record = (costUsd?: number, uncachedUsd?: number): CallRecord => ({
    index: 1, at: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    expectedRead: 0, classification: { kind: "hit" }, rewroteTokens: 0, costUsd, uncachedUsd,
  });
  const savings = sessionSavings([record(0.30, 1.50), record(0.20, 0.50), record(undefined, 9.99)])!;
  assert.equal(savings.actual, 0.5);
  assert.equal(savings.uncached, 2.0);
  assert.equal(savings.saved, 1.5);
  assert.equal(savings.pct, 75);
  assert.equal(sessionSavings([record(undefined, undefined)]), undefined);
});

test("formatting primitives", () => {
  assert.equal(compactCount(940_100), "940.1k");
  assert.equal(compactCount(312), "0.3k"); // one unit everywhere — design language §4
  assert.equal(formatUsd(0.523), "$0.52");
  assert.equal(formatUsd(0.0523), "$0.052");
  assert.equal(formatDuration(41_000), "41s");
  assert.equal(formatDuration(161_000), "2m41s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(64 * MIN), "1h4m");
});

test("cache clock stays silent until attention is useful", () => {
  assert.equal(cacheClock({ now: 0 }).phase, "idle");

  const healthy = cacheClock({ now: 100_000, lastRequestAt: 0, window: CONTRACT_5M });
  assert.equal(healthy.phase, "idle");
  assert.equal(healthy.text, "");

  const closing = cacheClock({ now: 4 * MIN + 15_000, lastRequestAt: 0, window: CONTRACT_5M });
  assert.equal(closing.phase, "closing");
  assert.equal(closing.text, "cache expires in 45s");

  const cold = cacheClock({ now: 6 * MIN, lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 142_300, rewriteUsd: 2.67 });
  assert.equal(cold.phase, "cold");
  assert.equal(cold.text, "cache stale \u00b7 TTL expired \u00b7 next send may re-write ~142.3k (~$2.67)");

  // Unknown cache lifetimes stay silent rather than guessing at warm or cold states.
  assert.deepEqual(cacheClock({ now: 3 * MIN, lastRequestAt: 0 }), { phase: "idle", text: "" });
  assert.deepEqual(
    cacheClock({ now: 535 * MIN, lastRequestAt: 0, cachedTokens: 109_800, rewriteUsd: 1.37 }),
    { phase: "idle", text: "" },
  );

  const stale = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 142_300, compacted: true });
  assert.equal(stale.phase, "stale");
  assert.equal(stale.text, "cache stale after compaction \u00b7 next send may re-write changed history");

  // Model-switch clock states (target-currency forecast, A→B→A warmth) live in
  // tests/cachemire/model-switch.test.ts.

  const thinking = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 142_300, thinkingChanged: true });
  assert.equal(thinking.phase, "stale");
  assert.equal(thinking.text, "cache stale \u00b7 thinking level changed \u00b7 next send may re-write the prompt");
  const minimum = { lastRequestAt: 0, window: OPENAI_MINIMUM_WINDOW, cachedTokens: 109_800, rewriteUsd: 1.37 };
  assert.deepEqual(
    cacheClock({ ...minimum, now: 15 * MIN }),
    { phase: "idle", text: "" },
    "GPT-5.6 stays protected from stale claims during its documented minimum",
  );
  assert.deepEqual(
    cacheClock({ ...minimum, now: 30 * MIN }),
    {
      phase: "warm-unknown",
      text: "cache state unknown \u00b7 30m retention minimum reached \u00b7 next send may re-send ~109.8k uncached (~$1.37)",
    },
  );

  // A maximum is not a minimum lifetime, so it stays silent before the boundary.
  const maximum = { lastRequestAt: 0, window: OPENAI_EXTENDED_WINDOW, cachedTokens: 109_800, rewriteUsd: 1.37 };
  assert.deepEqual(
    cacheClock({ ...maximum, now: 23 * 60 * MIN, thinkingChanged: true }),
    { phase: "idle", text: "" },
  );
  assert.deepEqual(
    cacheClock({ ...maximum, now: 24 * 60 * MIN }),
    {
      phase: "cold",
      text: "cache stale \u00b7 24h retention maximum reached \u00b7 next send may re-send ~109.8k uncached (~$1.37)",
    },
    "the exact maximum boundary is expired",
  );
});

test("cache clock schedules only useful state changes", () => {
  assert.equal(nextClockUpdateMs({ now: MIN, lastRequestAt: 0 }), undefined, "unknown TTL has no timer");
  assert.equal(nextClockUpdateMs({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M }), 3 * MIN);
  assert.equal(nextClockUpdateMs({ now: 4 * MIN + 30_000, lastRequestAt: 0, window: CONTRACT_5M }), 1_000);
  assert.equal(nextClockUpdateMs({ now: 6 * MIN, lastRequestAt: 0, window: CONTRACT_5M }), undefined);
  assert.equal(nextClockUpdateMs({ now: 55 * MIN + 14_000, lastRequestAt: 0, window: CONTRACT_1H }), 1_001);
  assert.equal(nextClockUpdateMs({ now: 58 * MIN + 29_000, lastRequestAt: 0, window: CONTRACT_1H }), 1_001);
  assert.equal(nextClockUpdateMs({ now: 3 * MIN, lastRequestAt: 0, window: CONTRACT_5M, thinkingChanged: true }), undefined);
  assert.equal(nextClockUpdateMs({ now: 15 * MIN, lastRequestAt: 0, window: OPENAI_MINIMUM_WINDOW }), 15 * MIN);
  assert.equal(nextClockUpdateMs({ now: 30 * MIN, lastRequestAt: 0, window: OPENAI_MINIMUM_WINDOW }), undefined);
  assert.equal(
    nextClockUpdateMs({ now: 23 * 60 * MIN, lastRequestAt: 0, window: OPENAI_EXTENDED_WINDOW }),
    60 * MIN,
  );
  assert.equal(nextClockUpdateMs({ now: 24 * 60 * MIN, lastRequestAt: 0, window: OPENAI_EXTENDED_WINDOW }), undefined);
  assert.equal(nextClockUpdateMs({
    now: MIN,
    lastRequestAt: 0,
    modelSwitched: true,
    switchForecast: {
      targetId: "gpt-5.4",
      targetProvider: "openai",
      estTokens: 10_000,
      basis: "direct",
      prior: { requestAt: 0, window: OPENAI_EXTENDED_WINDOW },
    },
  }), 24 * 60 * MIN - MIN);
});

test("thinking level changes are material only when they change the wire params", () => {
  // Wire mapping mirrors pi-ai's mapThinkingLevelToEffort + the off→disabled case.
  assert.equal(wireThinkingEffort(undefined, "minimal"), "low");
  assert.equal(wireThinkingEffort(undefined, "xhigh"), "high", "unmapped xhigh falls back to high");
  assert.equal(wireThinkingEffort({ xhigh: "xhigh" }, "xhigh"), "xhigh");
  assert.equal(wireThinkingEffort(undefined, "off"), "off");

  assert.equal(thinkingLevelsDiffer(undefined, "low", "high"), true);
  assert.equal(thinkingLevelsDiffer(undefined, undefined, "high"), false, "unknown baseline: never invent a break");
  // claude-fable-5 (adaptive, map { xhigh: "xhigh" }): minimal→low is a wire no-op —
  // both become effort "low" (live-verified: byte-identical payload, 100% cache hit).
  const fable = { xhigh: "xhigh" } as Record<string, string | null>;
  assert.equal(thinkingLevelsDiffer(fable, "minimal", "low"), false);
  assert.equal(thinkingLevelsDiffer(fable, "low", "medium"), true, "effort low → medium changes output_config");
  assert.equal(thinkingLevelsDiffer(fable, "minimal", "off"), true, "off disables thinking on the wire");
  assert.equal(thinkingLevelsDiffer(fable, "off", "xhigh"), true);
  assert.equal(thinkingLevelsDiffer(fable, "xhigh", "high"), true);
});

test("anthropic TTL inference mirrors pi-ai's env resolution", () => {
  assert.equal(inferAnthropicTtlMs({}), 5 * MIN);
  assert.equal(inferAnthropicTtlMs({ PI_CACHE_RETENTION: "long" }), 60 * MIN);
  // Anything else falls through to short, exactly like pi-ai's resolveCacheRetention.
  assert.equal(inferAnthropicTtlMs({ PI_CACHE_RETENTION: "short" }), 5 * MIN);
});

test("run summary and miss lines read exactly as designed", () => {
  const run = {
    startedAt: 0, calls: 7, input: 3_400, cacheRead: 940_100, cacheWrite: 11_200,
    output: 4_200, costUsd: 0.092,
  };
  assert.equal(
    renderRunSummary(run, 161_000),
    "turn: 7 calls \u00b7 2m41s \u00b7 read 940.1k (99.6% cached) \u00b7 wrote 11.2k \u00b7 out 4.2k \u00b7 $0.092",
  );

  // Singular call, near-total hit rate collapsing to a clean "100", M-units past a
  // million so a 59-call turn reads 9.1M, not 9062.9k.
  const bigTurn = {
    startedAt: 0, calls: 1, input: 3_700, cacheRead: 9_062_900, cacheWrite: 222_900,
    output: 103_500, costUsd: 17.03,
  };
  assert.equal(
    renderRunSummary(bigTurn, 1_777_000),
    "turn: 1 call \u00b7 29m37s \u00b7 read 9.1M (100% cached) \u00b7 wrote 222.9k \u00b7 out 103.5k \u00b7 $17.03",
  );

  const miss: CallRecord = {
    index: 3, at: 0, gapMs: 6.7 * MIN,
    usage: { input: 1_400, output: 900, cacheRead: 0, cacheWrite: 138_200 },
    expectedRead: 138_200,
    classification: { kind: "miss", cause: { kind: "ttl", detail: "5m TTL reached after 6m42s idle" } },
    rewroteTokens: 138_200, costUsd: 0.52,
  };
  // prompt = 1.4k input + 0 read + 138.2k write = 139.6k; 138.2/139.6 → 99%
  assert.equal(
    renderMissLine(miss),
    "cache broke \u00b7 re-wrote 138.2k of 139.6k prompt (99%) \u00b7 $0.52 \u00b7 cause: 5m TTL reached after 6m42s idle",
  );

  const partial: CallRecord = {
    ...miss,
    usage: { ...miss.usage, cacheRead: 41_200 },
    classification: { kind: "partial", cause: { kind: "system", detail: "system prompt changed" } },
  };
  // prompt = 1.4k + 41.2k + 138.2k = 180.8k; rewrote 138.2k → 76%
  assert.equal(
    renderMissLine(partial),
    "cache partial \u00b7 read 41.2k of 138.2k expected \u00b7 re-wrote 138.2k (76% of prompt) \u00b7 cause: system prompt changed",
  );

  const held: CallRecord = {
    ...miss,
    usage: { ...miss.usage, cacheRead: 76_000 },
    expectedRead: 77_700,
    classification: { kind: "hit" },
  };
  assert.equal(renderHeldLine(held), "cache held \u00b7 read 76.0k of 77.7k expected \u00b7 prefix stayed warm");

  // After a model switch the old expectation must never be composed with the new
  // model's read: the line speaks this call's own currency only (design language §7).
  const switchedHeld: CallRecord = {
    ...miss,
    usage: { input: 0, output: 400, cacheRead: 28_200, cacheWrite: 0 },
    expectedRead: 20_600, // sol-billed tokens: wrong currency for a fable read
    classification: { kind: "hit" },
    switched: true,
  };
  assert.equal(
    renderHeldLine(switchedHeld),
    "cache held \u00b7 read 28.2k (100% of prompt) \u00b7 the new model already had the prefix cached",
  );
  const switchedPartial: CallRecord = {
    ...miss,
    usage: { input: 200, output: 400, cacheRead: 14_100, cacheWrite: 13_900 },
    expectedRead: 20_600,
    classification: { kind: "partial", cause: { kind: "model", detail: "model switched a \u2192 b" } },
    rewroteTokens: 13_900,
    switched: true,
  };
  assert.equal(
    renderMissLine(switchedPartial),
    "cache partial \u00b7 read 14.1k of 28.2k prompt \u00b7 re-wrote 13.9k (49% of prompt) \u00b7 cause: model switched a \u2192 b",
  );
});

test("break prediction: knowable at request time, silent when healthy", () => {
  const base = { isFirst: false, inCompaction: false, compacted: false, expectedRead: 138_200, rates: RATES };

  // Healthy paths predict nothing.
  assert.equal(predictBreak({ ...base, gapMs: 30_000, window: CONTRACT_5M }), undefined);
  assert.equal(predictBreak({ ...base, isFirst: true, gapMs: 590 * MIN, window: CONTRACT_5M }), undefined);
  assert.equal(predictBreak({ ...base, inCompaction: true, gapMs: 590 * MIN, window: CONTRACT_5M }), undefined);
  assert.equal(predictBreak({ ...base, expectedRead: 0, gapMs: 590 * MIN, window: CONTRACT_5M }), undefined);
  // Unknown window: no contract, no definite prediction.
  assert.equal(predictBreak({ ...base, gapMs: 590 * MIN }), undefined);
  // A maximum says nothing before the boundary, but is definite at the boundary.
  assert.equal(predictBreak({ ...base, gapMs: 23 * 60 * MIN, window: OPENAI_EXTENDED_WINDOW }), undefined);
  assert.equal(
    predictBreak({ ...base, gapMs: 24 * 60 * MIN, window: OPENAI_EXTENDED_WINDOW })!.cause.detail,
    "24h retention maximum reached after 24h idle",
  );

  // Past TTL: sized from the last call's provider-billed prompt.
  const ttl = predictBreak({ ...base, gapMs: 590 * MIN, window: CONTRACT_5M })!;
  assert.equal(ttl.cause.kind, "ttl");
  assert.equal(ttl.expectedRewriteTokens, 138_200);
  assert.equal(ttl.expectedUsd, 2.591_25); // 138.2k at $18.75/M write
  assert.equal(
    renderBreakingLine(ttl),
    "cache breaking \u00b7 re-writing ~138.2k (~$2.59) \u00b7 cause: 5m TTL reached after 9h50m idle",
  );

  // A named segment mutation outranks the TTL explanation, same as classification.
  const tools = predictBreak({
    ...base, gapMs: 590 * MIN, window: CONTRACT_5M,
    fingerprintCause: { kind: "tools", detail: "tools changed (+2 added)" },
  })!;
  assert.equal(tools.cause.kind, "tools");

  // Model-switch predictions (sized target-currency estimates, warm-prior silence)
  // live in tests/cachemire/model-switch.test.ts.

  // Thinking change: a contract window (Anthropic, documented) predicts an unsized
  // re-write; a maximum predicts nothing because effort is outside the prompt prefix.
  // Budget changes carry the documented system/tools survival; adaptive effort changes
  // make no survival claim (live test on claude-fable-5: 100% of the prompt re-wrote).
  const budgetCause = { kind: "thinking", detail: "thinking changed (thinking budget 4096 \u2192 thinking budget 16384)" } as const;
  const budget = predictBreak({ ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: budgetCause })!;
  assert.equal(budget.expectedRewriteTokens, undefined);
  assert.equal(
    renderBreakingLine(budget),
    "cache breaking \u00b7 re-writing history (system/tools stay cached) \u00b7 cause: thinking changed (thinking budget 4096 \u2192 thinking budget 16384)",
  );
  const effortCause = { kind: "thinking", detail: "thinking changed (thinking effort xhigh \u2192 thinking effort low)" } as const;
  assert.equal(
    renderBreakingLine(predictBreak({ ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: effortCause })!),
    "cache breaking \u00b7 re-writing the prompt \u00b7 cause: thinking changed (thinking effort xhigh \u2192 thinking effort low)",
  );
  assert.equal(predictBreak({ ...base, gapMs: 1_000, window: OPENAI_EXTENDED_WINDOW, fingerprintCause: budgetCause }), undefined);

  // Compaction: the event is material but the new prefix size is unknowable.
  const compaction = predictBreak({ ...base, compacted: true, gapMs: 1_000, window: CONTRACT_5M })!;
  assert.equal(compaction.cause.kind, "compaction");
  assert.equal(compaction.expectedRewriteTokens, undefined);
  assert.equal(renderBreakingLine(compaction), "cache breaking \u00b7 re-writing changed history \u00b7 cause: history compacted");
});

test("ledger view: rows, totals, and the savings line", () => {
  const records: CallRecord[] = [
    {
      index: 1, at: 0, usage: { input: 12_100, output: 400, cacheRead: 0, cacheWrite: 138_200 },
      expectedRead: 0, classification: { kind: "cold", cause: { kind: "cold", detail: "cold start" } },
      rewroteTokens: 138_200, costUsd: 0.55, uncachedUsd: 0.58,
    },
    {
      index: 2, at: 14_000, gapMs: 14_000,
      usage: { input: 1_200, output: 1_100, cacheRead: 150_300, cacheWrite: 1_800 },
      expectedRead: 150_300, classification: { kind: "hit" },
      rewroteTokens: 1_800, costUsd: 0.04, uncachedUsd: 2.38,
    },
  ];
  const lines = renderLedger(records, { providerLabel: "anthropic", window: CONTRACT_5M, modelLabel: "anthropic/claude-opus-4-8" });
  // Panel-header form (design language §8): [Cachemire] brand, then the dim hint line
  // carrying the descriptive title and provider profile.
  assert.match(lines[0]!, /\[Cachemire\]/);
  assert.match(lines[1]!, /cache & loop ledger · anthropic · 5m TTL · anthropic\/claude-opus-4-8/);
  assert.match(lines[3]!, /^\s+1\s+—\s+12\.1k\s+0\.0k\s+138\.2k\s+0\.4k\s+\$0\.55\s+○ cold start$/);
  assert.match(lines[4]!, /14s.*150\.3k.*● hit$/);
  assert.match(lines[5]!, /totals: 2 calls · input 13\.3k · read 150\.3k · wrote 140\.0k · out 1\.5k · \$0\.59/);
  assert.match(lines[6]!, /caching saved ~\$2\.37 vs uncached \$2\.96 \(−80%\) · API-priced; notional on subscription/);

  assert.match(renderLedger([], {})[2]!, /no model calls yet/);
});
