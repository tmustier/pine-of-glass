// Cachemire economics (hand-computed) and the exact user-facing strings.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";
import type { CallRecord } from "../../extensions/pi-cachemire/index.ts";

const {
  uncachedCostUsd, rewriteCostUsd, sessionSavings,
  formatTokensK, formatUsd, formatDuration,
  cacheClock, renderRunSummary, renderMissLine, renderLedger, restoreFromMessages,
  inferAnthropicTtlMs, predictBreak, renderBreakingLine, renderHeldLine,
} = internals;

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
  assert.equal(formatTokensK(940_100), "940.1k");
  assert.equal(formatTokensK(312), "312");
  assert.equal(formatUsd(0.523), "$0.52");
  assert.equal(formatUsd(0.0523), "$0.052");
  assert.equal(formatDuration(41_000), "41s");
  assert.equal(formatDuration(161_000), "2m41s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(64 * MIN), "1h4m");
});

test("cache clock phases", () => {
  assert.equal(cacheClock({ now: 0 }).phase, "idle");

  // Fresh: coarse 15s steps above 90s remaining, so the widget re-renders sparsely.
  const fresh = cacheClock({ now: 100_000, lastRequestAt: 0, ttlMs: 5 * MIN });
  assert.equal(fresh.phase, "fresh");
  assert.equal(fresh.text, "cache 3m15s"); // 200s remaining → floored to 195s

  const closing = cacheClock({ now: 4 * MIN + 15_000, lastRequestAt: 0, ttlMs: 5 * MIN });
  assert.equal(closing.phase, "closing");
  assert.equal(closing.text, "cache 45s");

  const cold = cacheClock({ now: 6 * MIN, lastRequestAt: 0, ttlMs: 5 * MIN, cachedTokens: 142_300, rewriteUsd: 2.67 });
  assert.equal(cold.phase, "cold");
  assert.equal(cold.text, "cache cold \u00b7 next send re-writes ~142.3k (~$2.67)");

  // No TTL contract (OpenAI etc.): soft language, but the re-send size is still exact.
  assert.equal(cacheClock({ now: 3 * MIN, lastRequestAt: 0 }).text, "cache likely warm \u00b7 3m since last call");
  const coldUnknown = cacheClock({ now: 535 * MIN, lastRequestAt: 0, cachedTokens: 109_800, rewriteUsd: 1.37 });
  assert.equal(coldUnknown.phase, "cold-unknown");
  assert.equal(coldUnknown.text, "cache likely cold (idle 8h55m) \u00b7 next send re-sends ~109.8k uncached (~$1.37)");
  // Without token info the bare form survives (e.g. before any usage was ever observed).
  assert.equal(cacheClock({ now: 12 * MIN, lastRequestAt: 0 }).text, "cache likely cold (idle 12m)");

  // Compaction invalidates the timed prefix outright — TTL is moot until the next send.
  const stale = cacheClock({ now: MIN, lastRequestAt: 0, ttlMs: 5 * MIN, cachedTokens: 142_300, compacted: true });
  assert.equal(stale.phase, "stale");
  assert.equal(stale.text, "cache stale \u00b7 history compacted \u00b7 next send re-writes the new prefix");
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

  const miss: CallRecord = {
    index: 3, at: 0, gapMs: 6.7 * MIN,
    usage: { input: 1_400, output: 900, cacheRead: 0, cacheWrite: 138_200 },
    expectedRead: 138_200,
    classification: { kind: "miss", cause: { kind: "ttl", detail: "idle 6m42s > 5m TTL" } },
    rewroteTokens: 138_200, costUsd: 0.52,
  };
  // prompt = 1.4k input + 0 read + 138.2k write = 139.6k; 138.2/139.6 → 99%
  assert.equal(
    renderMissLine(miss),
    "cache broke \u00b7 re-wrote 138.2k of 139.6k prompt (99%) \u00b7 $0.52 \u00b7 cause: idle 6m42s > 5m TTL",
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
});

test("break prediction: knowable at request time, silent when healthy", () => {
  const base = { isFirst: false, inCompaction: false, compacted: false, expectedRead: 138_200, rates: RATES };

  // Healthy paths predict nothing.
  assert.equal(predictBreak({ ...base, gapMs: 30_000, ttlMs: 5 * MIN }), undefined);
  assert.equal(predictBreak({ ...base, isFirst: true, gapMs: 590 * MIN, ttlMs: 5 * MIN }), undefined);
  assert.equal(predictBreak({ ...base, inCompaction: true, gapMs: 590 * MIN, ttlMs: 5 * MIN }), undefined);
  assert.equal(predictBreak({ ...base, expectedRead: 0, gapMs: 590 * MIN, ttlMs: 5 * MIN }), undefined);
  // Unknown TTL: no contract, no definite prediction.
  assert.equal(predictBreak({ ...base, gapMs: 590 * MIN }), undefined);

  // Past TTL: sized from the last call's provider-billed prompt.
  const ttl = predictBreak({ ...base, gapMs: 590 * MIN, ttlMs: 5 * MIN })!;
  assert.equal(ttl.cause.kind, "ttl");
  assert.equal(ttl.expectedRewriteTokens, 138_200);
  assert.equal(ttl.expectedUsd, 2.591_25); // 138.2k at $18.75/M write
  assert.equal(
    renderBreakingLine(ttl),
    "cache breaking \u00b7 re-writing ~138.2k (~$2.59) \u00b7 cause: idle 9h50m > 5m TTL",
  );

  // A named segment mutation outranks the TTL explanation, same as classification.
  const tools = predictBreak({
    ...base, gapMs: 590 * MIN, ttlMs: 5 * MIN,
    fingerprintCause: { kind: "tools", detail: "tools changed (+2 added)" },
  })!;
  assert.equal(tools.cause.kind, "tools");

  // Compaction: the event is material but the new prefix size is unknowable.
  const compaction = predictBreak({ ...base, compacted: true, gapMs: 1_000, ttlMs: 5 * MIN })!;
  assert.equal(compaction.cause.kind, "compaction");
  assert.equal(compaction.expectedRewriteTokens, undefined);
  assert.equal(renderBreakingLine(compaction), "cache breaking \u00b7 re-writing the new prefix \u00b7 cause: history compacted");
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
  const lines = renderLedger(records, { providerLabel: "anthropic", ttlMs: 5 * MIN, modelLabel: "anthropic/claude-opus-4-8" });
  assert.match(lines[0]!, /Cachemire — cache & loop ledger\s+anthropic · 5m TTL · anthropic\/claude-opus-4-8/);
  assert.match(lines[2]!, /^\s+1\s+—\s+12\.1k\s+0\s+138\.2k\s+400\s+\$0\.55\s+○ cold start$/);
  assert.match(lines[3]!, /14s.*150\.3k.*● hit$/);
  assert.match(lines[4]!, /totals: 2 calls · input 13\.3k · read 150\.3k · wrote 140\.0k · out 1\.5k · \$0\.59/);
  assert.match(lines[5]!, /caching saved ~\$2\.37 vs uncached \$2\.96 \(−80%\) · API-priced; notional on subscription/);

  assert.match(renderLedger([], {})[1]!, /no model calls yet/);
});

test("ledger restore from a continued session's assistant messages", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 0 },
    {
      role: "assistant", timestamp: 1_000,
      usage: { input: 12_000, output: 500, cacheRead: 0, cacheWrite: 130_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
    },
    { role: "toolResult", toolName: "bash", timestamp: 2_000 },
    {
      role: "assistant", timestamp: 30_000,
      usage: { input: 1_000, output: 800, cacheRead: 141_000, cacheWrite: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 } },
    },
    { role: "assistant", timestamp: 31_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, // empty usage → skipped
  ];
  const records = restoreFromMessages(messages as never);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.classification.kind, "cold");
  assert.equal(records[1]!.classification.kind, "hit");
  assert.equal(records[1]!.gapMs, 29_000);
  assert.ok(records.every((record) => record.restored));
});
