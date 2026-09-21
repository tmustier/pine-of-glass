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

// Tense grammar: in-flight predictions are progressive with ~estimates ("breaking ·
// re-writing ~77.7k"); resolved lines are past tense with exact usage ("broke · re-wrote
// 77.7k of 80.1k prompt (97%)").
export function renderBreakingLine(prediction: BreakPrediction): string {
  return `cache breaking${breakingSize(prediction)} \u00b7 cause: ${prediction.cause.detail}`;
}

function breakingSize(p: BreakPrediction): string {
  if (p.expectedRewriteTokens) {
    return ` \u00b7 re-writing ~${compactCount(p.expectedRewriteTokens)}${p.expectedUsd !== undefined ? ` (~${formatUsd(p.expectedUsd)})` : ""}`;
  }
  if (p.estimatedRewriteTokens !== undefined) {
    // Model switch sized by the shared heuristics in the target currency, always
    // wearing est; gateway routes demote the wording.
    const parens = [
      p.estimateBasis === "gateway" ? "rough est \u00b7 gateway route" : "est",
      ...(p.estimatedUsd === undefined ? [] : [`~${formatUsd(p.estimatedUsd)}`]),
    ].join(SEP);
    return ` \u00b7 sending ~${compactCount(p.estimatedRewriteTokens)} uncached` +
      `${p.targetProvider === undefined ? "" : ` to ${p.targetProvider}`} (${parens})`;
  }
  if (p.cause.kind === "compaction") return " \u00b7 re-writing changed history";
  if (p.cause.kind === "thinking") {
    // Anthropic documents that system/tools survive *budget* changes; for adaptive
    // effort changes a live test on claude-fable-5 broke 100% of the prompt
    // (read 0, re-wrote 30.0k of 30.0k), so no survival claim is made there.
    return p.cause.detail.includes("thinking budget")
      ? " \u00b7 re-writing history (system/tools stay cached)"
      : " \u00b7 re-writing the prompt";
  }
  return " \u00b7 re-writing the full prompt"; // unsized model switch: old-tokenizer count withheld
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

/** The `event` cell of a `/cache` ledger row. */
export function renderLedgerEvent(record: CallRecord): string {
  const { kind, cause } = record.classification;
  const prefix = record.warm ? "warm \u00b7 " : "";
  if (kind === "hit") {
    const change = record.thinkingChange;
    return prefix + (change ? `hit \u2014 effort ${change.from} \u2192 ${change.to} kept the prefix` : "hit");
  }
  if (kind === "cold") return `${prefix}cold start`;
  return `${prefix}${kind} \u2014 ${cause?.detail ?? "unknown"}`;
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
    lines.push(
      `  ${col(String(record.index), 4)} ${col(record.gapMs !== undefined ? formatDuration(record.gapMs) : "\u2014", 7)}` +
      ` ${col(compactCount(usage.input), 8)} ${col(compactCount(usage.cacheRead), 8)}` +
      ` ${col(compactCount(usage.cacheWrite), 8)} ${col(compactCount(usage.output), 7)}` +
      ` ${col(record.costUsd !== undefined ? formatUsd(record.costUsd) : "\u2014", 7)}` +
      `  ${EVENT_GLYPHS[record.classification.kind]} ${renderLedgerEvent(record)}${record.restored ? " (restored)" : ""}`,
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
