// Estimate switched prompts in the target model's currency and find any
// path-compatible cache entry from an earlier call to that target.

import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CALIBRATION_MAX, CALIBRATION_MIN, forecastTargetPrompt, type ForecastMessage } from "../_lib/forecast.ts";
import { forecastProviderPrompt } from "../_lib/provider-prompt.ts";
import type { ToolShape } from "../_lib/tool-payloads.ts";
import { findBranchBaseline, pathContainsCompaction } from "./lineage.ts";
import type { CacheLineageSnapshot, CacheWindow } from "./types.ts";

export type SwitchTarget = {
  provider: string;
  id: string;
  api: string;
  input?: readonly string[];
};

export function activeToolShapes(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">): ToolShape[] {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools()
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, schema: tool.parameters }));
}

export interface SwitchForecast {
  targetId: string;
  targetProvider: string;
  /** Estimated first prompt in the target currency; absent when estimation failed. */
  estTokens?: number;
  /** BLUF breakdown for the switched clock and notice (design language §7): the
   * source's billed prompt and the estimated share of it the target never receives.
   * Present only when that anchor calibrated the estimate, so all terms share one
   * measured density. */
  breakdown?: { anchorTokens: number; droppedThinking: number };
  /** Direct provider serialization vs a pi-messages gateway that may transform the
   * request upstream — gateways demote the wording to a rougher claim. */
  basis: "direct" | "gateway";
  /** The target model's own most recent path-compatible billed call, if any: its
   * cache entry (not the old model's) is what a switch-back could revive. */
  prior?: { requestAt: number; window?: CacheWindow };
}

export function computeSwitchForecast(args: {
  target: SwitchTarget;
  /** The identity that last billed this history; its billed prompt tokens anchor a
   * content-density calibration of the target estimate. */
  source?: SwitchTarget;
  entries: SessionEntry[];
  activeLeafId: string | null;
  systemPromptChars: number;
  tools: ToolShape[];
  snapshots: readonly CacheLineageSnapshot[];
  /** Final local provider body, when called from before_provider_request. */
  providerPayload?: unknown;
}): SwitchForecast {
  const forecast: SwitchForecast = {
    targetId: args.target.id,
    targetProvider: args.target.provider,
    basis: args.target.api === "pi-messages" ? "gateway" : "direct",
  };
  // Cache/accounting attribution is exact provider+id+api. A missing or different
  // wire API cannot name either a warm entry or a calibration anchor.
  const identitySnapshots = (model: SwitchTarget) => args.snapshots.filter(
    (snapshot) => snapshot.provider === model.provider && snapshot.model === model.id && snapshot.api === model.api,
  );
  const prior = findBranchBaseline(args.entries, args.activeLeafId, identitySnapshots(args.target));
  // A compaction after the prior call rewrote the prefix its cache entry covered; a
  // switch-back cannot revive it, so the warmth hint is withheld rather than hedged.
  if (prior && !pathContainsCompaction(args.entries, args.activeLeafId, prior)) {
    forecast.prior = { requestAt: prior.requestAt, window: prior.window };
  }
  const sourceBaseline = args.source === undefined
    ? undefined
    : findBranchBaseline(args.entries, args.activeLeafId, identitySnapshots(args.source));
  let history: ForecastMessage[] | undefined;
  try {
    history = convertToLlm(buildSessionContext(args.entries, args.activeLeafId).messages) as unknown as ForecastMessage[];
  } catch {
    // SAFETY: buildSessionContext/convertToLlm are pi seams; a shape drift must degrade
    // to an unsized "cold expected" clock, never break the model switch itself.
  }
  if (history) {
    const calibration = args.source !== undefined && sourceBaseline !== undefined
      ? { source: args.source, billedPromptTokens: sourceBaseline.promptTokens }
      : undefined;
    const prompt = forecastTargetPrompt({
      history,
      systemPromptChars: args.systemPromptChars,
      tools: args.tools,
      target: args.target,
      providerPrompt: args.providerPayload === undefined
        ? undefined
        : forecastProviderPrompt(args.providerPayload, args.target),
      calibration,
    });
    forecast.estTokens = prompt.tokens;
    // A saturated clamp means the anchor cannot explain the estimate, only bound it:
    // the headline stays calibrated but the signed story would be fiction.
    if (calibration !== undefined && prompt.calibration !== undefined &&
        prompt.calibration > CALIBRATION_MIN && prompt.calibration < CALIBRATION_MAX) {
      forecast.breakdown = {
        anchorTokens: calibration.billedPromptTokens,
        droppedThinking: prompt.droppedThinkingTokens ?? 0,
      };
    }
  }
  return forecast;
}
