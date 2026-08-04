// The cache clock: pure freshness state → widget text (design language §6). Tones are
// applied by the widget layer in index.ts; everything here is deterministic wording so
// the golden suite can pin the exact strings. Split from index.ts to keep each file
// inside its agent context budget.

import { compactCount, formatDuration, formatUsd } from "../_lib/fmt.ts";
import type { Tone } from "../_lib/style.ts";
import type { SwitchForecast } from "./forecast.ts";
import { renderSwitchBreakdown } from "./render.ts";
import type { CacheWindow } from "./types.ts";

export const UNKNOWN_WINDOW: CacheWindow = { kind: "unknown" };
export const UNKNOWN_TTL_WARM_MS = 10 * 60 * 1000; // soft "likely cold" horizon for implicit caches

/** Conservative warmth: inside a contract TTL, inside a band's *soft* horizon, or
 * inside the implicit-cache horizon. Anything past this must not claim "warm". */
export function withinWarmHorizon(window: CacheWindow | undefined, sinceMs: number): boolean {
  const resolved = window ?? UNKNOWN_WINDOW;
  if (resolved.kind === "contract") return sinceMs <= resolved.ttlMs;
  if (resolved.kind === "band") return sinceMs <= resolved.softMs;
  return sinceMs <= UNKNOWN_TTL_WARM_MS;
}

export interface ClockState {
  phase: "idle" | "fresh" | "closing" | "cold" | "stale" | "fading" | "warm-unknown" | "cold-unknown";
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
  if (input.modelSwitched) {
    const forecast = input.switchForecast;
    if (forecast !== undefined && forecast.prior !== undefined &&
        withinWarmHorizon(forecast.prior.window, input.now - forecast.prior.requestAt)) {
      // The target model's own last billed call is inside its freshness window: a
      // switch-back may revive that entry, so "cold" would overclaim.
      return {
        phase: "warm-unknown",
        text: `cache may still be warm \u00b7 last ${forecast.targetId} call ` +
          `${formatDuration(input.now - forecast.prior.requestAt)} ago \u00b7 next send confirms`,
      };
    }
    if (forecast?.estTokens === undefined) {
      return { phase: "cold", text: "cache cold expected \u00b7 model switched \u00b7 prompt size known at next send" };
    }
    // BLUF (design language §7): the consequence first (the whole prompt goes uncached
    // to the new provider), then the signed explanation from the source's billed prompt.
    const breakdown = forecast.basis === "direct" && forecast.breakdown !== undefined
      ? renderSwitchBreakdown(forecast.estTokens, forecast.breakdown)
      : undefined;
    const confidence = forecast.basis === "gateway" ? "rough est \u00b7 gateway route" : "est";
    return {
      phase: "cold",
      text: `cache cold expected \u00b7 model switched \u00b7 next send ~${compactCount(forecast.estTokens)} uncached` +
        ` to ${forecast.targetProvider} (${breakdown !== undefined ? `${breakdown} \u00b7 ` : ""}${confidence})`,
    };
  }
  if (input.compacted) {
    // The prefix the clock was timing no longer exists; TTL is moot until the next send.
    return { phase: "stale", text: "cache stale \u00b7 history compacted \u00b7 next send re-writes the new prefix" };
  }
  const since = input.now - input.lastRequestAt;
  const window = input.window ?? UNKNOWN_WINDOW;
  if (input.thinkingChanged && window.kind === "contract") {
    // No survival promise here: docs say system/tools outlive *budget* changes, but a
    // live adaptive-effort change on claude-fable-5 re-wrote 100% of the prompt.
    return { phase: "stale", text: "cache stale \u00b7 thinking level changed \u00b7 next send re-writes the prompt" };
  }
  if (window.kind === "contract") {
    const remaining = window.ttlMs - since;
    if (remaining <= 0) {
      return { phase: "cold", text: `cache cold${rewriteSuffix("re-writes", input.cachedTokens, input.rewriteUsd)}` };
    }
    // Coarse display above 90s so the widget only re-renders when the label changes.
    const display = remaining > 90_000 ? Math.floor(remaining / 15_000) * 15_000 : remaining;
    return {
      phase: remaining <= 60_000 ? "closing" : "fresh",
      text: `cache ${formatDuration(display)}`,
    };
  }
  if (window.kind === "band") {
    if (since > window.hardMs) {
      // The hard cap is documented ("always removed within one hour of last use"), so
      // past it "cold" is definite even without a per-request TTL contract.
      const suffix = rewriteSuffix("re-sends", input.cachedTokens, input.rewriteUsd, " uncached");
      return { phase: "cold", text: `cache cold (idle ${formatDuration(since)} > ${formatDuration(window.hardMs)} cap)${suffix}` };
    }
    if (since > window.softMs) {
      const suffix = rewriteSuffix("may re-send", input.cachedTokens, input.rewriteUsd);
      return {
        phase: "fading",
        text: `cache fading \u00b7 idle ${formatDuration(since)} of ${formatDuration(window.softMs)}\u2013${formatDuration(window.hardMs)} window${suffix}`,
      };
    }
    return { phase: "warm-unknown", text: `cache likely warm \u00b7 ${formatDuration(since)} since last call` };
  }
  // Unknown window: no contract, only soft language — but past the soft horizon we still
  // know exactly how much prompt would be re-sent uncached.
  if (since > UNKNOWN_TTL_WARM_MS) {
    const suffix = rewriteSuffix("re-sends", input.cachedTokens, input.rewriteUsd, " uncached");
    return { phase: "cold-unknown", text: `cache likely cold (idle ${formatDuration(since)})${suffix}` };
  }
  return { phase: "warm-unknown", text: `cache likely warm \u00b7 ${formatDuration(since)} since last call` };
}

export function toneFor(phase: ClockState["phase"]): Tone {
  switch (phase) {
    case "fresh":
    case "warm-unknown":
      return "success";
    case "closing":
      return "warning";
    default: // cold, stale, cold-unknown, idle
      return "dim";
  }
}
