// Shared accounting for the startup panel and plain-data report.
import type { ContextUsage, ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { compactCount } from "../_lib/fmt.ts";
import { estimateCharsAsTokens, type ModelSummary } from "../_lib/heuristics.ts";
import { SEP } from "../_lib/style.ts";
import {
  aggregateToolPayload, arrayItemsSchema, estimateOpenAIFunctionToolTokens,
  estimateOpenAIToolDefinitionTokens, getSchemaProperties, getSchemaRequired,
  renderOpenAITool, schemaPropertyDescription, schemaPropertyType, toolPayload, toolPayloadLabel,
} from "../_lib/tool-payloads.ts";
import { inlineCount, ratioDetail } from "./metric-rows.ts";
import { detectRuntimeAdditions, getPromptRemainder, parseSkillsBlock, PROJECT_INSTRUCTIONS_RE, type SkillSummary } from "./prompt-parsing.ts";
import { scanSession, type SessionBreakdown, type SessionSource } from "./session-accounting.ts";
import { type ContextimateConfig, type ResolvedHeuristic, resolveHeuristic } from "./heuristic-config.ts";

export type ToolSummary = {
  name: string;
  description: string;
  source: string;
  schema: ToolInfo["parameters"];
  promptGuidelines: string[];
};

export type ToolField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  depth: number;
};

export type ToolExpanded = {
  name: string;
  tokens: number;
  source: string;
  description: string;
  fields: ToolField[];
};

export type ScanRow = { name: string; desc?: string } & (
  | { inactive?: false; tokens: number }
  | { inactive: true; tokens?: never }
);

type ExpandedContent =
  | { kind: "text"; note?: string; attribution?: string; preview?: string[] }
  | { kind: "skills"; note?: string; rows: ScanRow[] }
  | { kind: "tools"; notes: string[]; tools: ToolExpanded[] };

export type PrefixSection = {
  id: string;
  title: string;
  content: string;
  /** Dim suffix after the char count, e.g. "÷ 2.6" or "÷ 2.6 · Anthropic tool payload". */
  detail: string;
  /** Tools only: formula-derived tokens replacing the ch ÷ denominator estimate. */
  effectiveTokens?: number;
  denominator: number;
  compactRows?: ScanRow[];
  expanded: ExpandedContent;
};

export type PrefixSnapshot = {
  signature: string;
  sections: PrefixSection[];
  tools: ToolSummary[];
  skills: SkillSummary[];
  heuristic: ResolvedHeuristic;
  model?: ModelSummary;
  session?: SessionBreakdown;
  contextUsage?: ContextUsage;
  /** Usage from before a model switch cannot be combined with the new model's window. */
  preSwitchUsage?: { billedModel: string };
};

export function sourceInfoLabel({ sourceInfo }: ToolInfo): string {
  return sourceInfo.source === "builtin" ? "builtin" : `${sourceInfo.scope}${SEP}${sourceInfo.path ?? sourceInfo.source}`;
}

export function tildeAll(text: string): string {
  return text.split(`${homedir()}/`).join("~/");
}

export function singleLine(text: string, max = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function previewLines(text: string, maxLines: number, width = 140): string[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, maxLines);
  return lines.length ? lines.map((line) => singleLine(line, width)) : ["(no non-empty lines)"];
}

function toolFields(schema: unknown, depth = 0): ToolField[] {
  const required = new Set(getSchemaRequired(schema));
  const fields: ToolField[] = [];
  for (const [name, property] of Object.entries(getSchemaProperties(schema))) {
    fields.push({ name, type: schemaPropertyType(property), required: required.has(name), description: schemaPropertyDescription(property), depth });
    // agent-default (not a user rule): 2026-09-28, preserve the panel's existing depth limit.
    if (depth < 3) fields.push(...toolFields(property, depth + 1), ...toolFields(arrayItemsSchema(property), depth + 1));
  }
  return fields;
}

// The renderer catches failures while Pi is still wiring a resumed session.
export function buildSnapshot(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  { systemPrompt, model, config = {}, sessionManager, contextUsage }: {
    systemPrompt: string;
    model?: ModelSummary;
    config?: ContextimateConfig;
    sessionManager?: SessionSource;
    contextUsage?: ContextUsage;
  },
): PrefixSnapshot {
  const heuristic = resolveHeuristic(model, config);
  const textDenominator = heuristic.textDenominator;
  const promptRemainder = getPromptRemainder(systemPrompt);
  const activeNames = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools().map((tool): ToolSummary => ({
    name: tool.name,
    description: tool.description.trim() || "(no description)",
    source: sourceInfoLabel(tool),
    schema: tool.parameters,
    promptGuidelines: tool.promptGuidelines ?? [],
  }));
  const tools = allTools.filter((tool) => activeNames.has(tool.name));
  const additions = detectRuntimeAdditions(promptRemainder, tools);
  const parts: string[] = [];
  if (additions.snippetCount > 0) parts.push(`${additions.snippetCount} tool snippet${additions.snippetCount === 1 ? "" : "s"}`);
  if (additions.guidelineCount > 0) parts.push(`${additions.guidelineCount} guideline${additions.guidelineCount === 1 ? "" : "s"}`);
  const attribution = additions.chars === 0 ? undefined
    : `of which tool/extension instructions: ~${compactCount(estimateCharsAsTokens(additions.chars, textDenominator))} tokens (${parts.join(", ")}) · already counted in this row`;
  const sections: PrefixSection[] = [{
    id: "system",
    title: "Runtime system prompt",
    content: promptRemainder,
    denominator: textDenominator,
    detail: ratioDetail(textDenominator),
    expanded: {
      kind: "text",
      note: "assembled at runtime: pi base prompt + tool/extension instructions · preview only",
      attribution,
      preview: previewLines(promptRemainder, 6),
    },
  }];

  for (const match of systemPrompt.matchAll(PROJECT_INSTRUCTIONS_RE)) {
    // Both groups are mandatory in PROJECT_INSTRUCTIONS_RE.
    const filePath = match[1]!;
    const content = match[2]!;
    const home = homedir();
    let title = filePath;
    if (filePath === `${home}/.pi/agent/AGENTS.md`) title = "Global AGENTS.md";
    else if (filePath.startsWith(`${home}/`)) title = `~/${filePath.slice(home.length + 1)}`;
    sections.push({
      id: `context:${filePath}`,
      title,
      content,
      denominator: textDenominator,
      detail: ratioDetail(textDenominator),
      expanded: { kind: "text", note: `${tildeAll(filePath)} · preview only`, preview: previewLines(content, 8, 150) },
    });
  }

  const skillsBlock = parseSkillsBlock(systemPrompt, textDenominator);
  const skills = skillsBlock?.skills ?? [];
  if (skillsBlock) {
    const rows = [...skills].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
      .map((skill) => ({ name: skill.name, tokens: skill.tokens, desc: skill.description }));
    const wrapperChars = skillsBlock.content.length - skills.reduce((sum, skill) => sum + skill.chars, 0);
    sections.push({
      id: "skills",
      title: `Skill frontmatter (${skills.length})`,
      content: skillsBlock.content,
      denominator: textDenominator,
      detail: ratioDetail(textDenominator),
      compactRows: rows,
      expanded: {
        kind: "skills",
        note: wrapperChars > 0 ? `list wrapper/markup  ${inlineCount(wrapperChars, textDenominator)}` : undefined,
        rows,
      },
    });
  }

  if (tools.length > 0) {
    const numerator = heuristic.toolNumerator;
    const denominator = heuristic.toolDenominator;
    const openai = numerator === "openai-cookbook";
    const content = openai ? tools.map(renderOpenAITool).join("") : JSON.stringify(aggregateToolPayload(tools, numerator));
    const label = toolPayloadLabel(numerator);
    const estimates = tools.map((tool) => ({
      ...tool,
      tokens: openai ? estimateOpenAIToolDefinitionTokens(tool)
        : estimateCharsAsTokens(JSON.stringify(toolPayload(tool, numerator)).length, denominator),
    })).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    const inactiveTools = allTools.filter((tool) => !activeNames.has(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
    sections.push({
      id: "tools",
      title: `Tools (${tools.length}/${allTools.length} active)`,
      content,
      effectiveTokens: openai ? estimateOpenAIFunctionToolTokens(tools) : estimateCharsAsTokens(content.length, denominator),
      denominator,
      detail: openai ? "· OpenAI tool render" : `${ratioDetail(denominator)} · ${label}`,
      compactRows: [
        ...estimates.map((tool) => ({ name: tool.name, tokens: tool.tokens, desc: tool.description })),
        ...inactiveTools.map((tool): ScanRow => ({ name: tool.name, desc: `(inactive) ${tool.description}`, inactive: true })),
      ],
      expanded: {
        kind: "tools",
        notes: [openai
          ? `counted on OpenAI's TypeScript-style tool render (${compactCount(content.length)} ch) with an o200k_base approximation, plus 16 once`
          : `counts use ${label} at ch ${ratioDetail(denominator)} over the minified provider payload (${compactCount(content.length)} ch); the tree below is the readable view`],
        tools: estimates.map((tool) => ({ name: tool.name, tokens: tool.tokens, source: tool.source, description: tool.description, fields: toolFields(tool.schema) })),
      },
    });
  }

  const { breakdown: session, lastBilled } = scanSession(sessionManager);
  const preSwitchUsage = contextUsage && lastBilled && model &&
    (lastBilled.provider !== model.provider || lastBilled.id !== model.id || lastBilled.api !== model.api)
    ? { billedModel: lastBilled.id }
    : undefined;
  const signature = [
    systemPrompt.length,
    model ? `${model.provider}:${model.id}:${model.api}` : "no-model",
    `${heuristic.label}:${heuristic.textDenominator}:${heuristic.sessionDenominator}:${heuristic.toolDenominator}:${heuristic.toolNumerator}`,
    JSON.stringify(config),
    [...activeNames].join(","),
    allTools.map((tool) => `${tool.name}:${tool.description.length}`).join(","),
    session ? JSON.stringify(session) : "no-session",
    contextUsage ? `${contextUsage.tokens}:${contextUsage.contextWindow}:${contextUsage.percent}` : "no-usage",
    preSwitchUsage ? `pre-switch:${preSwitchUsage.billedModel}` : "currency-ok",
  ].join("|");

  return { signature, sections, tools, skills, heuristic, model, session, contextUsage, preSwitchUsage };
}

export function sectionTokens(section: PrefixSection): number {
  return section.effectiveTokens ?? estimateCharsAsTokens(section.content.length, section.denominator);
}

export function totalTokens(snapshot: PrefixSnapshot): number {
  return snapshot.sections.reduce((sum, section) => sum + sectionTokens(section), 0);
}
