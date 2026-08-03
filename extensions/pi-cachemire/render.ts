import { compactCount, formatDuration, formatUsd } from "../_lib/fmt.ts";
import { SEP } from "../_lib/style.ts";
import type { BreakPrediction, CallRecord, RunAggregate, UsageLike } from "./types.ts";

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

/** Signed BLUF breakdown for a model-switch estimate (design language §7). Terms are
 * computed on display-rounded tenths of k so `anchor +tokenizer -dropped thinking`
 * always sums to the rendered headline; zero terms drop like a diff stat's zero side. */
export function renderSwitchBreakdown(
  estTokens: number,
  breakdown: { anchorTokens: number; droppedThinking: number },
): string | undefined {
  const tenths = (n: number) => Math.round(n / 100);
  const fmt = (t: number) => compactCount(t * 100);
  const dropped = tenths(breakdown.droppedThinking);
  const anchor = tenths(breakdown.anchorTokens);
  const retokenized = tenths(estTokens) - anchor + dropped;
  const terms = [fmt(anchor)];
  if (retokenized !== 0) terms.push(`${retokenized > 0 ? "+" : "-"}${fmt(Math.abs(retokenized))} tokenizer`);
  if (dropped !== 0) terms.push(`-${fmt(dropped)} dropped thinking`);
  return terms.length > 1 ? terms.join(" ") : undefined;
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
    // Model switch sized by the shared heuristics: BLUF (design language §7), the
    // consequence first, then the signed explanation. Target currency, always wearing
    // est; gateway routes demote the wording and withhold the breakdown.
    const breakdown = p.estimateBasis === "gateway" || p.estimateBreakdown === undefined
      ? undefined
      : renderSwitchBreakdown(p.estimatedRewriteTokens, p.estimateBreakdown);
    const parens = [
      ...(breakdown === undefined ? [] : [breakdown]),
      p.estimateBasis === "gateway" ? "rough est \u00b7 gateway route" : "est",
      ...(p.estimatedUsd === undefined ? [] : [`~${formatUsd(p.estimatedUsd)}`]),
    ].join(SEP);
    return ` \u00b7 sending ~${compactCount(p.estimatedRewriteTokens)} uncached` +
      `${p.targetProvider === undefined ? "" : ` to ${p.targetProvider}`} (${parens})`;
  }
  if (p.cause.kind === "compaction") return " \u00b7 re-writing the new prefix";
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

// A predicted break that resolved into a hit: good news, and a small lesson about
// shared-prefix warmth (another session with the same harness prefix kept it alive).
export function renderHeldLine(record: CallRecord): string {
  if (isPostCompaction(record)) return renderCompactionLine(record);
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
