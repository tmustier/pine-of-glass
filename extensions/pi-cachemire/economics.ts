// Break prediction at request time (before usage exists) and the session economics
// that price it. Almost every break cause is knowable when the request is sent: the
// idle gap vs TTL, pi's compact events, and the payload fingerprint diff. Predicting at
// send time lets the notice sit between the user's action and the response, where the
// causality lives, and the resolved actuals replace it in place when usage arrives.

import { expiryCause, pastWindow } from "./classify.ts";
import type { SwitchForecast } from "./forecast.ts";
import type { BreakPrediction, CacheWindow, CallCause, CallRecord, ModelRates, UsageLike } from "./types.ts";

export function predictBreak(args: {
  isFirst: boolean;
  inCompaction: boolean;
  compacted: boolean;
  gapMs?: number;
  window?: CacheWindow;
  expectedRead: number;
  fingerprintCause?: CallCause;
  /** The route's contract or billed evidence says effort changes keep the prefix. */
  thinkingCacheNeutral?: boolean;
  rates?: ModelRates;
  /** Target-currency estimate while a model switch is pending (issue #57). */
  switchForecast?: Pick<SwitchForecast, "estTokens" | "basis" | "targetProvider"> & { priorMayBeWarm: boolean };
}): BreakPrediction | undefined {
  // Cold starts are healthy and the compaction summarizer call is labelled, not warned.
  if (args.isFirst || args.inCompaction || args.expectedRead <= 0) return undefined;
  if (args.compacted) {
    // The old prefix is gone; the new one's size is unknowable until usage arrives.
    return { cause: { kind: "compaction", detail: "history compacted" } };
  }
  const sized = (cause: CallCause): BreakPrediction => ({
    cause,
    expectedRewriteTokens: args.expectedRead,
    expectedUsd: rewriteCostUsd(args.expectedRead, args.rates),
  });
  if (args.fingerprintCause) {
    // Model switches break the cache vs the *last* call for certain (caches are
    // per-model on every provider), but the stored size is denominated in the old
    // model's tokenizer — never show that number. When the shared heuristics produced
    // a target-currency estimate, claim that instead, marked est. When the target
    // model's own prior cache entry may still be warm (A→B→A), stay silent: the
    // resolved line reports the truth when usage arrives.
    if (args.fingerprintCause.kind === "model") {
      const forecast = args.switchForecast;
      if (forecast?.priorMayBeWarm) return undefined;
      if (forecast?.estTokens === undefined) return { cause: args.fingerprintCause };
      return {
        cause: args.fingerprintCause,
        estimatedRewriteTokens: forecast.estTokens,
        estimatedUsd: rewriteCostUsd(forecast.estTokens, args.rates),
        estimateBasis: forecast.basis,
        targetProvider: forecast.targetProvider,
      };
    }
    if (args.fingerprintCause.kind === "compaction") return { cause: args.fingerprintCause };
    if (args.fingerprintCause.kind === "thinking") {
      // Only an Anthropic contract window earns an in-flight claim, and not on a route
      // whose billed evidence says it holds: that silences the claim without hiding
      // the wire change from the resolved cause. The affected share of expectedRead is
      // unknowable, so the prediction stays unsized.
      return args.window?.kind === "contract" && args.thinkingCacheNeutral !== true
        ? { cause: args.fingerprintCause }
        : undefined;
    }
    return sized(args.fingerprintCause);
  }
  // Only a definite contract expiry or reached maximum earns an in-flight line.
  if (pastWindow(args.window, args.gapMs)) {
    return sized(expiryCause(args.window, args.gapMs)!);
  }
  return undefined;
}

export function uncachedCostUsd(usage: UsageLike, rates?: ModelRates): number | undefined {
  if (!rates) return undefined;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return (inputTokens * rates.input + usage.output * rates.output) / 1_000_000;
}

export function rewriteCostUsd(tokens: number, rates?: ModelRates): number | undefined {
  if (!rates) return undefined;
  // Request-wide pricing tiers: the highest matching threshold prices the whole request.
  const tier = (rates.tiers ?? [])
    .filter((candidate) => tokens > candidate.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? rates;
  return (tokens * (tier.cacheWrite || tier.input)) / 1_000_000;
}

export function sessionSavings(records: CallRecord[]): { actual: number; uncached: number; saved: number; pct: number } | undefined {
  const usable = records.filter((record) => record.costUsd !== undefined && record.uncachedUsd !== undefined);
  if (usable.length === 0) return undefined;
  const actual = usable.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  const uncached = usable.reduce((sum, record) => sum + (record.uncachedUsd ?? 0), 0);
  if (uncached <= 0) return undefined;
  return { actual, uncached, saved: uncached - actual, pct: (1 - actual / uncached) * 100 };
}
