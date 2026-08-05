// The cache clock: pure freshness state → widget text (design language §6). Tones are
// applied by the widget layer in index.ts; everything here is deterministic wording so
// the golden suite can pin the exact strings. Split from index.ts to keep each file
// inside its agent context budget.

import { compactCount, formatDuration, formatUsd } from "../_lib/fmt.ts";
import type { SwitchForecast } from "./forecast.ts";
import type { CacheWindow } from "./types.ts";

export const UNKNOWN_WINDOW: CacheWindow = { kind: "unknown" };
const EXACT_WARNING_MAX_MS = 5 * 60 * 1000;
const BAND_WARNING_MAX_MS = 60 * 1000;

/** Conservative warmth: inside a contract TTL or a documented band's soft horizon.
 * Unknown retention never earns a warmth claim. */
export function withinWarmHorizon(window: CacheWindow | undefined, sinceMs: number): boolean {
  const resolved = window ?? UNKNOWN_WINDOW;
  if (resolved.kind === "contract") return sinceMs <= resolved.ttlMs;
  if (resolved.kind === "band") return sinceMs <= resolved.softMs;
  return false;
}

function warningLeadMs(window: Exclude<CacheWindow, { kind: "unknown" }>): number {
  const boundary = window.kind === "contract" ? window.ttlMs : window.softMs;
  const maximum = window.kind === "contract" ? EXACT_WARNING_MAX_MS : BAND_WARNING_MAX_MS;
  return Math.min(maximum, boundary * 0.2);
}

export interface ClockState {
  phase: "idle" | "closing" | "cold" | "stale" | "fading" | "warm-unknown";
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
    if (forecast?.prior && (!forecast.prior.window || forecast.prior.window.kind === "unknown")) {
      return { phase: "warm-unknown", text: "cache state unknown \u00b7 model switched \u00b7 next send confirms" };
    }
    if (forecast !== undefined && forecast.prior !== undefined &&
        withinWarmHorizon(forecast.prior.window, input.now - forecast.prior.requestAt)) {
      // The target model's own last billed call is inside its freshness window: a
      // switch-back may revive that entry, so "cold" would overclaim.
      return {
        phase: "warm-unknown",
        text: `cache may still be warm \u00b7 switched back to ${forecast.targetId} \u00b7 next send confirms`,
      };
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
  if (window.kind === "band") {
    const untilTypicalExpiry = window.softMs - since;
    if (untilTypicalExpiry > warningLeadMs(window)) return { phase: "idle", text: "" };
    if (untilTypicalExpiry > 0) {
      return {
        phase: "closing",
        text: `cache may expire in ${formatDuration(untilTypicalExpiry)} \u00b7 typical eviction starts after ${formatDuration(window.softMs)} idle`,
      };
    }
    if (since < window.hardMs) {
      const suffix = rewriteSuffix("may re-send", input.cachedTokens, input.rewriteUsd);
      return {
        phase: "fading",
        text: `cache may be stale \u00b7 typical eviction window ${formatDuration(window.softMs)}\u2013${formatDuration(window.hardMs)}${suffix}`,
      };
    }
    const suffix = rewriteSuffix("may re-send", input.cachedTokens, input.rewriteUsd, " uncached");
    return { phase: "cold", text: `cache stale \u00b7 beyond ${formatDuration(window.hardMs)} cache cap${suffix}` };
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
    const horizon = priorWindow.kind === "contract" ? priorWindow.ttlMs : priorWindow.softMs;
    const remaining = horizon - (input.now - prior.requestAt);
    return remaining >= 0 ? remaining + 1 : undefined;
  }
  const since = input.now - input.lastRequestAt;
  const window = input.window ?? UNKNOWN_WINDOW;
  if (window.kind === "unknown" || (input.thinkingChanged && window.kind === "contract")) return undefined;

  const warningAt = (window.kind === "contract" ? window.ttlMs : window.softMs) - warningLeadMs(window);
  if (since < warningAt) return warningAt - since;

  if (window.kind === "contract") {
    const remaining = window.ttlMs - since;
    if (remaining <= 0) return undefined;
    if (remaining <= 90_000) return Math.min(remaining, 1_000);
    return (remaining % 15_000) + 1;
  }

  if (since < window.softMs) return Math.min(window.softMs - since, 1_000);
  if (since < window.hardMs) return window.hardMs - since;
  return undefined;
}
