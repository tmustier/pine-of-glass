// Estimate switched prompts in the target model's currency and find any
// path-compatible cache entry from an earlier call to that target.

import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { forecastTargetPrompt, type ForecastMessage } from "../_lib/forecast.ts";
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
  /** Direct provider serialization vs a pi-messages gateway that may transform the
   * request upstream — gateways demote the wording to a rougher claim. */
  basis: "direct" | "gateway";
  /** The target model's own most recent path-compatible billed call, if any: its
   * cache entry (not the old model's) is what a switch-back could revive. */
  prior?: { requestAt: number; window?: CacheWindow };
}

export function computeSwitchForecast(args: {
  target: SwitchTarget;
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
  // wire API cannot name a warm entry.
  const targetSnapshots = args.snapshots.filter(
    (snapshot) => snapshot.provider === args.target.provider && snapshot.model === args.target.id &&
      snapshot.api === args.target.api,
  );
  const prior = findBranchBaseline(args.entries, args.activeLeafId, targetSnapshots);
  // A compaction after the prior call rewrote the prefix its cache entry covered; a
  // switch-back cannot revive it, so the warmth hint is withheld rather than hedged.
  if (prior && !pathContainsCompaction(args.entries, args.activeLeafId, prior)) {
    forecast.prior = { requestAt: prior.requestAt, window: prior.window };
  }
  let history: ForecastMessage[] | undefined;
  try {
    history = convertToLlm(buildSessionContext(args.entries, args.activeLeafId).messages) as unknown as ForecastMessage[];
  } catch {
    // SAFETY: buildSessionContext/convertToLlm are pi seams; a shape drift must degrade
    // to an unsized "cold expected" clock, never break the model switch itself.
  }
  if (history) {
    const prompt = forecastTargetPrompt({
      history,
      systemPromptChars: args.systemPromptChars,
      tools: args.tools,
      target: args.target,
      providerPrompt: args.providerPayload === undefined
        ? undefined
        : forecastProviderPrompt(args.providerPayload, args.target),
    });
    forecast.estTokens = prompt.tokens;
  }
  return forecast;
}
