// Visual regression net for meantime's user-facing strings (design language §11):
// every widget phase, the anomaly notice lines, and the /pace panel (header, aligned
// columns, notes, totals, share bar). Colour is not under test (see docs/testing.md);
// wording, glyphs, alignment, and fact order are. Regenerate with UPDATE_GOLDENS=1
// npm test and review the diff like code.
import { test } from "node:test";

import {
  renderPace,
  renderSlowStartLine,
  renderSlowStreamLine,
  tempoWidget,
  type WidgetSnapshot,
} from "../../extensions/pi-meantime/render.ts";
import {
  newLiveCall,
  sessionTotals,
  DEFAULT_CONFIG,
  type CallTiming,
  type LiveCall,
} from "../../extensions/pi-meantime/timing.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { expectGolden, plainTheme } from "../helpers.ts";

function call(index: number, overrides: Partial<CallTiming>): CallTiming {
  return {
    index,
    requestAt: 0,
    thinkMs: 0,
    writeMs: 0,
    streamChars: 0,
    totalMs: 0,
    outputTokens: 0,
    silentReasoning: false,
    uncachedPromptTokens: 0,
    ...overrides,
  };
}

// A realistic session: three healthy calls, a slow silent-reasoning start with
// overlapped tools and a harness stall, then a collapsed stream rate.
const CALLS: CallTiming[] = [
  call(1, {
    ttftMs: 1_900, thinkMs: 42_000, writeMs: 8_000, streamChars: 6_100, totalMs: 82_000,
    outputTokens: 2_100, tokPerSec: 48, uncachedPromptTokens: 138_200,
    toolsMs: 31_000, toolsCount: 2, toolsOverlapMs: 0, harnessMs: 300,
  }),
  call(2, {
    ttftMs: 1_700, writeMs: 12_000, streamChars: 2_400, totalMs: 15_000,
    outputTokens: 800, tokPerSec: 41, uncachedPromptTokens: 1_100,
    toolsMs: 4_200, toolsCount: 1, toolsOverlapMs: 0, harnessMs: 200,
  }),
  call(3, {
    ttftMs: 2_100, thinkMs: 6_000, writeMs: 9_000, streamChars: 3_900, totalMs: 18_000,
    outputTokens: 1_200, tokPerSec: 52, uncachedPromptTokens: 900,
    toolsMs: 0, toolsCount: 0, toolsOverlapMs: 0, harnessMs: 150,
  }),
  call(4, {
    ttftMs: 14_200, writeMs: 5_000, streamChars: 1_800, totalMs: 20_000,
    outputTokens: 700, reasoningTokens: 450, silentReasoning: true,
    uncachedPromptTokens: 145_300,
    toolsMs: 22_000, toolsCount: 3, toolsOverlapMs: 12_000, harnessMs: 4_100,
  }),
  call(5, {
    ttftMs: 2_000, writeMs: 180_000, streamChars: 6_800, totalMs: 192_000,
    outputTokens: 2_100, tokPerSec: 11, uncachedPromptTokens: 1_000,
  }),
];

function liveThinking(): LiveCall {
  const live = newLiveCall(6, 0);
  live.firstTokenAt = 1_900;
  live.segment = { kind: "thinking", startedAt: 1_900 };
  live.lastKind = "thinking";
  live.thinkChars = 6_050;
  live.sawThinkingStream = true;
  return live;
}

function liveWriting(): LiveCall {
  const live = newLiveCall(6, 0);
  live.firstTokenAt = 1_000;
  live.thinkMs = 30_000;
  live.segment = { kind: "writing", startedAt: 31_000 };
  live.lastKind = "writing";
  live.writeChars = 1_150;
  return live;
}

test("meantime widget, notices, and /pace panel golden", () => {
  const widget = (label: string, snap: WidgetSnapshot) => {
    const line = tempoWidget(snap);
    return `[${label}] ${line ? `(${line.tone}) \u25cd ${line.text}` : "(hidden)"}`;
  };
  const base = { charsPerToken: 2.9, openTools: 0, runActive: true, toolElapsedMs: 0 };

  const lines = [
    "=== widget states ===",
    widget("waiting", { ...base, now: 3_000, live: newLiveCall(6, 0) }),
    widget("waiting-slow", {
      ...base, now: 14_000, live: newLiveCall(6, 0),
      slowStartBar: { medianMs: 1_900, thresholdMs: 5_700 },
    }),
    widget("thinking", { ...base, now: 43_900, live: liveThinking() }),
    widget("writing", { ...base, now: 39_000, live: liveWriting() }),
    widget("tools", { ...base, now: 31_000, openTools: 1, toolElapsedMs: 31_000 }),
    widget("tools-parallel", { ...base, now: 31_000, openTools: 3, toolElapsedMs: 31_000 }),
    widget("idle", { ...base, now: 1_000, runActive: false }),
    "",
    "=== notices (chat lines) ===",
    `\u25cd ${renderSlowStartLine(CALLS[3]!, { ttftMs: 14_200, medianMs: 1_900 }, DEFAULT_CONFIG.prefillCauseTokens)}`,
    `\u25cd ${renderSlowStartLine(CALLS[4]!, { ttftMs: 11_800, medianMs: 1_900 }, DEFAULT_CONFIG.prefillCauseTokens)}`,
    `\u25cd ${renderSlowStreamLine(CALLS[4]!, { rate: 11, medianRate: 48 })}`,
    "",
    "=== /pace panel ===",
    ...renderPace(
      CALLS,
      sessionTotals(CALLS, { startedAt: 0, now: 6_120_000, idleMs: 5_400_000, idleSince: 6_000_000 }),
      { config: DEFAULT_CONFIG, theme: plainTheme, modelLabel: "anthropic/claude-opus-4-8" },
    ),
    "",
    "=== /pace panel (empty) ===",
    ...renderPace(
      [],
      sessionTotals([], { startedAt: 0, now: 60_000, idleMs: 0, idleSince: 0 }),
      { config: DEFAULT_CONFIG, theme: plainTheme },
    ),
  ];

  expectGolden("meantime-lines.txt", `${lines.map((line) => stripAnsi(line)).join("\n")}\n`);
});
