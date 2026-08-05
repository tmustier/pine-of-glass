// The cache clock: pure freshness state → widget text (design language §6). Tones are
// applied by the widget layer in index.ts; everything here is deterministic wording so
// the golden suite can pin the exact strings. Split from index.ts to keep each file
// inside its agent context budget.

import { compactCount, formatDuration, formatUsd } from "../_lib/fmt.ts";
import type { SwitchForecast } from "./forecast.ts";
import type { CacheWindow } from "./types.ts";

export const UNKNOWN_WINDOW: CacheWindow = { kind: "unknown" };
const EXACT_WARNING_MAX_MS = 5 * 60 * 1000;

export function withinWarmHorizon(window: CacheWindow | undefined, sinceMs: number): boolean {
  if (window?.kind === "contract") return sinceMs < window.ttlMs;
  return window?.kind === "minimum" && sinceMs < window.minMs;
}

function warningLeadMs(window: Extract<CacheWindow, { kind: "contract" }>): number {
  return Math.min(EXACT_WARNING_MAX_MS, window.ttlMs * 0.2);
}

export interface ClockState {
  phase: "idle" | "closing" | "cold" | "stale" | "warm-unknown";
  text: string;
}

export interface ClockInput {
  now: number;
  lastRequestAt?: number;
  window?: CacheWindow;
  cachedTokens?: number;
  rewriteUsd?: number;
  /** History was compacted since the last call: the next send re-writes regardless of TTL. */
  compacted?: boolean;
  /** Model changed since the last billed call: caches are per-model, so the last call's
   * entry is dead for the new model. The stored size is in the old tokenizer's currency
   * and is never shown; the forecast carries target-currency estimates instead. */
  modelSwitched?: boolean;
  /** Target-currency forecast while modelSwitched (issue #57). */
  switchForecast?: SwitchForecast;
  /** Thinking level changed since the last billed call. Material only under a contract
   * window (Anthropic documents message-breakpoint invalidation; system/tools survive). */
  thinkingChanged?: boolean;
}

function rewriteSuffix(verb: string, cachedTokens?: number, rewriteUsd?: number, qualifier = ""): string {
  if (!cachedTokens) return "";
  const bill = rewriteUsd !== undefined ? ` (~${formatUsd(rewriteUsd)})` : "";
  return ` \u00b7 next send ${verb} ~${compactCount(cachedTokens)}${qualifier}${bill}`;
}

export function cacheClock(input: ClockInput): ClockState {
  if (input.lastRequestAt === undefined) return { phase: "idle", text: "" };
  if (input.compacted) {
    return { phase: "stale", text: "cache stale after compaction \u00b7 next send may re-write changed history" };
  }
  if (input.modelSwitched) {
    const forecast = input.switchForecast;
    if (forecast?.prior) {
      const prior = forecast.prior;
      const priorAge = input.now - prior.requestAt;
      if (!prior.window || prior.window.kind === "unknown" ||
          (prior.window.kind === "maximum" && priorAge < prior.window.maxMs) ||
          (prior.window.kind === "minimum" && priorAge >= prior.window.minMs)) {
        return { phase: "warm-unknown", text: "cache state unknown \u00b7 model switched \u00b7 next send confirms" };
      }
      if (withinWarmHorizon(prior.window, priorAge)) {
        return {
          phase: "warm-unknown",
          text: `cache may still be warm \u00b7 switched back to ${forecast.targetId} \u00b7 next send confirms`,
        };
      }
    }
    if (forecast?.estTokens === undefined) {
      return { phase: "cold", text: "cache cold expected \u00b7 model switched \u00b7 prompt size known at next send" };
    }
    // BLUF (design language §7): the consequence first, in the target currency.
    const confidence = forecast.basis === "gateway" ? "rough est \u00b7 gateway route" : "est";
    return {
      phase: "cold",
      text: `cache cold expected \u00b7 model switched \u00b7 next send ~${compactCount(forecast.estTokens)} uncached` +
        ` to ${forecast.targetProvider} (${confidence})`,
    };
  }
  const since = input.now - input.lastRequestAt;
  const window = input.window ?? UNKNOWN_WINDOW;
  if (input.thinkingChanged && window.kind === "contract") {
    // No survival promise here: docs say system/tools outlive *budget* changes, but a
    // live adaptive-effort change on claude-fable-5 re-wrote 100% of the prompt.
    return { phase: "stale", text: "cache stale \u00b7 thinking level changed \u00b7 next send may re-write the prompt" };
  }
  if (window.kind === "contract") {
    const remaining = window.ttlMs - since;
    if (remaining <= 0) {
      return { phase: "cold", text: `cache stale \u00b7 TTL expired${rewriteSuffix("may re-write", input.cachedTokens, input.rewriteUsd)}` };
    }
    if (remaining > warningLeadMs(window)) return { phase: "idle", text: "" };
    // Coarse display above 90s so long-retention warnings do not re-render every second.
    const display = remaining > 90_000 ? Math.floor(remaining / 15_000) * 15_000 : remaining;
    const suffix = rewriteSuffix("may re-write", input.cachedTokens, input.rewriteUsd);
    return { phase: "closing", text: `cache expires in ${formatDuration(display)}${suffix}` };
  }
  if (window.kind === "minimum" && since >= window.minMs) {
    const suffix = rewriteSuffix("may re-send", input.cachedTokens, input.rewriteUsd, " uncached");
    return {
      phase: "warm-unknown",
      text: `cache state unknown \u00b7 ${formatDuration(window.minMs)} retention minimum reached${suffix}`,
    };
  }
  if (window.kind === "maximum" && since >= window.maxMs) {
    const suffix = rewriteSuffix("may re-send", input.cachedTokens, input.rewriteUsd, " uncached");
    return { phase: "cold", text: `cache stale \u00b7 ${formatDuration(window.maxMs)} retention maximum reached${suffix}` };
  }
  return { phase: "idle", text: "" };
}

/** Delay until the clock's visible wording can change. Undefined means no timer is needed. */
export function nextClockUpdateMs(input: ClockInput): number | undefined {
  if (input.lastRequestAt === undefined || input.compacted) return undefined;
  if (input.modelSwitched) {
    const prior = input.switchForecast?.prior;
    const priorWindow = prior?.window;
    if (!prior || !priorWindow || priorWindow.kind === "unknown") return undefined;
    const horizon = priorWindow.kind === "contract"
      ? priorWindow.ttlMs
      : priorWindow.kind === "minimum" ? priorWindow.minMs : priorWindow.maxMs;
    const remaining = horizon - (input.now - prior.requestAt);
    return remaining > 0 ? remaining : undefined;
  }
  const since = input.now - input.lastRequestAt;
  const window = input.window ?? UNKNOWN_WINDOW;
  if (window.kind === "unknown" || (input.thinkingChanged && window.kind === "contract")) return undefined;
  if (window.kind === "minimum") {
    const remaining = window.minMs - since;
    return remaining > 0 ? remaining : undefined;
  }
  if (window.kind === "maximum") {
    const remaining = window.maxMs - since;
    return remaining > 0 ? remaining : undefined;
  }

  const warningAt = window.ttlMs - warningLeadMs(window);
  if (since < warningAt) return warningAt - since;

  const remaining = window.ttlMs - since;
  if (remaining <= 0) return undefined;
  if (remaining <= 90_000) return Math.min(remaining, 1_000);
  return (remaining % 15_000) + 1;
}
