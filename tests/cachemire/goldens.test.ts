// Visual regression net for cachemire's user-facing strings (design language §9/cachemire):
// the /cache ledger panel (header, status-scale rows, totals, savings) and every one-line
// ◍ surface — clock states, break notices, resolutions, and the turn summary. Colour is
// not under test (see docs/testing.md); wording, glyphs, alignment, and fact order are.
// Regenerate with UPDATE_GOLDENS=1 npm test and review the diff like code.
import { test } from "node:test";

import { internals } from "../../extensions/pi-cachemire/index.ts";
import type { CallRecord } from "../../extensions/pi-cachemire/index.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { expectGolden } from "../helpers.ts";

const {
  renderLedger, renderRunSummary, renderMissLine, renderHeldLine, renderBreakingLine, cacheClock,
} = internals;

const CONTRACT_5M = { kind: "contract", ttlMs: 5 * 60_000, source: "observed" } as const;
const MIN = 60_000;

// A realistic four-call session: cold start, warm hit, unexplained partial, TTL miss.
const RECORDS: CallRecord[] = [
  {
    index: 1, at: 0, usage: { input: 12_100, output: 400, cacheRead: 0, cacheWrite: 138_200 },
    expectedRead: 0, classification: { kind: "cold", cause: { kind: "cold", detail: "cold start" } },
    rewroteTokens: 138_200, costUsd: 0.55, uncachedUsd: 0.58,
  },
  {
    index: 2, at: 14_000, gapMs: 14_000,
    usage: { input: 1_200, output: 1_100, cacheRead: 150_300, cacheWrite: 1_800 },
    expectedRead: 150_300, classification: { kind: "hit" },
    rewroteTokens: 1_800, costUsd: 0.04, uncachedUsd: 2.38, restored: true,
  },
  {
    index: 3, at: 2 * MIN, gapMs: 106_000,
    usage: { input: 200, output: 900, cacheRead: 90_000, cacheWrite: 62_100 },
    expectedRead: 152_100, classification: { kind: "partial", cause: { kind: "unknown", detail: "unknown (provider-side eviction?)" } },
    rewroteTokens: 62_100, costUsd: 1.21, uncachedUsd: 2.41,
  },
  {
    index: 4, at: 9 * MIN, gapMs: 7 * MIN,
    usage: { input: 200, output: 1_400, cacheRead: 0, cacheWrite: 153_000 },
    expectedRead: 153_200, classification: { kind: "miss", cause: { kind: "ttl", detail: "idle 7m00s > 5m TTL" } },
    rewroteTokens: 153_000, costUsd: 2.97, uncachedUsd: 2.40,
  },
];

test("cachemire ledger and one-line surfaces golden", () => {
  const clock = (input: Parameters<typeof cacheClock>[0]) => {
    const state = cacheClock(input);
    return `[${state.phase}] \u25cd ${state.text}`;
  };
  const base = { lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 150_300, rewriteUsd: 2.82 };

  const lines = [
    "=== /cache ledger ===",
    ...renderLedger(RECORDS, { providerLabel: "anthropic", window: CONTRACT_5M, modelLabel: "anthropic/claude-opus-4-8" }),
    "",
    "=== clock states (widget) ===",
    clock({ now: 1 * MIN, ...base }),
    clock({ now: 4.5 * MIN, ...base }),
    clock({ now: 6 * MIN, ...base }),
    clock({ now: 1 * MIN, ...base, compacted: true }),
    clock({ now: 1 * MIN, ...base, thinkingChanged: true }),
    clock({ now: 1 * MIN, ...base, modelSwitched: true, oldModelId: "claude-opus-4-8" }),
    clock({ now: 70 * MIN, lastRequestAt: 0, window: { kind: "band", softMs: 5 * MIN, hardMs: 60 * MIN }, cachedTokens: 64_300, rewriteUsd: 0.12 }),
    "",
    "=== notices (chat lines) ===",
    `\u25cd ${renderBreakingLine({ cause: { kind: "ttl", detail: "idle 7m00s > 5m TTL" }, expectedRewriteTokens: 150_300, expectedUsd: 2.82 })}`,
    `\u25cd ${renderBreakingLine({ cause: { kind: "compaction", detail: "history compacted" } })}`,
    `\u25cd ${renderMissLine(RECORDS[3]!)}`,
    `\u25cd ${renderMissLine(RECORDS[2]!)}`,
    `\u25cd ${renderHeldLine(RECORDS[1]!)}`,
    `\u25cd ${renderRunSummary({ startedAt: 0, calls: 3, input: 2_400, cacheRead: 450_900, cacheWrite: 3_600, output: 1_200, costUsd: 0.18 }, 4 * MIN + 30_000)}`,
  ];

  expectGolden("cachemire-lines.txt", `${lines.map((line) => stripAnsi(line)).join("\n")}\n`);
});
