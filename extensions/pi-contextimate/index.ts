import type { Component } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionAPI, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, keyText } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { stripAnsi } from "../_lib/ansi.ts";
import { configPaths, expandHomePath, readJsonConfig } from "../_lib/config.ts";
import { compactCount } from "../_lib/fmt.ts";

type ViewMode = "summary" | "compact" | "expanded";

type SkillSummary = {
  name: string;
  description: string;
  location: string;
  chars: number;
  tokens: number;
};

type ToolSummary = {
  name: string;
  description: string;
  source: string;
  parameterKeys: string[];
  schema: unknown;
  promptGuidelines: string[];
};

type ScanRow = {
  name: string;
  tokens?: number;
  desc?: string;
  inactive?: boolean;
};

type ToolField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  depth: number;
};

type ToolExpanded = {
  name: string;
  tokens: number;
  source: string;
  description: string;
  fields: ToolField[];
};

type ExpandedContent =
  | { kind: "text"; note?: string; attribution?: string; preview?: string[] }
  | { kind: "skills"; note?: string; rows: ScanRow[] }
  | { kind: "tools"; notes: string[]; tools: ToolExpanded[] };

type PrefixSection = {
  id: string;
  title: string;
  content: string;
  /** Dim suffix after the char count, e.g. "÷ 2.6" or "÷ 2.6 · Anthropic tool payload". */
  detail?: string;
  effectiveTokens?: number;
  rawChars?: number;
  denominator?: number;
  compactRows?: ScanRow[];
  expanded?: ExpandedContent;
};

type ModelSummary = {
  provider: string;
  id: string;
  api: string;
};

type ToolNumeratorSpec = string;

type HeuristicProfile = Partial<Pick<ResolvedHeuristic, "label" | "textDenominator" | "sessionDenominator" | "toolDenominator" | "toolNumerator">>;

type HeuristicRule = HeuristicProfile & {
  profile?: string;
  match?: {
    provider?: string;
    model?: string;
    id?: string;
    api?: string;
  };
};

type ContextimateConfig = {
  profiles?: Record<string, HeuristicProfile>;
  defaults?: Partial<Pick<ResolvedHeuristic, "textDenominator" | "sessionDenominator" | "toolDenominator" | "toolNumerator">> & { profile?: string };
  rules?: HeuristicRule[];
};

type ResolvedHeuristic = {
  label: string;
  source: string;
  textDenominator: number;
  sessionDenominator: number;
  toolDenominator: number;
  toolNumerator: ToolNumeratorSpec;
};

type BuiltInHeuristicRule = {
  label: string;
  providerIncludes?: string[];
  apiEquals?: string[];
  modelRegex?: RegExp;
  textDenominator: number;
  sessionDenominator: number;
  toolDenominator: number;
  toolNumerator: ToolNumeratorSpec;
};

type ToolNumeratorResult = {
  label: string;
  content: string;
  chars: number;
  tokens?: number;
  denominator?: number;
};

type ToolDisplayEstimate = {
  tokens: number;
  chars: number;
};

type SessionBreakdown = {
  thinkingChars: number;
  toolOutputChars: number;
  messageChars: number;
  messageCount: number;
};

type PrefixSnapshot = {
  signature: string;
  fullSystemPromptChars: number;
  sections: PrefixSection[];
  skills: SkillSummary[];
  tools: ToolSummary[];
  loadedToolCount: number;
  heuristic: ResolvedHeuristic;
  model?: ModelSummary;
  configSignature: string;
  session?: SessionBreakdown;
  contextUsage?: ContextUsage;
};

type ContextimateGlobal = typeof globalThis & {
  __piContextimateTui?: any;
  __piContextimateChat?: any;
  __piContextimateBlock?: StartupContextComponent;
  __piContextimateMode?: ViewMode;
  __piContextimateInstallTimer?: ReturnType<typeof setTimeout>;
  __piContextimateModel?: ModelSummary;
};

const g = globalThis as ContextimateGlobal;

const PROJECT_CONTEXT_RE = /\n?<project_context>\n\n[\s\S]*?\n<\/project_context>\n?/;
const PROJECT_INSTRUCTIONS_RE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const AVAILABLE_SKILLS_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>/;
const SKILL_RE = /<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
const RESOURCE_HEADER_RE = /^\s*\[(Context|Skills|Prompts|Extensions|Themes)\]/m;
const DEFAULT_MODE: ViewMode = "summary";
const ORANGE = "\x1b[38;2;245;151;52m";
const RESET = "\x1b[0m";
const OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR = 6.6;

function orange(text: string): string {
  return `${ORANGE}${text}${RESET}`;
}

type TokenLabelLayout = { unitWidth: number; fieldWidth: number };

function compactTokenNumber(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 1000) return `${(rounded / 1000).toFixed(1)}k`;
  return `${Math.round(rounded / 1000)}k`;
}

function tokenIntegerWidth(tokens: number): number {
  return compactTokenNumber(tokens).split(/[.k]/, 1)[0]?.length ?? 0;
}

function estimatedTokenLabel(tokens: number, layout: TokenLabelLayout = tokenLabelLayout([tokens])): string {
  const leftPad = " ".repeat(Math.max(0, layout.unitWidth - tokenIntegerWidth(tokens)));
  return `${leftPad}~${compactTokenNumber(tokens)}`;
}

function estimatedTokenField(tokens: number, layout: TokenLabelLayout): string {
  return estimatedTokenLabel(tokens, layout).padEnd(layout.fieldWidth, " ");
}

function exactTokenLabel(tokens: number, layout: TokenLabelLayout = tokenLabelLayout([tokens])): string {
  const leftPad = " ".repeat(Math.max(0, layout.unitWidth - tokenIntegerWidth(tokens)) + 1);
  return `${leftPad}${compactTokenNumber(tokens)}`;
}

function tokenLabelLayout(tokens: number[]): TokenLabelLayout {
  const unitWidth = Math.max(0, ...tokens.map(tokenIntegerWidth));
  const rawLabels = tokens.map((token) => {
    const leftPad = " ".repeat(Math.max(0, unitWidth - tokenIntegerWidth(token)));
    return `${leftPad}~${compactTokenNumber(token)}`;
  });
  return { unitWidth, fieldWidth: Math.max(0, ...rawLabels.map((label) => label.length)) };
}

function formatPercent(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  return `${value.toFixed(1)}%`;
}

function cleanDenominator(value: unknown, fallback = 4): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function estimateCharsAsTokens(chars: number, denominator: number): number {
  return Math.ceil(chars / cleanDenominator(denominator));
}

function formatDenominator(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// --- the family number grammar: `~0.5k tokens (1.2k ch ÷ 2.6)` -------------------------

function ratioDetail(denominator: number): string {
  return `÷ ${formatDenominator(denominator)}`;
}

function countDetail(chars: number, detail?: string): string {
  return `(${compactCount(chars)} ch${detail ? ` ${detail}` : ""})`;
}

function inlineCount(chars: number, denominator: number): string {
  return `~${compactTokenNumber(estimateCharsAsTokens(chars, denominator))} tokens ${countDetail(chars, ratioDetail(denominator))}`;
}

function formatHeuristicLabel(label: string): string {
  const trimmed = label.trim();
  return /\bheuristic$/i.test(trimmed) ? trimmed : `heuristic ${trimmed}`;
}

function compactPath(filePath: string): string {
  const home = homedir();
  if (filePath === `${home}/.pi/agent/AGENTS.md`) return "Global AGENTS.md";
  if (filePath.startsWith(`${home}/`)) return `~/${filePath.slice(home.length + 1)}`;
  return filePath;
}

function tildePath(filePath: string): string {
  const home = homedir();
  return filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

function tildeAll(text: string): string {
  return text.split(`${homedir()}/`).join("~/");
}

function middleTruncatePath(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return "…";
  const keep = width - 1;
  let tail = Math.min(Math.floor(keep * 0.5), 28);
  const slashIndex = text.lastIndexOf("/");
  if (slashIndex >= 0 && text.length - slashIndex <= Math.floor(keep * 0.6)) {
    tail = text.length - slashIndex;
  }
  const head = Math.max(1, keep - tail);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function safeMinifiedJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function singleLine(text: string, max = 140): string {
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

function getPromptRemainder(systemPrompt: string): string {
  return normalizeBlankLines(
    systemPrompt.replace(PROJECT_CONTEXT_RE, "\n").replace(AVAILABLE_SKILLS_RE, "\n"),
  );
}

function parseSkills(content: string, denominator: number): SkillSummary[] {
  return [...content.matchAll(SKILL_RE)].map((m) => {
    const chars = (m[0] ?? "").length;
    return {
      name: unescapeXml((m[1] ?? "").trim()),
      description: unescapeXml((m[2] ?? "").trim()),
      location: unescapeXml((m[3] ?? "").trim()),
      chars,
      tokens: estimateCharsAsTokens(chars, denominator),
    };
  });
}

function parseContextSections(systemPrompt: string, denominator: number): PrefixSection[] {
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
        note: `${tildePath(filePath)} · preview only`,
        preview: preview.length > 0 ? preview : ["(no non-empty lines)"],
      },
    });
  }
  return sections;
}

type RuntimeAdditions = { chars: number; snippetCount: number; guidelineCount: number };

// Issue #9: the runtime system prompt is assembled from pi's base prompt plus tool- and
// extension-provided instructions (the "Available tools" snippet lines and deduplicated
// promptGuidelines). Attribute the part we can verify: count only text that is actually
// present in the prompt remainder, deduplicating guidelines the same way pi does, so the
// number is evidence-based rather than a guess from tool metadata.
function detectRuntimeAdditions(promptRemainder: string, tools: ToolSummary[]): RuntimeAdditions {
  let chars = 0;
  let snippetCount = 0;
  let guidelineCount = 0;
  const seenGuidelines = new Set<string>();
  for (const tool of tools) {
    const escapedName = tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const snippetMatch = promptRemainder.match(new RegExp(`^- ${escapedName}: .+$`, "m"));
    if (snippetMatch) {
      chars += snippetMatch[0].length + 1; // +1 for the newline the line occupies
      snippetCount += 1;
    }
    for (const guideline of tool.promptGuidelines) {
      const normalized = guideline.trim();
      if (normalized.length === 0 || seenGuidelines.has(normalized)) continue;
      seenGuidelines.add(normalized);
      if (promptRemainder.includes(normalized)) {
        chars += normalized.length + 1;
        guidelineCount += 1;
      }
    }
  }
  return { chars, snippetCount, guidelineCount };
}

function runtimeAdditionsAttribution(additions: RuntimeAdditions, denominator: number): string | undefined {
  if (additions.chars === 0) return undefined;
  const tokens = estimateCharsAsTokens(additions.chars, denominator);
  const parts: string[] = [];
  if (additions.snippetCount > 0) parts.push(`${additions.snippetCount} tool snippet${additions.snippetCount === 1 ? "" : "s"}`);
  if (additions.guidelineCount > 0) parts.push(`${additions.guidelineCount} guideline${additions.guidelineCount === 1 ? "" : "s"}`);
  return `of which tool/extension instructions: ~${compactTokenNumber(tokens)} tokens (${parts.join(", ")}) · already counted in this row`;
}

function buildSkillsSection(systemPrompt: string, denominator: number): { section?: PrefixSection; skills: SkillSummary[] } {
  const match = systemPrompt.match(AVAILABLE_SKILLS_RE);
  if (!match) return { skills: [] };
  const content = match[0].trim();
  const skills = parseSkills(content, denominator);
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
    },
  };
}

function sourceInfoLabel(tool: ToolInfo): string {
  const sourceInfo = tool.sourceInfo;
  if (!sourceInfo) return "unknown";
  const parts = [sourceInfo.scope, sourceInfo.source, sourceInfo.origin].filter(Boolean);
  if (sourceInfo.path) parts.push(sourceInfo.path);
  return parts.join(" · ") || "unknown";
}

function getParameterKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>);
}

function summarizeTool(tool: ToolInfo): ToolSummary {
  return {
    name: tool.name,
    description: tool.description?.trim() || "(no description)",
    source: sourceInfoLabel(tool),
    parameterKeys: getParameterKeys(tool.parameters),
    schema: tool.parameters,
    promptGuidelines: tool.promptGuidelines ?? [],
  };
}

function toModelSummary(model: unknown): ModelSummary | undefined {
  if (!model || typeof model !== "object") return undefined;
  const typed = model as { provider?: unknown; id?: unknown; api?: unknown };
  const provider = typeof typed.provider === "string" ? typed.provider : "unknown";
  const id = typeof typed.id === "string" ? typed.id : "unknown";
  const api = typeof typed.api === "string" ? typed.api : "unknown";
  return { provider, id, api };
}

function modelLabel(model?: ModelSummary): string {
  return model ? `${model.provider}/${model.id}` : "unknown model";
}

function mergeContextimateConfig(base: ContextimateConfig, next?: ContextimateConfig): ContextimateConfig {
  if (!next) return base;
  return {
    ...base,
    ...next,
    defaults: { ...(base.defaults ?? {}), ...(next.defaults ?? {}) },
    profiles: { ...(base.profiles ?? {}), ...(next.profiles ?? {}) },
    rules: [...(base.rules ?? []), ...(Array.isArray(next.rules) ? next.rules : [])],
  };
}

function splitConfigPaths(value: string | undefined): string[] {
  return (value ?? "").split(":").map((entry) => expandHomePath(entry.trim())).filter(Boolean);
}

function loadContextimateConfig(cwd: string): ContextimateConfig {
  const paths = [...configPaths("pi-contextimate", cwd), ...splitConfigPaths(process.env.PI_CONTEXTIMATE_CONFIG)];
  return paths.reduce<ContextimateConfig>(
    (config, filePath) => mergeContextimateConfig(config, readJsonConfig<ContextimateConfig>(filePath)),
    {},
  );
}

function configSignature(config: ContextimateConfig): string {
  return safeJson(config);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(value: string, pattern?: string): boolean {
  if (!pattern) return true;
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const end = pattern.lastIndexOf("/");
    try {
      return new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || undefined).test(value);
    } catch {
      return false;
    }
  }
  if (pattern.includes("*") || pattern.includes("?")) return globToRegex(pattern).test(value);
  return value.toLowerCase() === pattern.toLowerCase();
}

function ruleMatchesModel(rule: HeuristicRule, model?: ModelSummary): boolean {
  const match = rule.match;
  if (!match) return true;
  const provider = model?.provider ?? "";
  const id = model?.id ?? "";
  const api = model?.api ?? "";
  return matchesPattern(provider, match.provider)
    && matchesPattern(id, match.model ?? match.id)
    && matchesPattern(api, match.api);
}

function defaultHeuristic(): ResolvedHeuristic {
  return {
    label: "fallback chars/4",
    source: "fallback",
    textDenominator: 4,
    sessionDenominator: 4,
    toolDenominator: 4,
    toolNumerator: "openai-responses",
  };
}

function applyHeuristicPatch(base: ResolvedHeuristic, patch: HeuristicProfile | Partial<ResolvedHeuristic> | undefined, source: string): ResolvedHeuristic {
  const normalized: Partial<ResolvedHeuristic> = patch ? {
    label: patch.label,
    textDenominator: patch.textDenominator,
    sessionDenominator: patch.sessionDenominator,
    toolDenominator: patch.toolDenominator,
    toolNumerator: patch.toolNumerator,
  } : {};
  return {
    ...base,
    ...normalized,
    // An absent label in a patch must not clobber the base label: unknown providers
    // otherwise reach renderHeader with label undefined and crash formatHeuristicLabel.
    label: normalized.label ?? base.label,
    source,
    textDenominator: cleanDenominator(normalized.textDenominator, base.textDenominator),
    sessionDenominator: cleanDenominator(normalized.sessionDenominator, base.sessionDenominator),
    toolDenominator: cleanDenominator(normalized.toolDenominator, base.toolDenominator),
    toolNumerator: normalized.toolNumerator ?? base.toolNumerator,
  };
}

const BUILT_IN_HEURISTIC_RULES: BuiltInHeuristicRule[] = [
  {
    label: "Claude 4.7+ heuristic",
    providerIncludes: ["anthropic"],
    apiEquals: ["anthropic-messages"],
    modelRegex: /claude.*4[-.]?[78]|4[-.]?[78].*claude/,
    textDenominator: 2.6,
    sessionDenominator: 2.6,
    toolDenominator: 2.6,
    toolNumerator: "anthropic",
  },
  {
    label: "Claude 4.5/4.6 heuristic",
    providerIncludes: ["anthropic"],
    apiEquals: ["anthropic-messages"],
    modelRegex: /claude.*4[-.]?[56]|4[-.]?[56].*claude/,
    textDenominator: 3.8,
    sessionDenominator: 3.5,
    toolDenominator: 3.3,
    toolNumerator: "anthropic",
  },
  {
    label: "Anthropic heuristic",
    providerIncludes: ["anthropic"],
    apiEquals: ["anthropic-messages"],
    textDenominator: 3.5,
    sessionDenominator: 3.5,
    toolDenominator: 3.3,
    toolNumerator: "anthropic",
  },
  {
    label: "OpenAI-Codex heuristic",
    providerIncludes: ["openai-codex"],
    apiEquals: ["openai-codex-responses"],
    textDenominator: 4,
    sessionDenominator: 4,
    toolDenominator: 5.5,
    toolNumerator: "openai-cookbook",
  },
  {
    label: "OpenAI Responses heuristic",
    providerIncludes: ["openai"],
    apiEquals: ["openai-responses", "azure-openai-responses"],
    textDenominator: 4,
    sessionDenominator: 4,
    toolDenominator: 5.5,
    toolNumerator: "openai-responses",
  },
  {
    label: "OpenAI-chat-style heuristic",
    providerIncludes: ["mistral"],
    apiEquals: ["openai-completions", "mistral-conversations"],
    textDenominator: 4,
    sessionDenominator: 4,
    toolDenominator: 5.5,
    toolNumerator: "openai-chat",
  },
  {
    label: "Gemini/Vertex heuristic",
    providerIncludes: ["google", "gemini"],
    apiEquals: ["google-generative-ai", "google-vertex"],
    textDenominator: 4,
    sessionDenominator: 4,
    toolDenominator: 4,
    toolNumerator: "gemini",
  },
  {
    label: "Bedrock heuristic",
    providerIncludes: ["bedrock"],
    apiEquals: ["bedrock-converse-stream"],
    textDenominator: 4,
    sessionDenominator: 4,
    toolDenominator: 4,
    toolNumerator: "bedrock",
  },
];

function builtInRuleMatches(rule: BuiltInHeuristicRule, model: ModelSummary): boolean {
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  const api = model.api.toLowerCase();
  const providerOrApiMatches = (rule.providerIncludes?.some((entry) => provider.includes(entry)) ?? false)
    || (rule.apiEquals?.some((entry) => api === entry) ?? false)
    || (!rule.providerIncludes && !rule.apiEquals);
  const modelMatches = rule.modelRegex ? rule.modelRegex.test(id) : true;
  return providerOrApiMatches && modelMatches;
}

function builtInHeuristicForModel(model?: ModelSummary): Partial<ResolvedHeuristic> | undefined {
  if (!model) return undefined;
  const rule = BUILT_IN_HEURISTIC_RULES.find((candidate) => builtInRuleMatches(candidate, model));
  if (!rule) return undefined;
  return {
    label: rule.label,
    textDenominator: rule.textDenominator,
    sessionDenominator: rule.sessionDenominator,
    toolDenominator: rule.toolDenominator,
    toolNumerator: rule.toolNumerator,
  };
}

// Heuristic resolution is one flat candidate list merged left to right with a single
// patch function: fallback < defaults.profile < defaults < built-in model rule <
// matching config rules (each optionally pulling in a named profile first).
function resolveHeuristic(model: ModelSummary | undefined, config: ContextimateConfig): ResolvedHeuristic {
  const candidates: Array<{ patch: HeuristicProfile | Partial<ResolvedHeuristic> | undefined; source: string }> = [];
  const defaults = config.defaults ?? {};
  if (defaults.profile && config.profiles?.[defaults.profile]) {
    candidates.push({ patch: config.profiles[defaults.profile], source: `profile:${defaults.profile}` });
  }
  candidates.push({ patch: defaults, source: "configured defaults" });
  const builtIn = builtInHeuristicForModel(model);
  if (builtIn) candidates.push({ patch: builtIn, source: builtIn.label ?? "provider-aware heuristic" });
  for (const rule of config.rules ?? []) {
    if (!ruleMatchesModel(rule, model)) continue;
    if (rule.profile && config.profiles?.[rule.profile]) {
      candidates.push({ patch: config.profiles[rule.profile], source: `profile:${rule.profile}` });
    }
    candidates.push({ patch: rule, source: rule.label ?? (rule.profile ? `rule:${rule.profile}` : "custom rule") });
  }
  return candidates.reduce(
    (heuristic, { patch, source }) => applyHeuristicPatch(heuristic, patch, source),
    defaultHeuristic(),
  );
}

function openAIResponsesToolPayload(tool: ToolSummary): unknown {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
    strict: null,
  };
}

function openAIChatToolPayload(tool: ToolSummary): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
      strict: null,
    },
  };
}

function anthropicToolPayload(tool: ToolSummary): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema,
  };
}

function geminiToolPayload(tools: ToolSummary[]): unknown {
  return {
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.schema,
    })),
  };
}

function bedrockToolPayload(tool: ToolSummary): unknown {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.schema },
    },
  };
}

function rawToolPayload(tool: ToolSummary): unknown {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
    promptGuidelines: tool.promptGuidelines,
  };
}

function toolPayloadForShape(tool: ToolSummary, shape: string | undefined): unknown {
  switch (shape) {
    case "openai-chat":
    case "openai-completions":
    case "mistral":
      return openAIChatToolPayload(tool);
    case "anthropic":
      return anthropicToolPayload(tool);
    case "gemini":
    case "google":
    case "vertex":
      return { name: tool.name, description: tool.description, parametersJsonSchema: tool.schema };
    case "bedrock":
      return bedrockToolPayload(tool);
    case "raw-schema":
      return rawToolPayload(tool);
    default:
      return openAIResponsesToolPayload(tool);
  }
}

function aggregateToolPayloadForShape(tools: ToolSummary[], shape: string | undefined): unknown {
  if (shape === "gemini" || shape === "google" || shape === "vertex") return geminiToolPayload(tools);
  return tools.map((tool) => toolPayloadForShape(tool, shape));
}

function toolPayloadLabel(shape: string | undefined): string {
  switch (shape) {
    case "openai-responses":
    case "openai-codex-responses":
      return "OpenAI Responses tool payload";
    case "openai-chat":
    case "openai-completions":
    case "mistral":
      return "OpenAI Chat tool payload";
    case "anthropic":
      return "Anthropic tool payload";
    case "gemini":
    case "google":
    case "vertex":
      return "Gemini/Vertex tool payload";
    case "bedrock":
      return "Bedrock tool payload";
    case "raw-schema":
      return "Raw tool schema payload";
    default:
      return shape ? `Unknown tool shape ${String(shape)}; OpenAI Responses fallback` : "custom template";
  }
}

function buildToolNumerator(tools: ToolSummary[], heuristic: ResolvedHeuristic): ToolNumeratorResult {
  const shape = heuristic.toolNumerator;
  if (shape === "openai-cookbook") {
    const content = safeMinifiedJson(tools.map(openAIResponsesToolPayload));
    return {
      label: "OpenAI-style local formula",
      content,
      chars: content.length,
      tokens: estimateOpenAIFunctionToolTokens(tools),
    };
  }
  const content = safeMinifiedJson(aggregateToolPayloadForShape(tools, shape));
  return {
    label: toolPayloadLabel(shape),
    content,
    chars: content.length,
    denominator: heuristic.toolDenominator,
  };
}

function trimFinalPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

function getSchemaProperties(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return properties as Record<string, unknown>;
}

function schemaPropertyType(property: unknown): string {
  if (!property || typeof property !== "object" || Array.isArray(property)) return "object";
  const typed = property as { type?: unknown; anyOf?: unknown; oneOf?: unknown; allOf?: unknown };
  if (typeof typed.type === "string") return typed.type;
  if (Array.isArray(typed.type)) return typed.type.join("|");
  if (typed.anyOf) return "anyOf";
  if (typed.oneOf) return "oneOf";
  if (typed.allOf) return "allOf";
  return "object";
}

function schemaPropertyDescription(property: unknown): string {
  if (!property || typeof property !== "object" || Array.isArray(property)) return "";
  const description = (property as { description?: unknown }).description;
  return typeof description === "string" ? trimFinalPeriod(description) : "";
}

function schemaPropertyEnum(property: unknown): unknown[] {
  if (!property || typeof property !== "object" || Array.isArray(property)) return [];
  const enumValues = (property as { enum?: unknown }).enum;
  return Array.isArray(enumValues) ? enumValues : [];
}

function schemaArrayItemProperties(property: unknown): Record<string, unknown> {
  if (!property || typeof property !== "object" || Array.isArray(property)) return {};
  const items = (property as { items?: unknown }).items;
  return getSchemaProperties(items);
}

function getSchemaRequired(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((entry): entry is string => typeof entry === "string") : [];
}

function arrayItemsSchema(property: unknown): unknown {
  if (!property || typeof property !== "object" || Array.isArray(property)) return undefined;
  return (property as { items?: unknown }).items;
}

function collectToolFields(name: string, property: unknown, depth: number, required: boolean, out: ToolField[], maxDepth = 3): void {
  out.push({
    name,
    type: schemaPropertyType(property),
    required,
    description: schemaPropertyDescription(property),
    depth,
  });
  if (depth >= maxDepth) return;
  const nested = getSchemaProperties(property);
  if (Object.keys(nested).length > 0) {
    const requiredKeys = new Set(getSchemaRequired(property));
    for (const [childName, childProperty] of Object.entries(nested)) {
      collectToolFields(childName, childProperty, depth + 1, requiredKeys.has(childName), out, maxDepth);
    }
  }
  const itemProperties = schemaArrayItemProperties(property);
  if (Object.keys(itemProperties).length > 0) {
    const requiredKeys = new Set(getSchemaRequired(arrayItemsSchema(property)));
    for (const [childName, childProperty] of Object.entries(itemProperties)) {
      collectToolFields(childName, childProperty, depth + 1, requiredKeys.has(childName), out, maxDepth);
    }
  }
}

function buildToolFields(schema: unknown): ToolField[] {
  const fields: ToolField[] = [];
  const requiredKeys = new Set(getSchemaRequired(schema));
  for (const [name, property] of Object.entries(getSchemaProperties(schema))) {
    collectToolFields(name, property, 0, requiredKeys.has(name), fields, 3);
  }
  return fields;
}

function estimateOpenAIToolTextTokens(text: string): number {
  return estimateCharsAsTokens(text.length, OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR);
}

function estimateOpenAIToolDefinitionTokens(tool: ToolSummary): number {
  let tokens = 7;
  tokens += estimateOpenAIToolTextTokens(`${tool.name}:${trimFinalPeriod(tool.description)}`);
  const propertyEntries = Object.entries(getSchemaProperties(tool.schema));
  if (propertyEntries.length > 0) tokens += 3;
  for (const [propertyName, property] of propertyEntries) tokens += estimateOpenAIPropertyTokens(propertyName, property);
  return tokens;
}

function estimateOpenAIPropertyTokens(propertyName: string, property: unknown): number {
  const propInit = 3;
  const propKey = 3;
  const enumInit = -3;
  const enumItem = 3;

  let tokens = propKey;
  const enumValues = schemaPropertyEnum(property);
  if (enumValues.length > 0) {
    tokens += enumInit;
    for (const enumValue of enumValues) tokens += enumItem + estimateOpenAIToolTextTokens(String(enumValue));
  }
  tokens += estimateOpenAIToolTextTokens(`${propertyName}:${schemaPropertyType(property)}:${schemaPropertyDescription(property)}`);

  const nestedEntries = Object.entries(getSchemaProperties(property));
  if (nestedEntries.length > 0) {
    tokens += propInit;
    for (const [nestedName, nestedProperty] of nestedEntries) tokens += estimateOpenAIPropertyTokens(nestedName, nestedProperty);
  }

  const itemEntries = Object.entries(schemaArrayItemProperties(property));
  if (itemEntries.length > 0) {
    tokens += propInit;
    for (const [itemName, itemProperty] of itemEntries) tokens += estimateOpenAIPropertyTokens(itemName, itemProperty);
  }

  return tokens;
}

function estimateOpenAIFunctionToolTokens(tools: ToolSummary[]): number {
  // OpenAI's public token-counting docs say exact tool counts need the Responses
  // input-token endpoint. For no-API-call startup estimates, use the older
  // cookbook/tiktoken-style schema-summary formula: model-specific constants plus
  // name/description/property summaries, not raw schema JSON. Current public
  // tiktoken maps GPT-5 and GPT-4o families to o200k_base, so use the GPT-4o/GPT-5
  // family constants. A synthetic schema ablation found chars/6.6 over these schema
  // text fragments, plus recursive nested property counting, beats raw schema-char
  // denominators on held-out mixed schemas while remaining dependency-free.
  let tokens = 0;
  for (const tool of tools) tokens += estimateOpenAIToolDefinitionTokens(tool);
  if (tools.length > 0) tokens += 12;
  return tokens;
}

function buildToolDisplayEstimate(tool: ToolSummary, heuristic: ResolvedHeuristic): ToolDisplayEstimate {
  const shape = heuristic.toolNumerator;
  const chars = safeMinifiedJson(toolPayloadForShape(tool, shape)).length;
  if (shape === "openai-cookbook") {
    return { tokens: estimateOpenAIToolDefinitionTokens(tool), chars };
  }
  return { tokens: estimateCharsAsTokens(chars, heuristic.toolDenominator), chars };
}

function buildToolsSection(pi: ExtensionAPI, heuristic: ResolvedHeuristic): { section?: PrefixSection; tools: ToolSummary[]; loadedToolCount: number } {
  const activeNames = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools();
  const activeToolInfos = allTools.filter((tool) => activeNames.has(tool.name));
  const inactiveTools = allTools
    .filter((tool) => !activeNames.has(tool.name))
    .map(summarizeTool)
    .sort((a, b) => a.name.localeCompare(b.name));
  const tools = activeToolInfos.map(summarizeTool);
  if (tools.length === 0) return { tools, loadedToolCount: allTools.length };

  const numerator = buildToolNumerator(tools, heuristic);
  const denominator = numerator.denominator ?? heuristic.toolDenominator;
  const effectiveTokens = numerator.tokens ?? estimateCharsAsTokens(numerator.chars, denominator);
  const numeratorLabel = numerator.label;
  const sectionDetail = typeof numerator.tokens === "number"
    ? `· OpenAI formula · schema text ${ratioDetail(OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR)}`
    : `${ratioDetail(denominator)} · ${numeratorLabel}`;
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
        "formula  +7/fn +3/prop-section +3/prop -3/enum +3/enum-item +12 once · nested counted recursively",
        `counted on the minified provider payload (${compactCount(numerator.chars)} ch); tree below is the readable view of it`,
      ]
    : [
        `counts use ${numeratorLabel} at ch ${ratioDetail(denominator)} over the minified provider payload (${compactCount(numerator.chars)} ch); the tree below is the readable view`,
      ];
  return {
    tools,
    loadedToolCount: allTools.length,
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

function countTextContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (!block || typeof block !== "object") return sum;
    const typed = block as { type?: string; text?: string; data?: string; mimeType?: string };
    if (typed.type === "text") return sum + (typed.text ?? "").length;
    if (typed.type === "image") return sum + `[image:${typed.mimeType ?? "unknown"}:${typed.data?.length ?? 0} chars]`.length;
    return sum;
  }, 0);
}

function countToolCallContent(block: unknown): number {
  if (!block || typeof block !== "object") return 0;
  const toolCall = block as { id?: string; name?: string; arguments?: unknown };
  return safeJson({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }).length;
}

function countReasoningPayload(value: unknown): number {
  if (!value) return 0;
  if (typeof value !== "string") return safeJson(value).length;
  try {
    return safeJson(JSON.parse(value)).length;
  } catch {
    return value.length;
  }
}

function buildSessionBreakdown(sessionManager: unknown): SessionBreakdown | undefined {
  try {
    const manager = sessionManager as {
      getEntries?: () => unknown[];
      getLeafId?: () => string | null;
    };
    const entries = manager.getEntries?.();
    if (!entries || entries.length === 0) return undefined;

    const { messages } = buildSessionContext(entries as any, manager.getLeafId?.());
    if (messages.length === 0) return undefined;

    const breakdown: SessionBreakdown = {
      thinkingChars: 0,
      toolOutputChars: 0,
      messageChars: 0,
      messageCount: messages.length,
    };

    for (const message of convertToLlm(messages)) {
      if (message.role === "toolResult") {
        breakdown.toolOutputChars += countTextContent(message.content);
        continue;
      }
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "thinking") {
            // OpenAI/Codex sends encrypted reasoning items back as context when
            // a signature is present; the visible thinking summary itself is not
            // replayed. For providers without signatures, fall back to text.
            breakdown.thinkingChars += block.thinkingSignature
              ? countReasoningPayload(block.thinkingSignature)
              : (block.thinking ?? "").length;
          } else if (block.type === "toolCall") {
            breakdown.messageChars += countToolCallContent(block);
          } else {
            breakdown.messageChars += countTextContent([block]);
          }
        }
        continue;
      }
      breakdown.messageChars += countTextContent(message.content);
    }

    return breakdown;
  } catch {
    return undefined;
  }
}

function sessionChars(session: SessionBreakdown): number {
  return session.thinkingChars + session.toolOutputChars + session.messageChars;
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function buildSnapshot(
  pi: ExtensionAPI,
  getSystemPrompt: () => string,
  sessionManager?: unknown,
  getContextUsage?: () => ContextUsage | undefined,
  getModel?: () => unknown,
  config: ContextimateConfig = {},
): PrefixSnapshot {
  const systemPrompt = safely(() => getSystemPrompt() ?? "", "");
  const model = toModelSummary(safely(() => getModel?.(), undefined)) ?? g.__piContextimateModel;
  const heuristic = resolveHeuristic(model, config);
  const textDenominator = heuristic.textDenominator;
  const promptRemainder = getPromptRemainder(systemPrompt);
  const systemPreview = firstMeaningfulLines(promptRemainder, 6).map((line) => singleLine(line));

  // Tools are resolved before the system section so the runtime prompt row can attribute
  // the tool/extension instructions embedded in it (issue #9).
  let tools: ToolSummary[] = [];
  let loadedToolCount = 0;
  const toolsResult = safely(() => buildToolsSection(pi, heuristic), undefined as ReturnType<typeof buildToolsSection> | undefined);
  if (toolsResult) {
    tools = toolsResult.tools;
    loadedToolCount = toolsResult.loadedToolCount;
  }
  const runtimeAdditions = safely(() => detectRuntimeAdditions(promptRemainder, tools), { chars: 0, snippetCount: 0, guidelineCount: 0 });

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

  const { section: skillsSection, skills } = buildSkillsSection(systemPrompt, textDenominator);
  if (skillsSection) sections.push(skillsSection);
  if (toolsResult?.section) sections.push(toolsResult.section);

  const session = buildSessionBreakdown(sessionManager);
  const contextUsage = safely(() => getContextUsage?.(), undefined);
  const cfgSignature = configSignature(config);
  const activeToolSignature = safely(() => pi.getActiveTools().join(","), "tools-unavailable");
  const loadedToolSignature = safely(
    () => pi.getAllTools().map((tool) => `${tool.name}:${tool.description?.length ?? 0}`).join(","),
    "tools-unavailable",
  );

  const signature = [
    systemPrompt.length,
    model ? `${model.provider}:${model.id}:${model.api}` : "no-model",
    `${heuristic.label}:${heuristic.textDenominator}:${heuristic.sessionDenominator}:${heuristic.toolDenominator}:${safeJson(heuristic.toolNumerator)}`,
    cfgSignature,
    activeToolSignature,
    loadedToolSignature,
    session ? `${session.thinkingChars}:${session.toolOutputChars}:${session.messageChars}:${session.messageCount}` : "no-session",
    contextUsage ? `${contextUsage.tokens}:${contextUsage.contextWindow}:${contextUsage.percent}` : "no-usage",
  ].join("|");

  return { signature, fullSystemPromptChars: systemPrompt.length, sections, skills, tools, loadedToolCount, heuristic, model, configSignature: cfgSignature, session, contextUsage };
}

function sectionTokens(section: PrefixSection): number {
  return section.effectiveTokens ?? estimateCharsAsTokens(section.content.length, section.denominator ?? 4);
}

function sectionChars(section: PrefixSection): number {
  return section.rawChars ?? section.content.length;
}

function totalTokens(snapshot: PrefixSnapshot): number {
  return snapshot.sections.reduce((sum, section) => sum + sectionTokens(section), 0);
}

function totalChars(snapshot: PrefixSnapshot): number {
  return snapshot.sections.reduce((sum, section) => sum + sectionChars(section), 0);
}

function nextMode(mode: ViewMode): ViewMode {
  return mode === "summary" ? "compact" : mode === "compact" ? "expanded" : "summary";
}

function renderModePips(mode: ViewMode, theme: Theme): string {
  const modes: ViewMode[] = ["summary", "compact", "expanded"];
  return modes
    .map((candidate) => candidate === mode ? orange(theme.bold(candidate)) : theme.fg("dim", candidate))
    .join(theme.fg("dim", " → "));
}

function padLabel(label: string, width = 42): string {
  return label.length >= width ? `${label} ` : label.padEnd(width, " ");
}

function renderHeader(snapshot: PrefixSnapshot, mode: ViewMode, theme: Theme): string[] {
  const ctrlO = keyText("app.tools.expand") || "Ctrl+O";
  return [
    "",
    `${orange(theme.bold("[Context Estimator]"))} ${renderModePips(mode, theme)}`,
    `  ${theme.fg("dim", `${ctrlO}: cycle view · model ${modelLabel(snapshot.model)} · ${formatHeuristicLabel(snapshot.heuristic.label)}`)}`,
  ];
}

// One renderer for every label/tokens/detail row — section rows, session rows, and
// totals all flow through here, so alignment and grammar can never diverge.
type MetricRow = {
  label: string;
  tokens: number;
  /** pi-reported numbers render without the ~ estimate marker. */
  exact?: boolean;
  /** total rows: orange + bold. */
  emphasis?: boolean;
  /** dim suffix, parens included, e.g. "(1.2k ch ÷ 2.6)" or "(residual)". */
  detail?: string;
};

function renderMetricRow(row: MetricRow, theme: Theme, layout?: TokenLabelLayout): string {
  const tokenText = `${row.exact ? exactTokenLabel(row.tokens, layout) : estimatedTokenLabel(row.tokens, layout)} tokens`;
  if (row.emphasis) {
    return `  ${orange(theme.bold(`${padLabel(row.label)}${tokenText}`))}${row.detail ? ` ${theme.fg("dim", row.detail)}` : ""}`;
  }
  return `  ${theme.fg("muted", padLabel(row.label))}${theme.fg("dim", `${tokenText}${row.detail ? ` ${row.detail}` : ""}`)}`;
}

function sectionDetailText(section: PrefixSection, fallbackDenominator: number): string {
  return countDetail(
    sectionChars(section),
    section.detail ?? ratioDetail(section.denominator ?? fallbackDenominator),
  );
}

function joinLeftRight(left: string, right: string, width: number, gap = 2): string {
  if (!right) return left;
  const used = stripAnsi(left).length + stripAnsi(right).length;
  return `${left}${" ".repeat(Math.max(gap, width - used))}${right}`;
}

function wrapPlainText(text: string, width: number, maxLines: number): string[] {
  const max = Math.max(16, width);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const wrapped = wrapTextWithAnsi(normalized, max);
  if (wrapped.length <= maxLines) return wrapped;
  const capped = wrapped.slice(0, maxLines);
  const last = capped[maxLines - 1] ?? "";
  // Reserve a column for the ellipsis so the capped line still fits `width`.
  capped[maxLines - 1] = last.length >= max ? `${last.slice(0, max - 1)}…` : `${last}…`;
  return capped;
}

function renderExpandedSectionHeader(section: PrefixSection, snapshot: PrefixSnapshot, theme: Theme, width: number): string {
  const tokens = sectionTokens(section);
  const chars = sectionChars(section);
  const method = section.detail ?? ratioDetail(section.denominator ?? snapshot.heuristic.textDenominator);
  const left = `  ${theme.bold(section.title)}  ${orange(`${estimatedTokenLabel(tokens)} tokens`)}`;
  const right = theme.fg("dim", `${compactCount(chars)} ch ${method}`);
  return joinLeftRight(left, right, Math.max(40, width));
}

function renderExpandedNote(note: string, theme: Theme): string {
  return `    ${theme.fg("dim", note)}`;
}

function renderExpandedPreview(lines: string[], theme: Theme, width: number): string[] {
  const max = Math.max(24, width - 4);
  return lines.map((line) => `    ${theme.fg("dim", singleLine(line, max))}`);
}

function renderToolFieldRows(fields: ToolField[], theme: Theme, width: number): string[] {
  if (fields.length === 0) return [`      ${theme.fg("dim", "(no parameters)")}`];
  const indentFor = (depth: number) => 6 + depth * 2;
  const nameCol = Math.min(30, Math.max(...fields.map((field) => indentFor(field.depth) + field.name.length)));
  const typeCol = Math.min(10, Math.max(...fields.map((field) => field.type.length)));
  const hasRequired = fields.some((field) => field.required);
  return fields.map((field) => {
    const rawName = `${" ".repeat(indentFor(field.depth))}${field.name}`;
    const namePart = rawName.length > nameCol ? `${rawName.slice(0, nameCol - 1)}…` : rawName.padEnd(nameCol, " ");
    const typePart = field.type.length > typeCol ? `${field.type.slice(0, typeCol - 1)}…` : field.type.padEnd(typeCol, " ");
    const reqPart = hasRequired ? (field.required ? "required" : "        ") : "";
    const prefixWidth = namePart.length + 2 + typePart.length + (hasRequired ? 2 + reqPart.length : 0);
    const descWidth = Math.max(16, width - prefixWidth - 3);
    const desc = field.description ? singleLine(field.description, descWidth) : "";
    return `${theme.fg("text", namePart)}  ${theme.fg("muted", typePart)}${hasRequired ? `  ${theme.fg("dim", reqPart)}` : ""}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

function expandedToolLabel(tool: ToolExpanded): string {
  return tildeAll([tool.name, tool.source].filter(Boolean).join(" · "));
}

function renderExpandedToolHeader(tool: ToolExpanded, tokenLayout: TokenLabelLayout, theme: Theme, width: number): string {
  const maxWidth = Math.max(40, width);
  const indent = "    ";
  const gap = 2;
  const token = estimatedTokenField(tool.tokens, tokenLayout);
  const sourceWidth = Math.max(12, maxWidth - indent.length - gap - tokenLayout.fieldWidth);
  const label = middleTruncatePath(expandedToolLabel(tool), sourceWidth);
  const used = indent.length + stripAnsi(label).length + tokenLayout.fieldWidth;
  return `${indent}${theme.fg("text", label)}${" ".repeat(Math.max(gap, maxWidth - used))}${orange(token)}`;
}

function renderExpandedToolsBlock(content: { notes: string[]; tools: ToolExpanded[] }, theme: Theme, width: number): string[] {
  const out: string[] = [];
  const tokenLayout = tokenLabelLayout(content.tools.map((tool) => tool.tokens));
  for (const note of content.notes) {
    for (const line of wrapPlainText(note, Math.max(24, width - 4), 4)) out.push(`    ${theme.fg("dim", line)}`);
  }
  for (const tool of content.tools) {
    out.push("");
    out.push(renderExpandedToolHeader(tool, tokenLayout, theme, width));
    if (tool.description && tool.description !== "(no description)") {
      for (const line of wrapPlainText(tool.description, Math.max(24, width - 6), 3)) {
        out.push(`      ${theme.fg("dim", line)}`);
      }
    }
    out.push(...renderToolFieldRows(tool.fields, theme, width));
  }
  return out;
}

type SessionEstimate = {
  totalTokens: number;
  totalSource: "pi" | "heuristic";
  toolOutputTokens: number;
  messageTokens: number;
  otherTokens: number;
  denominator: number;
};

function buildSessionEstimate(snapshot: PrefixSnapshot): SessionEstimate | undefined {
  if (!snapshot.session) return undefined;
  const denominator = snapshot.heuristic.sessionDenominator;
  const toolOutputTokens = estimateCharsAsTokens(snapshot.session.toolOutputChars, denominator);
  const messageTokens = estimateCharsAsTokens(snapshot.session.messageChars, denominator);
  const heuristicTotal = estimateCharsAsTokens(sessionChars(snapshot.session), denominator);
  const harnessTokens = totalTokens(snapshot);
  const piSessionTokens = snapshot.contextUsage?.tokens === null || snapshot.contextUsage?.tokens === undefined
    ? undefined
    : Math.max(0, Math.round(snapshot.contextUsage.tokens - harnessTokens));
  const totalTokensValue = piSessionTokens ?? heuristicTotal;
  const otherTokens = Math.max(0, Math.round(totalTokensValue - toolOutputTokens - messageTokens));
  return {
    totalTokens: totalTokensValue,
    totalSource: piSessionTokens === undefined ? "heuristic" : "pi",
    toolOutputTokens,
    messageTokens,
    otherTokens,
    denominator,
  };
}

function renderSessionRows(snapshot: PrefixSnapshot, theme: Theme, layout?: TokenLabelLayout): string[] {
  const estimate = buildSessionEstimate(snapshot);
  if (!snapshot.session || !estimate) return [];
  const ratio = ratioDetail(estimate.denominator);
  const rows = [
    "",
    renderMetricRow({ label: "Tool outputs", tokens: estimate.toolOutputTokens, detail: countDetail(snapshot.session.toolOutputChars, ratio) }, theme, layout),
    renderMetricRow({ label: "Messages", tokens: estimate.messageTokens, detail: countDetail(snapshot.session.messageChars, ratio) }, theme, layout),
    renderMetricRow({ label: "Other / reasoning", tokens: estimate.otherTokens, detail: "(residual)" }, theme, layout),
    renderMetricRow({
      label: "Total session",
      tokens: estimate.totalTokens,
      emphasis: true,
      detail: estimate.totalSource === "pi" ? "(Pi current - harness)" : "(heuristic fallback)",
    }, theme, layout),
  ];
  const usage = snapshot.contextUsage;
  if (usage && usage.tokens !== null) {
    const percent = formatPercent(usage.percent);
    const window = usage.contextWindow > 0 ? compactTokenNumber(usage.contextWindow) : undefined;
    rows.push(renderMetricRow({
      label: "Total request",
      tokens: usage.tokens,
      exact: true,
      emphasis: true,
      detail: percent && window ? `(${percent} / ${window} ctx)` : "(Pi usage)",
    }, theme, layout));
  }
  return rows;
}

function summaryTokenWidth(snapshot: PrefixSnapshot): TokenLabelLayout {
  const values = [...snapshot.sections.map(sectionTokens), totalTokens(snapshot)];
  const sessionEstimate = buildSessionEstimate(snapshot);
  if (sessionEstimate) values.push(
    sessionEstimate.totalTokens,
    sessionEstimate.toolOutputTokens,
    sessionEstimate.messageTokens,
    sessionEstimate.otherTokens,
  );
  if (typeof snapshot.contextUsage?.tokens === "number") values.push(snapshot.contextUsage.tokens);
  return tokenLabelLayout(values);
}

function renderSummary(snapshot: PrefixSnapshot, theme: Theme): string[] {
  const lines = renderHeader(snapshot, "summary", theme);
  const layout = summaryTokenWidth(snapshot);
  lines.push("");
  for (const section of snapshot.sections) {
    lines.push(renderMetricRow({
      label: section.title,
      tokens: sectionTokens(section),
      detail: sectionDetailText(section, snapshot.heuristic.textDenominator),
    }, theme, layout));
  }
  lines.push(
    renderMetricRow({ label: "Total harness", tokens: totalTokens(snapshot), emphasis: true, detail: countDetail(totalChars(snapshot)) }, theme, layout),
    ...renderSessionRows(snapshot, theme, layout),
  );
  return lines;
}

type CompactLayout = { labelWidth: number; tokenLayout: TokenLabelLayout };

function compactLabel(label: string, width: number): string {
  if (label.length > width) return `${label.slice(0, Math.max(0, width - 1))}…`;
  return label.padEnd(width, " ");
}

function numericRowTokens(rows: ScanRow[]): number[] {
  return rows.flatMap((row) => typeof row.tokens === "number" ? [row.tokens] : []);
}

function compactLayout(snapshot: PrefixSnapshot): CompactLayout {
  const rows = snapshot.sections.flatMap((section) => section.compactRows ?? []);
  const labels = [
    ...snapshot.sections.map((section) => section.title),
    ...rows.map((row) => row.name),
    "Total harness",
  ];
  const labelWidth = Math.min(26, Math.max(0, ...labels.map((label) => label.length)));
  const tokenLayout = tokenLabelLayout([
    ...snapshot.sections.map(sectionTokens),
    ...numericRowTokens(rows),
    totalTokens(snapshot),
  ]);
  return { labelWidth, tokenLayout };
}

function inactiveTokenField(layout: TokenLabelLayout): string {
  return "-".padStart(Math.max(1, layout.unitWidth + 1)).padEnd(Math.max(layout.fieldWidth, layout.unitWidth + 1, 1), " ");
}

function renderScanRows(rows: ScanRow[], theme: Theme, width: number, layout?: CompactLayout): string[] {
  const labelWidth = layout?.labelWidth ?? Math.min(26, Math.max(...rows.map((row) => row.name.length)));
  const tokenLayout = layout?.tokenLayout ?? tokenLabelLayout(numericRowTokens(rows));
  const tokenWidth = Math.max(tokenLayout.fieldWidth, tokenLayout.unitWidth + 1, 1);
  const effectiveTokenLayout = { ...tokenLayout, fieldWidth: tokenWidth };
  const descWidth = Math.max(24, width - (4 + labelWidth + 2 + tokenWidth + 2));
  return rows.map((row) => {
    const name = compactLabel(row.name, labelWidth);
    const desc = row.desc ? singleLine(row.desc, descWidth) : "";
    const token = typeof row.tokens === "number"
      ? estimatedTokenField(row.tokens, effectiveTokenLayout)
      : inactiveTokenField(effectiveTokenLayout);
    if (row.inactive) {
      return theme.fg("dim", `    ${name}  ${token}${desc ? `  ${desc}` : ""}`);
    }
    return `    ${theme.fg("text", name)}  ${orange(token)}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

function renderCompactTotalRow(snapshot: PrefixSnapshot, theme: Theme, layout: CompactLayout): string {
  const label = compactLabel("Total harness", layout.labelWidth + 2);
  const token = `${estimatedTokenLabel(totalTokens(snapshot), layout.tokenLayout)} tokens`;
  return `  ${orange(theme.bold(`${label}  ${token}`))} ${theme.fg("dim", countDetail(totalChars(snapshot)))}`;
}

function renderCompact(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "compact", theme);
  const layout = compactLayout(snapshot);
  for (const section of snapshot.sections) {
    const title = compactLabel(section.title, layout.labelWidth);
    const counts = `${estimatedTokenLabel(sectionTokens(section), layout.tokenLayout)} tokens ${sectionDetailText(section, snapshot.heuristic.textDenominator)}`;
    lines.push("", `  ${orange("▸")} ${theme.bold(title)}  ${theme.fg("dim", counts)}`);
    if (section.compactRows && section.compactRows.length > 0) {
      lines.push(...renderScanRows(section.compactRows, theme, width, layout));
    }
  }
  const sessionTokenWidth = summaryTokenWidth(snapshot);
  lines.push("", renderCompactTotalRow(snapshot, theme, layout), ...renderSessionRows(snapshot, theme, sessionTokenWidth));
  return lines;
}

function renderExpanded(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "expanded", theme);
  const layout = summaryTokenWidth(snapshot);
  lines.push(
    renderMetricRow({ label: "Total harness", tokens: totalTokens(snapshot), emphasis: true, detail: countDetail(totalChars(snapshot)) }, theme, layout),
    ...renderSessionRows(snapshot, theme, layout),
  );

  for (const section of snapshot.sections) {
    lines.push("", renderExpandedSectionHeader(section, snapshot, theme, width));
    const expanded = section.expanded;
    if (!expanded) {
      lines.push(...renderExpandedPreview(firstMeaningfulLines(section.content || "(empty)", 6), theme, width));
      continue;
    }
    if (expanded.kind === "tools") {
      lines.push(...renderExpandedToolsBlock(expanded, theme, width));
      continue;
    }
    if (expanded.note) lines.push(renderExpandedNote(expanded.note, theme));
    if (expanded.kind === "text" && expanded.attribution) lines.push(renderExpandedNote(expanded.attribution, theme));
    if (expanded.kind === "skills") {
      lines.push("", ...renderScanRows(expanded.rows, theme, width));
    } else if (expanded.preview && expanded.preview.length > 0) {
      lines.push("", ...renderExpandedPreview(expanded.preview, theme, width));
    }
  }

  return lines;
}

function wrapLines(lines: string[], width: number): string[] {
  const maxWidth = Math.max(24, width);
  const out: string[] = [];
  for (const rawLine of lines.join("\n").split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    const wrapped = wrapTextWithAnsi(rawLine, maxWidth);
    if (wrapped.length === 0) out.push("");
    else out.push(...wrapped.map((line) => truncateToWidth(line, maxWidth, "…")));
  }
  return out;
}

class StartupContextComponent implements Component {
  readonly __piContextimateBlock = true;
  private cachedSignature?: string;
  private cachedMode?: ViewMode;
  private cachedWidth?: number;
  private cachedLines?: string[];

  // No TS parameter properties: keep the source compatible with Node's strip-only
  // type stripping so the zero-dependency test harness can import this file directly.
  private readonly snapshot: () => PrefixSnapshot;
  private readonly getTheme: () => Theme;
  private mode: ViewMode;

  constructor(snapshot: () => PrefixSnapshot, getTheme: () => Theme, mode: ViewMode) {
    this.snapshot = snapshot;
    this.getTheme = getTheme;
    this.mode = mode;
  }

  getMode(): ViewMode {
    return this.mode;
  }

  setMode(mode: ViewMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      g.__piContextimateMode = mode;
      this.invalidate();
    }
  }

  setExpanded(_expanded: boolean): void {
    // Pi's native Ctrl+O path toggles one global boolean and calls setExpanded()
    // on every expandable chat component exactly once per toggle. Use that as
    // the single source of truth for cycling; do not also listen to raw terminal
    // input, or one keypress can advance twice.
    this.cycleMode();
  }

  cycleMode(): ViewMode {
    this.setMode(nextMode(this.mode));
    return this.mode;
  }

  render(width: number): string[] {
    try {
      const snapshot = this.snapshot();
      if (
        this.cachedLines &&
        this.cachedSignature === snapshot.signature &&
        this.cachedMode === this.mode &&
        this.cachedWidth === width
      ) {
        return this.cachedLines;
      }

      const theme = this.getTheme();
      const body = this.mode === "summary"
        ? renderSummary(snapshot, theme)
        : this.mode === "compact"
          ? renderCompact(snapshot, theme, width)
          : renderExpanded(snapshot, theme, width);

      this.cachedSignature = snapshot.signature;
      this.cachedMode = this.mode;
      this.cachedWidth = width;
      this.cachedLines = wrapLines(body, Math.max(20, width));
      return this.cachedLines;
    } catch {
      this.cachedSignature = "contextimate-unavailable";
      this.cachedMode = this.mode;
      this.cachedWidth = width;
      this.cachedLines = wrapLines([
        "",
        `${ORANGE}[Context Estimator]${RESET} unavailable while Pi finishes resuming this session`,
      ], Math.max(20, width));
      return this.cachedLines;
    }
  }

  invalidate(): void {
    this.cachedSignature = undefined;
    this.cachedMode = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function renderPlain(component: Component, width = 120): string {
  try {
    return stripAnsi(component.render(width).join("\n"));
  } catch {
    return "";
  }
}

function isPrefixBlock(component: unknown): component is StartupContextComponent {
  return !!component && typeof component === "object" && (component as { __piContextimateBlock?: boolean }).__piContextimateBlock === true;
}

function isResourceComponent(component: Component): boolean {
  if (isPrefixBlock(component)) return false;
  // Resource rows are leaf ExpandableText components. Aggregate containers such as
  // the chat root can render their children and would otherwise be mistaken for a
  // resource row, causing us to remove the whole chat container.
  if (Array.isArray((component as Component & { children?: unknown }).children)) return false;
  return RESOURCE_HEADER_RE.test(renderPlain(component));
}

function isBlankComponent(component: Component): boolean {
  const text = renderPlain(component, 80);
  return text.trim().length === 0;
}

function findResourceChatContainer(node: any, seen = new Set<any>()): any | undefined {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  const children = node.children;
  if (Array.isArray(children) && children.some((child) => isResourceComponent(child))) {
    return node;
  }
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findResourceChatContainer(child, seen);
      if (found) return found;
    }
  }
  return undefined;
}

function removeExistingPrefixBlocks(chat: any): void {
  if (!Array.isArray(chat.children)) return;
  chat.children = chat.children.filter((child: Component) => !isPrefixBlock(child));
}

function insertionIndexAfterResourceList(chat: any): number {
  if (!Array.isArray(chat.children)) return -1;
  let index = -1;
  for (let i = 0; i < chat.children.length; i++) {
    const child = chat.children[i] as Component;
    if (isPrefixBlock(child)) continue;
    if (RESOURCE_HEADER_RE.test(renderPlain(child))) {
      index = i;
      if (i + 1 < chat.children.length && isBlankComponent(chat.children[i + 1] as Component)) index = i + 1;
    }
  }
  return index;
}

function isContextBlockInstalled(block: StartupContextComponent): boolean {
  const chat = g.__piContextimateChat;
  return Array.isArray(chat?.children) && chat.children.includes(block);
}

function installContextBlock(block: StartupContextComponent): boolean {
  const tui = g.__piContextimateTui;
  const chat = findResourceChatContainer(tui) ?? g.__piContextimateChat;
  if (!chat || !Array.isArray(chat.children)) return false;

  g.__piContextimateChat = chat;
  if (chat.children.includes(block)) return true;

  removeExistingPrefixBlocks(chat);
  const insertAfter = insertionIndexAfterResourceList(chat);
  const insertAt = insertAfter >= 0 ? insertAfter + 1 : 0;
  chat.children.splice(insertAt, 0, block);
  tui?.requestRender?.(true);
  return true;
}

function scheduleInstall(block: StartupContextComponent): void {
  if (g.__piContextimateInstallTimer) clearTimeout(g.__piContextimateInstallTimer);
  let attempts = 0;
  const attempt = () => {
    attempts++;
    if (safely(() => installContextBlock(block), false)) return;
    if (attempts < 30) {
      g.__piContextimateInstallTimer = setTimeout(attempt, 50);
    }
  };
  g.__piContextimateInstallTimer = setTimeout(attempt, 0);
}

function setMode(mode: ViewMode): void {
  g.__piContextimateMode = mode;
  g.__piContextimateBlock?.setMode(mode);
  g.__piContextimateTui?.requestRender?.(true);
}

// Test-only surface. Pi loads extensions via `jiti.import(path, { default: true })`,
// so named exports are runtime-inert; this object exists for the repo test suites
// (see docs/testing.md) and is not a stable public API.
export const internals = {
  // system-prompt parsing
  PROJECT_CONTEXT_RE,
  PROJECT_INSTRUCTIONS_RE,
  AVAILABLE_SKILLS_RE,
  SKILL_RE,
  RESOURCE_HEADER_RE,
  getPromptRemainder,
  parseSkills,
  parseContextSections,
  buildSkillsSection,
  // heuristic resolution
  defaultHeuristic,
  cleanDenominator,
  resolveHeuristic,
  // provider payload shaping
  toolPayloadForShape,
  aggregateToolPayloadForShape,
  buildToolNumerator,
  buildToolDisplayEstimate,
  // OpenAI cookbook-style formula
  estimateOpenAIToolDefinitionTokens,
  estimateOpenAIFunctionToolTokens,
  // session accounting
  buildSessionBreakdown,
  buildSessionEstimate,
  // token label layout
  compactTokenNumber,
  tokenLabelLayout,
  estimatedTokenLabel,
  estimatedTokenField,
  exactTokenLabel,
  inlineCount,
  countDetail,
  ratioDetail,
  renderMetricRow,
  // runtime-addition attribution (issue #9)
  detectRuntimeAdditions,
  runtimeAdditionsAttribution,
  // snapshot + renderers
  buildSnapshot,
  totalTokens,
  renderSummary,
  renderCompact,
  renderExpanded,
  stripAnsi,
};

export type {
  PrefixSnapshot,
  PrefixSection,
  ToolSummary,
  ModelSummary,
  ContextimateConfig,
  ResolvedHeuristic,
  SessionBreakdown,
};

export default function piContextimate(pi: ExtensionAPI) {
  // Snapshot building is expensive (system-prompt regex parse, JSON serialization of
  // every tool schema, a full session walk) while rendering is frequent. Rebuild only
  // after a context-changing event or a short staleness window — never per render frame.
  const SNAPSHOT_TTL_MS = 5_000;
  const cache: { value?: PrefixSnapshot; builtAt: number; dirty: boolean } = { builtAt: 0, dirty: true };
  const markDirty = () => {
    cache.dirty = true;
  };

  pi.on("message_end", async () => markDirty());
  pi.on("session_compact", async () => markDirty());

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Restore Pi's normal header; this extension now renders below Pi's loaded-resource list.
    ctx.ui.setHeader(undefined);

    const currentMode = g.__piContextimateMode ?? DEFAULT_MODE;
    const config = loadContextimateConfig(ctx.cwd);
    g.__piContextimateModel = toModelSummary(ctx.model);
    markDirty();
    const block = new StartupContextComponent(
      () => {
        const now = Date.now();
        if (!cache.value || cache.dirty || now - cache.builtAt > SNAPSHOT_TTL_MS) {
          cache.value = buildSnapshot(
            pi,
            () => ctx.getSystemPrompt(),
            ctx.sessionManager,
            () => ctx.getContextUsage(),
            () => g.__piContextimateModel ?? toModelSummary(ctx.model),
            config,
          );
          cache.builtAt = now;
          cache.dirty = false;
        }
        return cache.value;
      },
      () => ctx.ui.theme,
      currentMode,
    );
    g.__piContextimateBlock = block;

    ctx.ui.setWidget("__pi_contextimate_capture", (tui: any) => {
      g.__piContextimateTui = tui;
      return {
        render: () => {
          const activeBlock = g.__piContextimateBlock;
          // Ctrl+T rebuilds Pi's chat transcript to toggle thinking visibility,
          // which can drop startup-only chat children. Keep this zero-line widget
          // mounted so it can quietly reinsert the estimator after such rebuilds.
          if (activeBlock && !isContextBlockInstalled(activeBlock)) scheduleInstall(activeBlock);
          return [] as string[];
        },
        invalidate: () => {},
      };
    });

    scheduleInstall(block);

  });

  pi.on("model_select", async (event, ctx) => {
    g.__piContextimateModel = toModelSummary(event.model);
    markDirty();
    g.__piContextimateBlock?.invalidate();
    if (ctx.hasUI) g.__piContextimateTui?.requestRender?.(true);
  });

  pi.on("session_shutdown", async () => {
    if (g.__piContextimateInstallTimer) clearTimeout(g.__piContextimateInstallTimer);
    g.__piContextimateInstallTimer = undefined;
  });

  pi.registerCommand("contextimate", {
    description: "Show or switch the startup [Context Estimator] view (summary, compact, expanded)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const requested = args.trim().toLowerCase() as ViewMode | "";
      const mode: ViewMode = requested === "summary" || requested === "compact" || requested === "expanded"
        ? requested
        : nextMode(g.__piContextimateMode ?? g.__piContextimateBlock?.getMode() ?? DEFAULT_MODE);
      setMode(mode);
      if (g.__piContextimateBlock) scheduleInstall(g.__piContextimateBlock);
      ctx.ui.notify(`[Context Estimator] view: ${mode}`, "info");
    },
  });
}
