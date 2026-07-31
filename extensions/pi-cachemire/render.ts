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

// Tense grammar: in-flight predictions are progressive with ~estimates ("breaking ·
// re-writing ~77.7k"); resolved lines are past tense with exact usage ("broke · re-wrote
// 77.7k of 80.1k prompt (97%)").
export function renderBreakingLine(prediction: BreakPrediction): string {
  const size = prediction.expectedRewriteTokens
    ? ` \u00b7 re-writing ~${compactCount(prediction.expectedRewriteTokens)}${prediction.expectedUsd !== undefined ? ` (~${formatUsd(prediction.expectedUsd)})` : ""}`
    : prediction.estimatedRewriteTokens !== undefined
      // Model switch sized by the shared heuristics: the number is in the *target*
      // currency and always wears est; gateway routes demote the wording further.
      ? ` \u00b7 re-writing ~${compactCount(prediction.estimatedRewriteTokens)}` +
        `${prediction.targetWindowTokens !== undefined ? ` of ${compactCount(prediction.targetWindowTokens)} ctx` : ""}` +
        ` (${prediction.estimateBasis === "gateway" ? "rough est \u00b7 gateway route" : "est"}` +
        `${prediction.estimatedUsd !== undefined ? ` \u00b7 ~${formatUsd(prediction.estimatedUsd)}` : ""})`
    : prediction.cause.kind === "compaction"
      ? " \u00b7 re-writing the new prefix"
      : prediction.cause.kind === "thinking"
        // Anthropic documents that system/tools survive *budget* changes; for adaptive
        // effort changes a live test on claude-fable-5 broke 100% of the prompt
        // (read 0, re-wrote 30.0k of 30.0k), so no survival claim is made there.
        ? prediction.cause.detail.includes("thinking budget")
          ? " \u00b7 re-writing history (system/tools stay cached)"
          : " \u00b7 re-writing the prompt"
        : " \u00b7 re-writing the full prompt"; // unsized model switch: old-tokenizer count withheld
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
  const what = record.classification.kind === "partial"
    ? `cache partial \u00b7 read ${compactCount(record.usage.cacheRead)} of ${compactCount(record.expectedRead)} expected` +
      ` \u00b7 re-wrote ${compactCount(record.rewroteTokens)}${pct}`
    : `cache broke \u00b7 re-wrote ${compactCount(record.rewroteTokens)} of ${compactCount(prompt)} prompt` +
      `${prompt > 0 ? ` (${Math.round((record.rewroteTokens / prompt) * 100)}%)` : ""}` +
      `${record.costUsd !== undefined ? ` \u00b7 ${formatUsd(record.costUsd)}` : ""}`;
  return `${what} \u00b7 cause: ${record.classification.cause?.detail ?? "unknown"}`;
}

// A predicted break that resolved into a hit: good news, and a small lesson about
// shared-prefix warmth (another session with the same harness prefix kept it alive).
export function renderHeldLine(record: CallRecord): string {
  if (isPostCompaction(record)) return renderCompactionLine(record);
  return `cache held \u00b7 read ${compactCount(record.usage.cacheRead)} of ${compactCount(record.expectedRead)} expected` +
    " \u00b7 prefix stayed warm";
}
