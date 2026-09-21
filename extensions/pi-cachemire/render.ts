import type { Theme } from "@earendil-works/pi-coding-agent";
import { compactCount, formatDuration, formatUsd } from "../_lib/fmt.ts";
import { SCALE, SEP, panelHeader } from "../_lib/style.ts";
import { UNKNOWN_WINDOW } from "./clock.ts";
import { sessionSavings } from "./economics.ts";
import { windowLabel } from "./retention.ts";
import type { BreakPrediction, CacheWindow, CallRecord, RunAggregate, UsageLike } from "./types.ts";

export function promptTokens(usage: UsageLike): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function renderRunSummary(run: RunAggregate, endedAt: number): string {
  const promptTokens = run.input + run.cacheRead;
  const cachedPct = promptTokens > 0 ? (run.cacheRead / promptTokens) * 100 : 0;
  const parts = [
    `turn: ${run.calls} ${run.calls === 1 ? "call" : "calls"}`,
    formatDuration(endedAt - run.startedAt),
    `read ${compactCount(run.cacheRead)} (${cachedPct >= 99.95 ? "100" : cachedPct.toFixed(1)}% cached)`,
    `wrote ${compactCount(run.cacheWrite)}`,
    `out ${compactCount(run.output)}`,
  ];
  if (run.costUsd > 0) parts.push(formatUsd(run.costUsd));
  return parts.join(SEP);
}

export function renderBreakingLine(prediction: BreakPrediction): string {
  let size: string;
  if (prediction.expectedRewriteTokens) {
    size = ` \u00b7 re-writing ~${compactCount(prediction.expectedRewriteTokens)}` +
      `${prediction.expectedUsd === undefined ? "" : ` (~${formatUsd(prediction.expectedUsd)})`}`;
  } else if (prediction.estimatedRewriteTokens !== undefined) {
    const estimate = [
      prediction.estimateBasis === "gateway" ? "rough est \u00b7 gateway route" : "est",
      ...(prediction.estimatedUsd === undefined ? [] : [`~${formatUsd(prediction.estimatedUsd)}`]),
    ].join(SEP);
    size = ` \u00b7 sending ~${compactCount(prediction.estimatedRewriteTokens)} uncached` +
      `${prediction.targetProvider === undefined ? "" : ` to ${prediction.targetProvider}`} (${estimate})`;
  } else if (prediction.cause.kind === "compaction") {
    size = " \u00b7 re-writing changed history";
  } else if (prediction.cause.kind === "thinking") {
    size = prediction.cause.detail.includes("thinking budget")
      ? " \u00b7 re-writing history (system/tools stay cached)"
      : " \u00b7 re-writing the prompt";
  } else {
    size = " \u00b7 re-writing the full prompt";
  }
  return `cache breaking${size} \u00b7 cause: ${prediction.cause.detail}`;
}

function isPostCompaction(record: CallRecord): boolean {
  return record.postCompaction !== undefined || record.classification.cause?.kind === "compaction";
}

function renderCompactionLine(record: CallRecord): string {
  const canCompare = record.expectedRead > 0 && record.postCompaction?.modelSwitched !== true;
  const prior = canCompare
    ? ` of the last pre-compaction ${compactCount(record.expectedRead)} prompt` +
      ` (${Math.round((record.usage.cacheRead / record.expectedRead) * 100)}%)`
    : " from the last pre-compaction prompt";
  const uncached = record.usage.input + record.usage.cacheWrite;
  return `cache after compaction \u00b7 reused ${compactCount(record.usage.cacheRead)}${prior}` +
    ` \u00b7 processed ${compactCount(uncached)} uncached`;
}

export function renderMissLine(record: CallRecord): string {
  if (isPostCompaction(record)) return renderCompactionLine(record);
  const prompt = promptTokens(record.usage);
  const pct = prompt > 0 ? ` (${Math.round((record.rewroteTokens / prompt) * 100)}% of prompt)` : "";
  // After a model switch the stored expectation is old-currency: the call's own
  // prompt is the only denominator its read may be composed with (design language §7).
  const readOf = record.switched
    ? `read ${compactCount(record.usage.cacheRead)} of ${compactCount(prompt)} prompt`
    : `read ${compactCount(record.usage.cacheRead)} of ${compactCount(record.expectedRead)} expected`;
  const what = record.classification.kind === "partial"
    ? `cache partial \u00b7 ${readOf} \u00b7 re-wrote ${compactCount(record.rewroteTokens)}${pct}`
    : `cache broke \u00b7 re-wrote ${compactCount(record.rewroteTokens)} of ${compactCount(prompt)} prompt` +
      `${prompt > 0 ? ` (${Math.round((record.rewroteTokens / prompt) * 100)}%)` : ""}` +
      `${record.costUsd !== undefined ? ` \u00b7 ${formatUsd(record.costUsd)}` : ""}`;
  return `${what} \u00b7 cause: ${record.classification.cause?.detail ?? "unknown"}`;
}

const EVENT_GLYPHS: Record<CallRecord["classification"]["kind"], string> = {
  cold: SCALE.cold,
  hit: SCALE.hit,
  partial: SCALE.partial,
  miss: SCALE.miss,
};

/** Aligned `/cache` call ledger (design language §§4, 8). */
export function renderLedger(
  records: CallRecord[],
  options: { providerLabel?: string; window?: CacheWindow; modelLabel?: string; theme?: Theme } = {},
): string[] {
  const profile: string[] = ["cache & loop ledger"];
  if (options.providerLabel) profile.push(options.providerLabel);
  profile.push(windowLabel(options.window ?? UNKNOWN_WINDOW));
  if (options.modelLabel) profile.push(options.modelLabel);
  const lines: string[] = panelHeader(options.theme, "Cachemire", { hint: profile.join(SEP) }).slice(1);
  if (records.length === 0) return [...lines, "  no model calls yet"];
  const col = (value: string, width: number) => value.padStart(width);
  lines.push(
    `  ${col("call", 4)} ${col("gap", 7)} ${col("input", 8)} ${col("read", 8)} ${col("wrote", 8)} ${col("out", 7)} ${col("cost", 7)}  event`,
  );
  for (const record of records) {
    const { usage } = record;
    const { kind, cause } = record.classification;
    const prefix = record.warm ? "warm \u00b7 " : "";
    let event: string;
    if (kind === "hit") {
      event = prefix + (record.thinkingChange
        ? `hit \u2014 effort ${record.thinkingChange.from} \u2192 ${record.thinkingChange.to} kept the prefix`
        : "hit");
    } else if (kind === "cold") {
      event = `${prefix}cold start`;
    } else {
      event = `${prefix}${kind} \u2014 ${cause?.detail ?? "unknown"}`;
    }
    lines.push(
      `  ${col(String(record.index), 4)} ${col(record.gapMs !== undefined ? formatDuration(record.gapMs) : "\u2014", 7)}` +
      ` ${col(compactCount(usage.input), 8)} ${col(compactCount(usage.cacheRead), 8)}` +
      ` ${col(compactCount(usage.cacheWrite), 8)} ${col(compactCount(usage.output), 7)}` +
      ` ${col(record.costUsd !== undefined ? formatUsd(record.costUsd) : "\u2014", 7)}` +
      `  ${EVENT_GLYPHS[kind]} ${event}${record.restored ? " (restored)" : ""}`,
    );
  }
  const totals = records.reduce(
    (sum, record) => ({
      calls: sum.calls + 1,
      input: sum.input + record.usage.input,
      read: sum.read + record.usage.cacheRead,
      wrote: sum.wrote + record.usage.cacheWrite,
      out: sum.out + record.usage.output,
      cost: sum.cost + (record.costUsd ?? 0),
    }),
    { calls: 0, input: 0, read: 0, wrote: 0, out: 0, cost: 0 },
  );
  lines.push(
    `  totals: ${totals.calls} calls \u00b7 input ${compactCount(totals.input)} \u00b7 read ${compactCount(totals.read)}` +
    ` \u00b7 wrote ${compactCount(totals.wrote)} \u00b7 out ${compactCount(totals.out)} \u00b7 ${formatUsd(totals.cost)}`,
  );
  const savings = sessionSavings(records);
  if (savings && savings.saved > 0.001) {
    lines.push(
      `  caching saved ~${formatUsd(savings.saved)} vs uncached ${formatUsd(savings.uncached)}` +
      ` (\u2212${savings.pct.toFixed(0)}%) \u00b7 API-priced; notional on subscription`,
    );
  }
  return lines;
}

// A predicted break that resolved into a hit: good news, and a small lesson about
// shared-prefix warmth (another session with the same harness prefix kept it alive)
// or about the route: an effort change that read the prior prefix back is billed
// proof that this route keeps it, whatever the payload looked like at Cachemire's hook.
export function renderHeldLine(record: CallRecord): string {
  if (isPostCompaction(record)) return renderCompactionLine(record);
  const change = record.thinkingChange;
  if (change?.held) {
    return `cache held \u00b7 read ${compactCount(record.usage.cacheRead)} of ${compactCount(record.expectedRead)} expected` +
      ` \u00b7 effort ${change.from} \u2192 ${change.to} kept the prefix warm on this route`;
  }
  if (record.switched) {
    // The old expectation is denominated in the previous model's tokenizer, so it is
    // never composed with this read. Warmth this session did not write (a twin session's
    // identical prefix, or the model's own surviving entry) is the only warm-switch story.
    const prompt = promptTokens(record.usage);
    const share = prompt > 0 ? ` (${Math.round((record.usage.cacheRead / prompt) * 100)}% of prompt)` : "";
    return `cache held \u00b7 read ${compactCount(record.usage.cacheRead)}${share}` +
      " \u00b7 the new model already had the prefix cached";
  }
  return `cache held \u00b7 read ${compactCount(record.usage.cacheRead)} of ${compactCount(record.expectedRead)} expected` +
    " \u00b7 prefix stayed warm";
}
