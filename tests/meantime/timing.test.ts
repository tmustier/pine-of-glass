// pi-meantime timing model: the segment state machine, resolution arithmetic, interval
// union, relative baselines, calibration, and config parsing. These encode the design
// language §10.1 honesty rules; a wrong answer here renders as a plausible-looking
// number a human cannot re-derive, which is exactly the docs/testing.md layer-2 risk.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyStreamEvent,
  attachPhase,
  baselineFor,
  calibratedCharsPerToken,
  detectSlowStart,
  detectSlowStream,
  liveToolWallClock,
  median,
  newLiveCall,
  parseMeantimeConfig,
  resolveCall,
  sessionTotals,
  unionIntervals,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_CONFIG,
  type CallTiming,
  type UsageLike,
} from "../../extensions/pi-meantime/timing.ts";

const USAGE: UsageLike = { input: 1_200, output: 2_000, cacheRead: 100_000, cacheWrite: 3_000 };

function call(overrides: Partial<CallTiming>): CallTiming {
  return {
    index: 1,
    requestAt: 0,
    ttftMs: 2_000,
    thinkMs: 0,
    writeMs: 1_000,
    streamChars: 6_000,
    totalMs: 10_000,
    outputTokens: 2_000,
    silentReasoning: false,
    uncachedPromptTokens: 4_200,
    tokPerSec: 40,
    ...overrides,
  };
}

// --- segment machine ----------------------------------------------------------------------

test("segment machine: first content sets TTFT; the bare start event does not", () => {
  const live = newLiveCall(1, 0);
  applyStreamEvent(live, "start", 0, 500);
  assert.equal(live.firstTokenAt, undefined);
  applyStreamEvent(live, "thinking_start", 0, 1_900);
  assert.equal(live.firstTokenAt, 1_900);
  assert.equal(live.segment?.kind, "thinking");
  assert.equal(live.sawThinkingStream, true);
});

test("segment machine: spans run start to end, so intra-segment stalls belong to the segment", () => {
  const live = newLiveCall(1, 0);
  applyStreamEvent(live, "thinking_start", 0, 1_000);
  applyStreamEvent(live, "thinking_delta", 40, 2_000);
  applyStreamEvent(live, "thinking_delta", 40, 9_000); // 7s stall inside thinking
  applyStreamEvent(live, "thinking_end", 0, 10_000);
  assert.equal(live.thinkMs, 9_000);
  assert.equal(live.thinkChars, 80);
  assert.equal(live.writeMs, 0);
});

test("segment machine: a kind change closes the open segment even without an end event", () => {
  const live = newLiveCall(1, 0);
  applyStreamEvent(live, "thinking_delta", 10, 1_000);
  applyStreamEvent(live, "text_delta", 20, 4_000); // no thinking_end seen
  applyStreamEvent(live, "text_end", 0, 6_000);
  assert.equal(live.thinkMs, 3_000);
  assert.equal(live.writeMs, 2_000);
  assert.equal(live.writeChars, 20);
  assert.equal(live.lastKind, "writing");
});

test("segment machine: tool-argument streaming is writing (the model emitting tokens)", () => {
  const live = newLiveCall(1, 0);
  applyStreamEvent(live, "text_delta", 15, 1_000);
  applyStreamEvent(live, "text_end", 0, 2_000);
  applyStreamEvent(live, "toolcall_start", 0, 2_100);
  applyStreamEvent(live, "toolcall_delta", 85, 2_500);
  applyStreamEvent(live, "toolcall_end", 0, 3_100);
  assert.equal(live.writeMs, 2_000); // 1000→2000 text + 2100→3100 toolcall
  assert.equal(live.writeChars, 100);
  assert.equal(live.sawThinkingStream, false);
});

// --- resolution -----------------------------------------------------------------------------

test("resolveCall: ttft, exact rate over the stream span, and prefill evidence", () => {
  const live = newLiveCall(3, 0);
  applyStreamEvent(live, "text_delta", 50, 2_000);
  const resolved = resolveCall(live, USAGE, 12_000, "claude-opus-4-8");
  assert.equal(resolved.ttftMs, 2_000);
  assert.equal(resolved.totalMs, 12_000);
  assert.equal(resolved.tokPerSec, 2_000 / 10); // output ÷ (streamEnd − firstToken)
  assert.equal(resolved.uncachedPromptTokens, 4_200); // input + cacheWrite
  assert.equal(resolved.silentReasoning, false);
  assert.equal(resolved.writeMs, 10_000); // open segment closed at resolution
});

test("resolveCall: reasoning tokens with no thinking stream marks silent reasoning", () => {
  const live = newLiveCall(1, 0);
  applyStreamEvent(live, "text_delta", 10, 8_000); // long silent gap, then text
  const resolved = resolveCall(live, { ...USAGE, reasoning: 900 }, 10_000);
  assert.equal(resolved.silentReasoning, true);
  assert.equal(resolved.tokPerSec, undefined, "unobserved reasoning time makes a resolved rate incomparable");
  const streamed = resolveCall(
    (() => {
      const l = newLiveCall(2, 0);
      applyStreamEvent(l, "thinking_delta", 10, 1_000);
      return l;
    })(),
    { ...USAGE, reasoning: 900 },
    5_000,
  );
  assert.equal(streamed.silentReasoning, false);
});

test("resolveCall: no content ever streamed → no ttft, no rate claimed", () => {
  const resolved = resolveCall(newLiveCall(1, 0), USAGE, 5_000);
  assert.equal(resolved.ttftMs, undefined);
  assert.equal(resolved.tokPerSec, undefined);
});

// --- tool phase -----------------------------------------------------------------------------

test("unionIntervals: wall-clock union, overlap = summed − union", () => {
  assert.deepEqual(unionIntervals([]), { unionMs: 0, overlapMs: 0 });
  assert.deepEqual(
    unionIntervals([{ start: 0, end: 1_000 }, { start: 2_000, end: 3_000 }]),
    { unionMs: 2_000, overlapMs: 0 },
  );
  assert.deepEqual(
    unionIntervals([{ start: 0, end: 2_000 }, { start: 1_000, end: 3_000 }]),
    { unionMs: 3_000, overlapMs: 1_000 },
  );
  // nested: the inner interval is pure overlap
  assert.deepEqual(
    unionIntervals([{ start: 0, end: 4_000 }, { start: 1_000, end: 2_000 }]),
    { unionMs: 4_000, overlapMs: 1_000 },
  );
});

test("liveToolWallClock: excludes harness gaps and parallel overlap", () => {
  const completed = [{ start: 10_000, end: 13_000 }];
  // A 10s pre-tool harness gap and a 2s gap between batches are not tool time. The two
  // open tools overlap, so their 5s union contributes once: 3s completed + 5s open.
  assert.equal(liveToolWallClock(completed, [15_000, 16_000], 20_000), 8_000);
});

test("attachPhase: harness = phase span − tool wall-clock, only at a request boundary", () => {
  const timed = call({});
  attachPhase(timed, [{ start: 1_000, end: 3_000 }], 500, 3_600, true);
  assert.equal(timed.toolsMs, 2_000);
  assert.equal(timed.toolsCount, 1);
  assert.equal(timed.harnessMs, 1_100); // 3100 span − 2000 tools
  const untimed = call({});
  attachPhase(untimed, [{ start: 0, end: 1_000 }], 0, 1_000, false);
  assert.equal(untimed.harnessMs, undefined); // run ended: no honest end boundary
});

// --- baselines ------------------------------------------------------------------------------

test("median: odd and even counts", () => {
  assert.equal(median([]), undefined);
  assert.equal(median([3]), 3);
  assert.equal(median([1, 9, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test("baselineFor: per-model filter and sample count", () => {
  const calls = [
    call({ ttftMs: 1_000, model: "a" }),
    call({ ttftMs: 3_000, model: "b" }),
    call({ ttftMs: 2_000, model: "a" }),
  ];
  assert.deepEqual(baselineFor(calls, "a", (c) => c.ttftMs), { median: 1_500, samples: 2 });
  assert.deepEqual(baselineFor(calls, undefined, (c) => c.ttftMs), { median: 2_000, samples: 3 });
  assert.equal(baselineFor([], "a", (c) => c.ttftMs), undefined);
});

test("detectSlowStart: needs samples, the absolute floor, and the relative factor", () => {
  const prior = [call({ ttftMs: 1_900 }), call({ ttftMs: 1_700 }), call({ ttftMs: 2_100 })];
  // 3× median (1900) = 5700; also above the 5s floor
  assert.deepEqual(
    detectSlowStart(call({ ttftMs: 14_200 }), prior, DEFAULT_CONFIG),
    { ttftMs: 14_200, medianMs: 1_900 },
  );
  assert.equal(detectSlowStart(call({ ttftMs: 5_600 }), prior, DEFAULT_CONFIG), undefined); // < 3× median
  assert.equal(detectSlowStart(call({ ttftMs: 14_200 }), prior.slice(0, 2), DEFAULT_CONFIG), undefined); // too few samples
  const fastPrior = [call({ ttftMs: 900 }), call({ ttftMs: 1_000 }), call({ ttftMs: 1_100 })];
  assert.equal(detectSlowStart(call({ ttftMs: 4_000 }), fastPrior, DEFAULT_CONFIG), undefined); // 4× median but under floor
  assert.equal(detectSlowStart(call({ ttftMs: undefined }), prior, DEFAULT_CONFIG), undefined);
});

test("detectSlowStream: collapsed rate on calls with enough output", () => {
  const prior = [call({ tokPerSec: 48 }), call({ tokPerSec: 41 }), call({ tokPerSec: 52 })];
  assert.deepEqual(
    detectSlowStream(call({ tokPerSec: 11, outputTokens: 2_100 }), prior, DEFAULT_CONFIG),
    { rate: 11, medianRate: 48 },
  );
  assert.equal(detectSlowStream(call({ tokPerSec: 30, outputTokens: 2_100 }), prior, DEFAULT_CONFIG), undefined);
  assert.equal(detectSlowStream(call({ tokPerSec: 11, outputTokens: 100 }), prior, DEFAULT_CONFIG), undefined);
});

// --- calibration ----------------------------------------------------------------------------

test("calibratedCharsPerToken: last eligible call wins; silent reasoning is excluded", () => {
  assert.equal(calibratedCharsPerToken([]), DEFAULT_CHARS_PER_TOKEN);
  const calls = [
    call({ streamChars: 5_000, outputTokens: 2_000 }), // 2.5
    call({ streamChars: 9_000, outputTokens: 3_000 }), // 3.0
    call({ streamChars: 400, outputTokens: 4_000, silentReasoning: true }), // excluded: undercounts
    call({ streamChars: 100, outputTokens: 20 }), // excluded: too little signal
  ];
  assert.equal(calibratedCharsPerToken(calls), 3.0);
  const modelCalls = [call({ streamChars: 5_200, outputTokens: 2_000, model: "a" }), call({ streamChars: 9_000, outputTokens: 3_000, model: "b" })];
  assert.equal(calibratedCharsPerToken(modelCalls, "a"), 2.6);
});

// --- session totals ---------------------------------------------------------------------------

test("sessionTotals: bucket sums, open idle interval, active = span − idle", () => {
  const calls = [
    call({ ttftMs: 2_000, thinkMs: 42_000, writeMs: 8_000, toolsMs: 31_000, harnessMs: 300 }),
    call({ ttftMs: 14_000, thinkMs: 0, writeMs: 12_000, toolsMs: undefined, harnessMs: undefined }),
  ];
  const totals = sessionTotals(calls, { startedAt: 0, now: 600_000, idleMs: 400_000, idleSince: 550_000 });
  assert.equal(totals.calls, 2);
  assert.equal(totals.waitingMs, 16_000);
  assert.equal(totals.thinkingMs, 42_000);
  assert.equal(totals.writingMs, 20_000);
  assert.equal(totals.toolsMs, 31_000);
  assert.equal(totals.harnessMs, 300);
  assert.equal(totals.idleMs, 450_000); // closed + still-open interval
  assert.equal(totals.spanMs, 600_000);
  assert.equal(totals.activeMs, 150_000);
});

// --- config -----------------------------------------------------------------------------------

test("parseMeantimeConfig: permissive at the boundary, precise at the call site", () => {
  assert.deepEqual(parseMeantimeConfig(null), {});
  assert.deepEqual(parseMeantimeConfig("nope"), {});
  assert.deepEqual(
    parseMeantimeConfig({ widget: false, slowStartFloorMs: 8_000, slowStreamMinTokens: 500.9, baselineMinCalls: -2, junk: 1 }),
    { widget: false, slowStartFloorMs: 8_000, slowStreamMinTokens: 500 },
  );
});
