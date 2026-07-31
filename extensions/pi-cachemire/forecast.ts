// Model-switch prompt forecast (issue #57): what will the *target* model receive?
//
// After /model, the only provider-exact numbers on hand are denominated in the old
// model's tokenizer, so the clock and the break notice need an estimate in the target
// currency instead. This module builds that estimate from pi's canonical history via
// the shared family heuristics (_lib/forecast.ts), and checks whether the target model
// itself has a path-compatible billed call whose cache entry may still be live (an
// A→B→A switch-back is warm, not cold).

import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { forecastTargetPrompt, type ForecastMessage } from "../_lib/forecast.ts";
import type { ToolShape } from "../_lib/tool-payloads.ts";
import { findBranchBaseline } from "./lineage.ts";
import type { CacheLineageSnapshot, CacheWindow } from "./types.ts";

/** The slice of pi's Model the forecast reads; ctx.model / event.model satisfy it. */
export type SwitchTarget = {
  provider: string;
  id: string;
  api: string;
  contextWindow?: number;
  input?: readonly string[];
};

export interface SwitchForecast {
  targetId: string;
  targetProvider: string;
  /** Target context window, when the catalogue knows it. */
  windowTokens?: number;
  /** Estimated first prompt in the target currency; absent when estimation failed. */
  estTokens?: number;
  /** Direct provider serialization vs a pi-messages gateway that may transform the
   * request upstream — gateways demote the wording to a rougher claim. */
  basis: "direct" | "gateway";
  /** Old-model reasoning payloads the target will never receive. */
  droppedReasoningChars: number;
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
}): SwitchForecast {
  const forecast: SwitchForecast = {
    targetId: args.target.id,
    targetProvider: args.target.provider,
    windowTokens: args.target.contextWindow && args.target.contextWindow > 0 ? args.target.contextWindow : undefined,
    basis: args.target.api === "pi-messages" ? "gateway" : "direct",
    droppedReasoningChars: 0,
  };
  const targetSnapshots = args.snapshots.filter(
    (snapshot) => snapshot.provider === args.target.provider && snapshot.model === args.target.id,
  );
  const prior = findBranchBaseline(args.entries, args.activeLeafId, targetSnapshots);
  if (prior) forecast.prior = { requestAt: prior.requestAt, window: prior.window };
  try {
    const { messages } = buildSessionContext(args.entries, args.activeLeafId);
    const history = convertToLlm(messages) as unknown as ForecastMessage[];
    const prompt = forecastTargetPrompt({
      history,
      systemPromptChars: args.systemPromptChars,
      tools: args.tools,
      target: args.target,
    });
    forecast.estTokens = prompt.tokens;
    forecast.droppedReasoningChars = prompt.droppedReasoningChars;
  } catch {
    // SAFETY: buildSessionContext/convertToLlm are pi seams; a shape drift must degrade
    // to an unsized "cold expected" clock, never break the model switch itself.
  }
  return forecast;
}
