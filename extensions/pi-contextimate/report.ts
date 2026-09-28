// Contextimate's startup breakdown as plain data, for other extensions and scripts. This is
// the stable interface; index.ts and the other modules are not. It counts with the panel's
// heuristic and contextimate config, over Pi's current system prompt.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import assert from "node:assert/strict";
import { loadContextimateConfig, toModelSummary } from "./heuristic-config.ts";
import { buildSnapshot, sectionTokens, sourceInfoLabel, totalTokens } from "./snapshot.ts";

export type ContextReport = {
  /** `provider/id` the heuristic was resolved for; absent before a model is selected. */
  model?: string;
  /** The heuristic's label, e.g. "OpenAI-Codex heuristic". */
  heuristic: string;
  /** Estimated tokens for everything sent before the conversation; not the session's context usage. */
  totalTokens: number;
  /** The runtime system prompt, each AGENTS file, the skill index and the active tool definitions. */
  sections: { id: string; title: string; chars: number; tokens: number }[];
  /** Skills in the model's skill index, with what each entry costs. */
  skills: { name: string; location: string; tokens: number }[];
  /** Every registered tool. Only active tools are sent, so only they have tokens. Each is a per-tool
   * estimate; with the provider's payload overhead they need not sum to the tools section. */
  tools: ({ name: string; source: string } & (
    | { active: true; tokens: number }
    | { active: false; tokens?: never }
  ))[];
};

/**
 * Counts `ctx.getSystemPrompt()`: during a run, the prompt that run sent; otherwise Pi's base
 * prompt. After a run the panel keeps counting that run's prompt, so the two can differ when an
 * extension rewrites the prompt per run (for example `pi-skill-gate`).
 */
export function contextReport(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: Pick<ExtensionContext, "model" | "cwd" | "getSystemPrompt">,
): ContextReport {
  const model = toModelSummary(ctx.model);
  const snapshot = buildSnapshot(pi, { systemPrompt: ctx.getSystemPrompt(), model, config: loadContextimateConfig(ctx.cwd) });
  const tools = snapshot.sections.map((section) => section.expanded).find((content) => content.kind === "tools")?.tools ?? [];
  const toolTokens = new Map(tools.map((tool) => [tool.name, tool.tokens]));
  const active = new Set(pi.getActiveTools());
  return {
    ...(model && { model: `${model.provider}/${model.id}` }),
    heuristic: snapshot.heuristic.label,
    totalTokens: totalTokens(snapshot),
    sections: snapshot.sections.map((section) => ({ id: section.id, title: section.title, chars: section.content.length, tokens: sectionTokens(section) })),
    skills: snapshot.skills.map(({ name, location, tokens }) => ({ name, location, tokens })),
    tools: pi.getAllTools().map((tool) => {
      const entry = { name: tool.name, source: sourceInfoLabel(tool) };
      if (!active.has(tool.name)) return { ...entry, active: false };
      const tokens = toolTokens.get(tool.name);
      assert(tokens !== undefined, `Missing estimate for active tool ${tool.name}`);
      return { ...entry, active: true, tokens };
    }),
  };
}
