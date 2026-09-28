// Contextimate's startup breakdown as plain data, for other extensions and scripts. This is
// the stable interface; index.ts and snapshot.ts are not. The numbers match the panel: the
// same system prompt, heuristic and contextimate config.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseSkillsBlock } from "./prompt-parsing.ts";
import { loadContextimateConfig, toModelSummary } from "./heuristic-config.ts";
import { buildSnapshot, sectionChars, sectionTokens, totalTokens } from "./snapshot.ts";
import { sourceInfoLabel } from "./tool-accounting.ts";

export type ContextReport = {
  /** `provider/id` the heuristic was resolved for; absent before a model is selected. */
  model?: string;
  /** The heuristic's label, e.g. "OpenAI-Codex heuristic". */
  heuristic: string;
  /** Estimated tokens for everything sent before the conversation. */
  totalTokens: number;
  /** The runtime system prompt, each AGENTS file, the skill index and the active tool definitions. */
  sections: { id: string; title: string; chars: number; tokens: number }[];
  /** Skills in the model's skill index, with what each entry costs. */
  skills: { name: string; location: string; tokens: number }[];
  /** Every registered tool. Only active tools are sent, so only they have tokens. */
  tools: { name: string; active: boolean; tokens?: number; source: string }[];
};

/** Counts the current system prompt: during a run, the prompt that run sent. */
export function contextReport(pi: ExtensionAPI, ctx: ExtensionContext): ContextReport {
  const model = toModelSummary(ctx.model);
  const systemPrompt = ctx.getSystemPrompt();
  const snapshot = buildSnapshot(pi, () => systemPrompt, undefined, undefined, () => model, loadContextimateConfig(ctx.cwd));
  const toolTokens = new Map(
    snapshot.sections.flatMap((section) => (section.expanded.kind === "tools" ? section.expanded.tools.map((tool) => [tool.name, tool.tokens] as const) : [])),
  );
  const active = new Set(pi.getActiveTools());
  return {
    ...(model && { model: `${model.provider}/${model.id}` }),
    heuristic: snapshot.heuristic.label,
    totalTokens: totalTokens(snapshot),
    sections: snapshot.sections.map((section) => ({ id: section.id, title: section.title, chars: sectionChars(section), tokens: sectionTokens(section) })),
    skills: (parseSkillsBlock(systemPrompt, snapshot.heuristic.textDenominator)?.skills ?? []).map(({ name, location, tokens }) => ({ name, location, tokens })),
    tools: pi.getAllTools().map((tool) => ({
      name: tool.name,
      active: active.has(tool.name),
      ...(toolTokens.has(tool.name) && { tokens: toolTokens.get(tool.name) }),
      source: sourceInfoLabel(tool),
    })),
  };
}
