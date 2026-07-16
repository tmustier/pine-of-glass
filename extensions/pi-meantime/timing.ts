// pi-meantime timing model (design language §10): pure state machines and arithmetic,
// no pi imports. Every number here is an event-boundary observation measured in this
// process; nothing is provider-reported timing (none exists) and nothing is
// reconstructed from session history.

import { booleanValue, isJsonObject, positiveNumberValue } from "../_lib/boundary.ts";

// --- segments (design language §10.2) ---------------------------------------------------

/** Thinking is a streamed thinking span; writing is streamed text *and* tool-argument
 * spans (both are the model emitting output tokens). */
export type SegmentKind = "thinking" | "writing";

export interface LiveCall {
  index: number;
  /** before_provider_request time: the wait clock starts here. */
  requestAt: number;
  /** First typed content stream activity; TTFT = firstTokenAt - requestAt. */
  firstTokenAt?: number;
  segment?: { kind: SegmentKind; startedAt: number };
  /** Kind of the most recently open segment, for widget wording between segments. */
  lastKind?: SegmentKind;
  thinkMs: number;
  writeMs: number;
  thinkChars: number;
  writeChars: number;
  /** The stream carried visible thinking blocks (vs silent server-side reasoning). */
  sawThinkingStream: boolean;
}

export function newLiveCall(index: number, requestAt: number): LiveCall {
  return { index, requestAt, thinkMs: 0, writeMs: 0, thinkChars: 0, writeChars: 0, sawThinkingStream: false };
}

// pi-ai's AssistantMessageEvent types, mapped to segments. The bare "start" event is
// not content (Anthropic emits message_start before any block), so it never sets
// firstTokenAt: TTFT means first *content* activity (design language §10.1).
const SEGMENT_OF: Record<string, SegmentKind | undefined> = {
  thinking_start: "thinking",
  thinking_delta: "thinking",
  text_start: "writing",
  text_delta: "writing",
  toolcall_start: "writing",
  toolcall_delta: "writing",
};
const SEGMENT_END = new Set(["thinking_end", "text_end", "toolcall_end"]);

export function closeSegment(live: LiveCall, now: number): void {
  if (!live.segment) return;
  const span = Math.max(0, now - live.segment.startedAt);
  if (live.segment.kind === "thinking") live.thinkMs += span;
  else live.writeMs += span;
  live.segment = undefined;
}

/** Advance the segment machine by one typed stream event. Stalls inside a segment
 * belong to that segment (spans run start to end, not delta to delta). */
export function applyStreamEvent(live: LiveCall, type: string, deltaLength: number, now: number): void {
  const kind = SEGMENT_OF[type];
  if (kind !== undefined) {
    if (live.firstTokenAt === undefined) live.firstTokenAt = now;
    if (kind === "thinking") live.sawThinkingStream = true;
    if (live.segment?.kind !== kind) {
      closeSegment(live, now);
      live.segment = { kind, startedAt: now };
      live.lastKind = kind;
    }
    if (deltaLength > 0) {
      if (kind === "thinking") live.thinkChars += deltaLength;
      else live.writeChars += deltaLength;
    }
    return;
  }
  if (SEGMENT_END.has(type)) closeSegment(live, now);
}

// --- resolved calls ----------------------------------------------------------------------

export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported reasoning tokens (subset of output), when exposed. */
  reasoning?: number;
}

export interface CallTiming {
  index: number;
  requestAt: number;
  /** Request sent to first typed content event; undefined when no content ever streamed. */
  ttftMs?: number;
  thinkMs: number;
  writeMs: number;
  streamChars: number;
  /** Request sent to stream end. Columns do not claim to sum to this (§10.2). */
  totalMs: number;
  outputTokens: number;
  reasoningTokens?: number;
  /** usage.reasoning > 0 with no thinking blocks on the stream: the wait includes
   * silent reasoning, and streamed chars undercount output tokens. */
  silentReasoning: boolean;
  /** input + cacheWrite: the prompt tokens the provider had to prefill uncached.
   * The evidence behind a named slow-start cause (§10.1). */
  uncachedPromptTokens: number;
  /** Exact rate: provider output tokens over the observed stream span. */
  tokPerSec?: number;
  model?: string;
  /** Wall-clock union of the tool executions that followed this call. */
  toolsMs?: number;
  toolsCount?: number;
  /** Σ individual durations minus the union: 0 when sequential. */
  toolsOverlapMs?: number;
  /** Call end to next request, minus tool wall-clock: pi + extensions overhead.
   * Only measurable when another request followed. */
  harnessMs?: number;
}

export function resolveCall(live: LiveCall, usage: UsageLike, now: number, model?: string): CallTiming {
  closeSegment(live, now);
  const ttftMs = live.firstTokenAt !== undefined ? Math.max(0, live.firstTokenAt - live.requestAt) : undefined;
  const streamMs = live.firstTokenAt !== undefined ? Math.max(0, now - live.firstTokenAt) : 0;
  const silentReasoning = (usage.reasoning ?? 0) > 0 && !live.sawThinkingStream;
  return {
    index: live.index,
    requestAt: live.requestAt,
    ttftMs,
    thinkMs: live.thinkMs,
    writeMs: live.writeMs,
    streamChars: live.thinkChars + live.writeChars,
    totalMs: Math.max(0, now - live.requestAt),
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    silentReasoning,
    uncachedPromptTokens: usage.input + usage.cacheWrite,
    // Silent reasoning happened before the first observable content event, so its
    // provider-reported tokens and unobserved generation time cannot form an honest rate.
    tokPerSec: !silentReasoning && streamMs > 0 && usage.output > 0
      ? usage.output / (streamMs / 1000)
      : undefined,
    model,
  };
}

// --- tool phase (design language §10.1: wall-clock, never a sum) -------------------------

export interface Interval { start: number; end: number }

export function unionIntervals(intervals: Interval[]): { unionMs: number; overlapMs: number } {
  if (intervals.length === 0) return { unionMs: 0, overlapMs: 0 };
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let unionMs = 0;
  let summedMs = 0;
  let spanStart = sorted[0]!.start;
  let spanEnd = sorted[0]!.end;
  for (const interval of sorted) {
    summedMs += Math.max(0, interval.end - interval.start);
    if (interval.start > spanEnd) {
      unionMs += spanEnd - spanStart;
      spanStart = interval.start;
      spanEnd = interval.end;
    } else if (interval.end > spanEnd) {
      spanEnd = interval.end;
    }
  }
  unionMs += spanEnd - spanStart;
  return { unionMs, overlapMs: Math.max(0, summedMs - unionMs) };
}

/** Current tool union: harness gaps and parallel overlap do not contribute. */
export function liveToolWallClock(completed: Interval[], openStarts: Iterable<number>, now: number): number {
  const open = Array.from(openStarts, (start) => ({ start, end: now }));
  return unionIntervals([...completed, ...open]).unionMs;
}

/** Attach the phase that followed a call: its tool executions and, when another request
 * marked the boundary, the harness gap (phase span minus tool wall-clock). */
export function attachPhase(
  call: CallTiming,
  intervals: Interval[],
  phaseStartAt: number,
  endAt: number,
  endedByRequest: boolean,
): void {
  const { unionMs, overlapMs } = unionIntervals(intervals);
  call.toolsMs = unionMs;
  call.toolsCount = intervals.length;
  call.toolsOverlapMs = overlapMs;
  if (endedByRequest) call.harnessMs = Math.max(0, endAt - phaseStartAt - unionMs);
}

// --- baselines (design language §10.3: relative, per model, this session) ----------------

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const BASELINE_WINDOW = 20;

export function baselineFor(
  calls: CallTiming[],
  model: string | undefined,
  pick: (call: CallTiming) => number | undefined,
): { median: number; samples: number } | undefined {
  const values: number[] = [];
  for (let i = calls.length - 1; i >= 0 && values.length < BASELINE_WINDOW; i--) {
    const call = calls[i]!;
    if (model !== undefined && call.model !== undefined && call.model !== model) continue;
    const value = pick(call);
    if (value !== undefined) values.push(value);
  }
  const mid = median(values);
  return mid === undefined ? undefined : { median: mid, samples: values.length };
}

export interface SlowStart {
  ttftMs: number;
  medianMs: number;
}

export function detectSlowStart(call: CallTiming, prior: CallTiming[], config: MeantimeConfig): SlowStart | undefined {
  if (call.ttftMs === undefined) return undefined;
  const base = baselineFor(prior, call.model, (c) => c.ttftMs);
  if (!base || base.samples < config.baselineMinCalls) return undefined;
  if (call.ttftMs < config.slowStartFloorMs) return undefined;
  if (call.ttftMs < base.median * config.slowStartFactor) return undefined;
  return { ttftMs: call.ttftMs, medianMs: base.median };
}

export interface SlowStream {
  rate: number;
  medianRate: number;
}

export function detectSlowStream(call: CallTiming, prior: CallTiming[], config: MeantimeConfig): SlowStream | undefined {
  if (call.tokPerSec === undefined || call.outputTokens < config.slowStreamMinTokens) return undefined;
  const base = baselineFor(prior, call.model, (c) => c.tokPerSec);
  if (!base || base.samples < config.baselineMinCalls) return undefined;
  if (call.tokPerSec > base.median / config.slowStreamFactor) return undefined;
  return { rate: call.tokPerSec, medianRate: base.median };
}

// --- live-rate calibration (design language §10.1) ---------------------------------------

/** Starting ratio before any resolved evidence exists; the estimate wears `~` either way. */
export const DEFAULT_CHARS_PER_TOKEN = 3;
const CALIBRATION_MIN_TOKENS = 50;

/** Streamed chars over output tokens from the most recent resolved call with enough
 * signal. Silent-reasoning calls are excluded: their streamed chars undercount their
 * output tokens, which would inflate every live rate after them. */
export function calibratedCharsPerToken(calls: CallTiming[], model?: string): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (model !== undefined && call.model !== undefined && call.model !== model) continue;
    if (call.silentReasoning || call.outputTokens < CALIBRATION_MIN_TOKENS || call.streamChars <= 0) continue;
    return call.streamChars / call.outputTokens;
  }
  return DEFAULT_CHARS_PER_TOKEN;
}

// --- session totals (design language §10.2) ----------------------------------------------

export interface SessionTotals {
  calls: number;
  waitingMs: number;
  thinkingMs: number;
  writingMs: number;
  toolsMs: number;
  harnessMs: number;
  idleMs: number;
  /** Time this process has been watching; the whole of the share bar. */
  spanMs: number;
  activeMs: number;
}

export function sessionTotals(
  calls: CallTiming[],
  args: { startedAt: number; now: number; idleMs: number; idleSince?: number },
): SessionTotals {
  const idleMs = args.idleMs + (args.idleSince !== undefined ? Math.max(0, args.now - args.idleSince) : 0);
  const spanMs = Math.max(0, args.now - args.startedAt);
  const sum = (pick: (call: CallTiming) => number | undefined) =>
    calls.reduce((total, call) => total + (pick(call) ?? 0), 0);
  return {
    calls: calls.length,
    waitingMs: sum((call) => call.ttftMs),
    thinkingMs: sum((call) => call.thinkMs),
    writingMs: sum((call) => call.writeMs),
    toolsMs: sum((call) => call.toolsMs),
    harnessMs: sum((call) => call.harnessMs),
    idleMs,
    spanMs,
    activeMs: Math.max(0, spanMs - idleMs),
  };
}

// --- config (family convention: ~/.pi/agent/pi-meantime.json, <cwd>/.pi/pi-meantime.json)

export interface MeantimeConfig {
  widget: boolean;
  notices: boolean;
  /** Slow start: ttft ≥ factor × rolling median, and ≥ the absolute floor. */
  slowStartFactor: number;
  slowStartFloorMs: number;
  /** Slow stream: rate ≤ median ÷ factor, on calls with enough output to matter. */
  slowStreamFactor: number;
  slowStreamMinTokens: number;
  /** Resolved samples required before any baseline claim (short sessions stay silent). */
  baselineMinCalls: number;
  /** Uncached prompt tokens needed to name prefill as a slow-start cause. */
  prefillCauseTokens: number;
}

export const DEFAULT_CONFIG: MeantimeConfig = {
  widget: true,
  notices: true,
  slowStartFactor: 3,
  slowStartFloorMs: 5_000,
  slowStreamFactor: 3,
  slowStreamMinTokens: 300,
  baselineMinCalls: 3,
  prefillCauseTokens: 20_000,
};

export function parseMeantimeConfig(value: unknown): Partial<MeantimeConfig> {
  if (!isJsonObject(value)) return {};
  const config: Partial<MeantimeConfig> = {};
  const widget = booleanValue(value.widget);
  const notices = booleanValue(value.notices);
  const slowStartFactor = positiveNumberValue(value.slowStartFactor);
  const slowStartFloorMs = positiveNumberValue(value.slowStartFloorMs);
  const slowStreamFactor = positiveNumberValue(value.slowStreamFactor);
  const slowStreamMinTokens = positiveNumberValue(value.slowStreamMinTokens);
  const baselineMinCalls = positiveNumberValue(value.baselineMinCalls);
  const prefillCauseTokens = positiveNumberValue(value.prefillCauseTokens);
  if (widget !== undefined) config.widget = widget;
  if (notices !== undefined) config.notices = notices;
  if (slowStartFactor !== undefined) config.slowStartFactor = slowStartFactor;
  if (slowStartFloorMs !== undefined) config.slowStartFloorMs = slowStartFloorMs;
  if (slowStreamFactor !== undefined) config.slowStreamFactor = slowStreamFactor;
  if (slowStreamMinTokens !== undefined) config.slowStreamMinTokens = Math.floor(slowStreamMinTokens);
  if (baselineMinCalls !== undefined) config.baselineMinCalls = Math.floor(baselineMinCalls);
  if (prefillCauseTokens !== undefined) config.prefillCauseTokens = Math.floor(prefillCauseTokens);
  return config;
}
