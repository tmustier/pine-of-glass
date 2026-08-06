// pi-meantime surfaces (design language §10.3): the live widget line, anomaly notice
// lines, and the /pace panel. Pure text in, styled strings out; all ink flows through
// the family style layer and every number speaks the §4 grammar.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { compactCount, formatDuration, formatLatency, formatRate } from "../_lib/fmt.ts";
import { SEP, ink, panelHeader, type Tone } from "../_lib/style.ts";
import {
  detectSlowStart,
  detectSlowStream,
  type CallTiming,
  type LiveCall,
  type MeantimeConfig,
  type SessionTotals,
  type SlowStart,
  type SlowStream,
} from "./timing.ts";

// --- live widget (design language §10.3) --------------------------------------------------

export interface WidgetSnapshot {
  now: number;
  runActive: boolean;
  live?: LiveCall;
  /** Tool executions currently running. */
  openTools: number;
  /** Union of completed and open tool intervals in the current phase. */
  toolElapsedMs: number;
  writingCharsPerToken: number;
  /** Session baseline for flagging an anomalous wait mid-stream, when one exists. */
  slowStartBar?: { medianMs: number; thresholdMs: number };
}

export interface WidgetLine {
  tone: Tone;
  text: string;
}

const LIVE_RATE_MIN_MS = 2_000;

export function tempoWidget(snap: WidgetSnapshot): WidgetLine | undefined {
  if (!snap.runActive) return undefined;
  const live = snap.live;
  if (live) {
    if (live.firstTokenAt === undefined) {
      const elapsed = Math.max(0, snap.now - live.requestAt);
      if (snap.slowStartBar && elapsed >= snap.slowStartBar.thresholdMs) {
        return {
          tone: "warning",
          text: `waiting${SEP}${formatDuration(elapsed)}${SEP}slow start (median ${formatLatency(snap.slowStartBar.medianMs)})`,
        };
      }
      return { tone: "running", text: `waiting${SEP}${formatDuration(elapsed)}` };
    }
    const kind = live.segment?.kind ?? live.lastKind ?? "writing";
    const openMs = live.segment ? Math.max(0, snap.now - live.segment.startedAt) : 0;
    const ms = (kind === "thinking" ? live.thinkMs : live.writeMs) + openMs;
    const rate = kind === "writing" && ms >= LIVE_RATE_MIN_MS && live.writeChars > 0
      ? `${SEP}${formatRate(live.writeChars / snap.writingCharsPerToken / (ms / 1000))}`
      : "";
    return {
      tone: "running",
      text: `${kind}${SEP}${formatDuration(ms)}${rate}`,
    };
  }
  if (snap.openTools > 0) {
    const count = snap.openTools > 1 ? `${SEP}${snap.openTools} running` : "";
    return { tone: "running", text: `tools${SEP}${formatDuration(snap.toolElapsedMs)}${count}` };
  }
  return undefined;
}

// --- anomaly notices (design language §10.3: past tense, exact, cause last and dim) -------

export function renderSlowStartLine(call: CallTiming, slow: SlowStart, prefillCauseTokens: number): string {
  const cause = call.uncachedPromptTokens >= prefillCauseTokens
    ? `cause: prefill ${compactCount(call.uncachedPromptTokens)} uncached prompt tokens`
    : "cause unknown";
  return `slow start${SEP}first token ${formatLatency(slow.ttftMs)} (median ${formatLatency(slow.medianMs)})${SEP}${cause}`;
}

export function renderSlowStreamLine(call: CallTiming, slow: SlowStream): string {
  const streamMs = Math.max(0, call.totalMs - (call.ttftMs ?? 0));
  return `slow stream${SEP}${formatRate(slow.rate, { exact: true })} (median ${formatRate(slow.medianRate, { exact: true })})` +
    `${SEP}${compactCount(call.outputTokens)} tokens over ${formatDuration(streamMs)}`;
}

// --- /pace panel (design language §8, §10.3) -----------------------------------------------

const ABSENT = "\u2014"; // quoted UI output: the ledger prints an em dash for absent values

function durationCell(ms: number | undefined): string {
  return ms === undefined || ms === 0 ? ABSENT : formatLatency(ms);
}

const HARNESS_NOTE_MS = 2_000;
const OVERLAP_NOTE_MS = 1_000;

/** Row notes use the same detectors as the notices, evaluated against prior calls. */
function rowNotes(call: CallTiming, prior: CallTiming[], config: MeantimeConfig): string {
  const notes: string[] = [];
  const slowStart = detectSlowStart(call, prior, config);
  if (slowStart) notes.push(`slow start (median ${formatLatency(slowStart.medianMs)})`);
  const slowStream = detectSlowStream(call, prior, config);
  if (slowStream) notes.push(`slow stream (median ${formatRate(slowStream.medianRate, { exact: true })})`);
  if (call.silentReasoning) notes.push("wait incl. silent reasoning");
  if ((call.toolsOverlapMs ?? 0) >= OVERLAP_NOTE_MS) notes.push(`${call.toolsCount} tools overlapped`);
  if ((call.harnessMs ?? 0) >= HARNESS_NOTE_MS) notes.push(`harness ${formatLatency(call.harnessMs!)}`);
  return notes.join(SEP);
}

const BAR_CELLS = 25;

function shareBar(theme: Theme | undefined, activeMs: number, spanMs: number): string {
  const filled = spanMs > 0 ? Math.max(activeMs > 0 ? 1 : 0, Math.round((activeMs / spanMs) * BAR_CELLS)) : 0;
  const clamped = Math.min(BAR_CELLS, filled);
  return ink(theme, "accent", "\u2588".repeat(clamped)) + ink(theme, "dim", "\u2592".repeat(BAR_CELLS - clamped));
}

export interface PaceOptions {
  config: MeantimeConfig;
  theme?: Theme;
  modelLabel?: string;
}

export function renderPace(calls: CallTiming[], totals: SessionTotals, options: PaceOptions): string[] {
  const hint = [
    "/pace",
    "event-boundary wall clock",
    "usage-based tok/s",
    "process-local",
  ];
  const models = [...new Set(calls.flatMap((call) => call.model ? [call.model] : []))];
  if (models.length > 1) hint.push(`${models.length} models`);
  else if (models.length === 1) hint.push(models[0]!);
  else if (options.modelLabel) hint.push(options.modelLabel);
  const lines: string[] = panelHeader(options.theme, "Meantime", { hint: hint.join(SEP) }).slice(1);
  if (calls.length === 0) {
    lines.push("  no timed model calls yet");
    return lines;
  }
  const col = (value: string, width: number) => value.padStart(width);
  lines.push(
    `  ${col("call", 4)} ${col("ttft", 7)} ${col("think", 7)} ${col("write", 7)}` +
    ` ${col("tools", 7)} ${col("total", 7)} ${col("out", 7)} ${col("tok/s", 6)}`,
  );
  let previousModel: string | undefined;
  for (const [i, call] of calls.entries()) {
    const notes = rowNotes(call, calls.slice(0, i), options.config);
    const modelNote = models.length > 1 && call.model !== previousModel ? `model ${call.model ?? "unknown"}` : "";
    const allNotes = [modelNote, notes].filter(Boolean).join(SEP);
    lines.push(
      `  ${col(String(call.index), 4)} ${col(durationCell(call.ttftMs), 7)}` +
      ` ${col(durationCell(call.thinkMs), 7)} ${col(durationCell(call.writeMs), 7)}` +
      ` ${col(durationCell(call.toolsMs), 7)} ${col(durationCell(call.totalMs), 7)}` +
      ` ${col(compactCount(call.outputTokens), 7)}` +
      ` ${col(call.tokPerSec !== undefined ? String(Math.round(call.tokPerSec)) : ABSENT, 6)}` +
      `${allNotes ? `  ${allNotes}` : ""}`,
    );
    previousModel = call.model;
  }
  lines.push(
    `  totals: ${totals.calls} ${totals.calls === 1 ? "call" : "calls"}` +
    `${SEP}waiting ${formatLatency(totals.waitingMs)}${SEP}thinking ${formatLatency(totals.thinkingMs)}` +
    `${SEP}writing ${formatLatency(totals.writingMs)}${SEP}tools ${formatLatency(totals.toolsMs)}` +
    `${SEP}harness ${formatLatency(totals.harnessMs)}`,
  );
  const activePct = totals.spanMs > 0 ? Math.round((totals.activeMs / totals.spanMs) * 100) : 0;
  lines.push(
    `  timed ${formatDuration(totals.spanMs)}   ${shareBar(options.theme, totals.activeMs, totals.spanMs)}` +
    `  active ${formatDuration(totals.activeMs)} (${activePct}%)${SEP}idle ${formatDuration(totals.idleMs)}`,
  );
  return lines;
}
