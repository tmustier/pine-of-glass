// Contextimate's accounting: what fills the model's context before the conversation.
// index.ts renders it; report.ts publishes it.
import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { compactCount } from "../_lib/fmt.ts";
import { estimateCharsAsTokens, type ModelSummary } from "../_lib/heuristics.ts";
import { inlineCount, ratioDetail } from "./metric-rows.ts";
import {
  detectRuntimeAdditions,
  getPromptRemainder,
  parseSkillsBlock,
  PROJECT_INSTRUCTIONS_RE,
  type RuntimeAdditions,
} from "./prompt-parsing.ts";
import { scanSession, type SessionBreakdown, type SessionSource } from "./session-accounting.ts";
import { type ContextimateConfig, type ResolvedHeuristic, resolveHeuristic } from "./heuristic-config.ts";
import {
  type ToolSummary,
  type ToolExpanded,
  summarizeTool,
  buildToolNumerator,
  buildToolFields,
  buildToolDisplayEstimate,
} from "./tool-accounting.ts";

export type ScanRow = {
  name: string;
  tokens?: number;
  desc?: string;
  inactive?: boolean;
};

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
  /** Tools only: minified-payload size, when content.length is not the counted chars. */
  rawChars?: number;
  denominator: number;
  compactRows?: ScanRow[];
  expanded: ExpandedContent;
};

export type PrefixSnapshot = {
  signature: string;
  sections: PrefixSection[];
  tools: ToolSummary[];
  heuristic: ResolvedHeuristic;
  model?: ModelSummary;
  session?: SessionBreakdown;
  contextUsage?: ContextUsage;
  /** Set when pi's exact usage was billed by a different model than the current one
   * (issue #58): the count is old-currency, the window is new-currency, and the two
   * must not be composed. Cleared by the first post-switch usage. */
  preSwitchUsage?: { billedModel: string };
};

function compactPath(filePath: string): string {
  const home = homedir();
  if (filePath === `${home}/.pi/agent/AGENTS.md`) return "Global AGENTS.md";
  if (filePath.startsWith(`${home}/`)) return `~/${filePath.slice(home.length + 1)}`;
  return filePath;
}

export function tildeAll(text: string): string {
  return text.split(`${homedir()}/`).join("~/");
}

export function singleLine(text: string, max = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function firstMeaningfulLines(text: string, maxLines: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

export function parseContextSections(systemPrompt: string, denominator: number): PrefixSection[] {
  const sections: PrefixSection[] = [];
  for (const match of systemPrompt.matchAll(PROJECT_INSTRUCTIONS_RE)) {
    const [, rawPath, content] = match;
    const filePath = rawPath ?? "";
    const title = compactPath(filePath);
    const body = content ?? "";
    const preview = firstMeaningfulLines(body, 8).map((line) => singleLine(line, 150));
    sections.push({
      id: `context:${filePath}`,
      title,
      content: body,
      denominator,
      detail: ratioDetail(denominator),
      expanded: {
        kind: "text",
        note: `${tildeAll(filePath)} · preview only`,
        preview: preview.length > 0 ? preview : ["(no non-empty lines)"],
      },
    });
  }
  return sections;
}

export function runtimeAdditionsAttribution(additions: RuntimeAdditions, denominator: number): string | undefined {
  if (additions.chars === 0) return undefined;
  const tokens = estimateCharsAsTokens(additions.chars, denominator);
  const parts: string[] = [];
  if (additions.snippetCount > 0) parts.push(`${additions.snippetCount} tool snippet${additions.snippetCount === 1 ? "" : "s"}`);
  if (additions.guidelineCount > 0) parts.push(`${additions.guidelineCount} guideline${additions.guidelineCount === 1 ? "" : "s"}`);
  return `of which tool/extension instructions: ~${compactCount(tokens)} tokens (${parts.join(", ")}) · already counted in this row`;
}

export function buildSkillsSection(systemPrompt: string, denominator: number) {
  const block = parseSkillsBlock(systemPrompt, denominator);
  if (!block) return { skills: [] };
  const { content, skills } = block;
  const sortedSkills = [...skills].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  const scanRows = sortedSkills.map((skill) => ({ name: skill.name, tokens: skill.tokens, desc: skill.description }));
  const wrapperChars = Math.max(0, content.length - skills.reduce((sum, skill) => sum + skill.chars, 0));
  const wrapperNote = wrapperChars > 0
    ? `list wrapper/markup  ${inlineCount(wrapperChars, denominator)}`
    : undefined;
  return {
    skills,
    section: {
      id: "skills",
      title: `Skill frontmatter (${skills.length})`,
      content,
      denominator,
      detail: ratioDetail(denominator),
      compactRows: scanRows,
      expanded: { kind: "skills", note: wrapperNote, rows: scanRows },
    } satisfies PrefixSection,
  };
}

/** The active tools, and their section when any are active. */
type ToolsSection = { section?: PrefixSection; tools: ToolSummary[] };

function buildToolsSection(pi: ExtensionAPI, heuristic: ResolvedHeuristic): ToolsSection {
  const activeNames = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools();
  const activeToolInfos = allTools.filter((tool) => activeNames.has(tool.name));
  const inactiveTools = allTools
    .filter((tool) => !activeNames.has(tool.name))
    .map(summarizeTool)
    .sort((a, b) => a.name.localeCompare(b.name));
  const tools = activeToolInfos.map(summarizeTool);
  if (tools.length === 0) return { tools };

  const numerator = buildToolNumerator(tools, heuristic);
  const denominator = heuristic.toolDenominator;
  const effectiveTokens = numerator.tokens ?? estimateCharsAsTokens(numerator.chars, denominator);
  const sectionDetail = typeof numerator.tokens === "number"
    ? "· OpenAI tool render"
    : `${ratioDetail(denominator)} · ${numerator.label}`;
  const toolEstimates = tools.map((tool) => ({ tool, estimate: buildToolDisplayEstimate(tool, heuristic) }));
  const sortedEstimates = [...toolEstimates].sort((a, b) => b.estimate.tokens - a.estimate.tokens || a.tool.name.localeCompare(b.tool.name));
  const compactToolRows: ScanRow[] = [
    ...sortedEstimates.map(({ tool, estimate }) => ({ name: tool.name, tokens: estimate.tokens, desc: tool.description })),
    ...inactiveTools.map((tool) => ({ name: tool.name, desc: `(inactive) ${tool.description}`, inactive: true })),
  ];
  const expandedTools: ToolExpanded[] = sortedEstimates.map(({ tool, estimate }) => ({
    name: tool.name,
    tokens: estimate.tokens,
    source: tool.source,
    description: tool.description,
    fields: buildToolFields(tool.schema),
  }));
  const notes = typeof numerator.tokens === "number"
    ? [
        `counted on OpenAI's TypeScript-style tool render (${compactCount(numerator.chars)} ch) with an o200k_base approximation, plus 16 once`,
      ]
    : [
        `counts use ${numerator.label} at ch ${ratioDetail(denominator)} over the minified provider payload (${compactCount(numerator.chars)} ch); the tree below is the readable view`,
      ];
  return {
    tools,
    section: {
      id: "tools",
      title: `Tools (${tools.length}/${allTools.length} active)`,
      content: numerator.content,
      effectiveTokens,
      rawChars: numerator.chars,
      denominator,
      detail: sectionDetail,
      compactRows: compactToolRows,
      expanded: { kind: "tools", notes, tools: expandedTools },
    },
  };
}

// May throw while pi is still wiring a resumed session; StartupContextComponent.render()
// catches, renders the "unavailable" line, and recovers on the next snapshot.
export function buildSnapshot(
  pi: ExtensionAPI,
  getSystemPrompt: () => string,
  sessionManager?: SessionSource,
  getContextUsage?: () => ContextUsage | undefined,
  getModel?: () => ModelSummary | undefined,
  config: ContextimateConfig = {},
): PrefixSnapshot {
  const systemPrompt = getSystemPrompt();
  const model = getModel?.();
  const heuristic = resolveHeuristic(model, config);
  const textDenominator = heuristic.textDenominator;
  const promptRemainder = getPromptRemainder(systemPrompt);
  const systemPreview = firstMeaningfulLines(promptRemainder, 6).map((line) => singleLine(line));

  // Tools are resolved before the system section so the runtime prompt row can attribute
  // the tool/extension instructions embedded in it (issue #9).
  const { section: toolsSection, tools } = buildToolsSection(pi, heuristic);
  const runtimeAdditions = detectRuntimeAdditions(promptRemainder, tools);

  const sections: PrefixSection[] = [
    {
      id: "system", // id is config/signature API — stays "system" even though the title changed
      title: "Runtime system prompt",
      content: promptRemainder,
      denominator: textDenominator,
      detail: ratioDetail(textDenominator),
      expanded: {
        kind: "text",
        note: "assembled at runtime: pi base prompt + tool/extension instructions · preview only",
        attribution: runtimeAdditionsAttribution(runtimeAdditions, textDenominator),
        preview: systemPreview.length > 0 ? systemPreview : ["(no non-empty lines)"],
      },
    },
    ...parseContextSections(systemPrompt, textDenominator),
  ];

  const { section: skillsSection } = buildSkillsSection(systemPrompt, textDenominator);
  if (skillsSection) sections.push(skillsSection);
  if (toolsSection) sections.push(toolsSection);

  const { breakdown: session, lastBilled } = scanSession(sessionManager);
  const contextUsage = getContextUsage?.();
  const preSwitchUsage = contextUsage && lastBilled && model &&
    (lastBilled.provider !== model.provider || lastBilled.id !== model.id || lastBilled.api !== model.api)
    ? { billedModel: lastBilled.id }
    : undefined;

  const signature = [
    systemPrompt.length,
    model ? `${model.provider}:${model.id}:${model.api}` : "no-model",
    `${heuristic.label}:${heuristic.textDenominator}:${heuristic.sessionDenominator}:${heuristic.toolDenominator}:${heuristic.toolNumerator}`,
    JSON.stringify(config),
    pi.getActiveTools().join(","),
    pi.getAllTools().map((tool) => `${tool.name}:${tool.description.length}`).join(","),
    session ? JSON.stringify(session) : "no-session",
    contextUsage ? `${contextUsage.tokens}:${contextUsage.contextWindow}:${contextUsage.percent}` : "no-usage",
    preSwitchUsage ? `pre-switch:${preSwitchUsage.billedModel}` : "currency-ok",
  ].join("|");

  return { signature, sections, tools, heuristic, model, session, contextUsage, preSwitchUsage };
}

export function sectionTokens(section: PrefixSection): number {
  return section.effectiveTokens ?? estimateCharsAsTokens(section.content.length, section.denominator);
}

export function sectionChars(section: PrefixSection): number {
  return section.rawChars ?? section.content.length;
}

export function totalTokens(snapshot: PrefixSnapshot): number {
  return snapshot.sections.reduce((sum, section) => sum + sectionTokens(section), 0);
}

export function totalChars(snapshot: PrefixSnapshot): number {
  return snapshot.sections.reduce((sum, section) => sum + sectionChars(section), 0);
}
