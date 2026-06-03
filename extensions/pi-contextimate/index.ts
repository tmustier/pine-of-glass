import type { Component } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionAPI, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, keyText } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ViewMode = "summary" | "compact" | "expanded";

type SkillSummary = {
  name: string;
  description: string;
  location: string;
  chars: number;
  tokens: number;
  countLabel: string;
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
  tokens: number;
  desc?: string;
};

type PrefixSection = {
  id: string;
  title: string;
  content: string;
  countLabel?: string;
  effectiveTokens?: number;
  rawChars?: number;
  denominator?: number;
  compactRows?: ScanRow[];
  expandedLines?: string[];
};

type ModelSummary = {
  provider: string;
  id: string;
  api: string;
};

type ToolNumeratorTemplate = {
  label?: string;
  shape?: string;
  template?: unknown;
  denominator?: number;
  url?: string;
  referenceUrl?: string;
};

type ToolNumeratorSpec = string | ToolNumeratorTemplate;

type HeuristicProfile = Partial<Pick<ResolvedHeuristic, "label" | "textDenominator" | "sessionDenominator" | "toolDenominator" | "toolNumerator">> & {
  toolNumeratorShape?: ToolNumeratorSpec;
};

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
  defaultTextDenominator?: number;
  defaultSessionDenominator?: number;
  defaultToolDenominator?: number;
  defaultToolNumerator?: ToolNumeratorSpec;
  rules?: HeuristicRule[];
  toolShapes?: Record<string, ToolNumeratorSpec>;
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
  referenceUrl?: string;
  detail?: string;
};

type ToolDisplayEstimate = {
  tokens: number;
  chars: number;
  detail: string;
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
  __piContextimateBlock?: StartupContextComponent;
  __piContextimateMode?: ViewMode;
  __piContextimateInstallTimer?: ReturnType<typeof setTimeout>;
  __piContextimateInputUnsubscribe?: () => void;
  __piContextimateModel?: ModelSummary;
};

const g = globalThis as ContextimateGlobal;

const PROJECT_CONTEXT_RE = /\n?<project_context>\n\n[\s\S]*?\n<\/project_context>\n?/;
const PROJECT_INSTRUCTIONS_RE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const AVAILABLE_SKILLS_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>/;
const SKILL_RE = /<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
const RESOURCE_HEADER_RE = /^\s*\[(Context|Skills|Prompts|Extensions|Themes)\]/m;
const CONTEXT_RESOURCE_HEADER_RE = /^\s*\[Context\](?:\s|$)/m;
const DEFAULT_MODE: ViewMode = "summary";
// Pi can deliver a single Ctrl+O press through both our raw terminal-input
// listener and its native expandable-row toggle. Coalesce cycles that land
// within this window so one press advances the view exactly once.
const CYCLE_DEDUPE_MS = 60;
const ORANGE = "\x1b[38;2;245;151;52m";
const RESET = "\x1b[0m";
const OPENAI_COOKBOOK_TOKEN_COUNTING_URL = "https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken";
const OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR = 6.6;

function localCalculationNoteUrl(): string {
  try {
    const docsPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/pi-contextimate.md");
    if (existsSync(docsPath)) return `${pathToFileURL(docsPath).href}#practical-openai-style-tool-heuristic`;
  } catch {
    // Fall back to the public formula lineage when running in an unusual loader.
  }
  return OPENAI_COOKBOOK_TOKEN_COUNTING_URL;
}

const OPENAI_TOOL_CALCULATION_REFERENCE_URL = localCalculationNoteUrl();

function orange(text: string): string {
  return `${ORANGE}${text}${RESET}`;
}

function compactNumber(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

function compactTokenNumber(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
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

function formatCountParts(chars: number, denominator = 4): { tokens: string; chars: string } {
  const charLabel = compactNumber(chars);
  const tokenLabel = compactTokenNumber(estimateCharsAsTokens(chars, denominator));
  return { tokens: `~${tokenLabel} tokens`, chars: `(${charLabel} chars/${formatDenominator(denominator)})` };
}

function formatCount(chars: number, denominator = 4): string {
  const parts = formatCountParts(chars, denominator);
  return `${parts.tokens} ${parts.chars}`;
}

function formatTokenEstimate(tokens: number, chars?: number, detail?: string): string {
  const suffix = typeof chars === "number"
    ? ` (${compactNumber(chars)} ${detail?.startsWith("chars/") ? detail : `chars${detail ? ` · ${detail}` : ""}`})`
    : "";
  return `~${compactTokenNumber(tokens)} tokens${suffix}`;
}

function formatDenominatorDetail(denominator: number): string {
  return `chars/${formatDenominator(denominator)}`;
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

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
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
    const tokens = estimateCharsAsTokens(chars, denominator);
    return {
      name: unescapeXml((m[1] ?? "").trim()),
      description: unescapeXml((m[2] ?? "").trim()),
      location: unescapeXml((m[3] ?? "").trim()),
      chars,
      tokens,
      countLabel: formatCount(chars, denominator),
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
    const expandedPreview = firstMeaningfulLines(body, 8).map((line) => `• ${singleLine(line, 150)}`);
    const expandedLines = [
      `• source: ${title}`,
      `• path: ${filePath}`,
      `• counted as text with ${formatDenominatorDetail(denominator)}; ${formatCount(body.length, denominator)}`,
      "• preview only; full file is not dumped here",
      "",
      ...(expandedPreview.length > 0 ? expandedPreview : ["• no non-empty lines"]),
    ];
    sections.push({
      id: `context:${filePath}`,
      title,
      content: body,
      denominator,
      countLabel: formatCount(body.length, denominator),
      expandedLines,
    });
  }
  return sections;
}

function buildSkillsSection(systemPrompt: string, denominator: number): { section?: PrefixSection; skills: SkillSummary[] } {
  const match = systemPrompt.match(AVAILABLE_SKILLS_RE);
  if (!match) return { skills: [] };
  const content = match[0].trim();
  const skills = parseSkills(content, denominator);
  const skillLines = [...skills]
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
    .map((skill) => `• ${skill.name} ${skill.countLabel} — ${singleLine(skill.description, 110)} (${compactPath(skill.location)})`);
  const wrapperChars = Math.max(0, content.length - skills.reduce((sum, skill) => sum + skill.chars, 0));
  const expandedLines = [
    `• counted as text with ${formatDenominatorDetail(denominator)}`,
    "• per-skill rows are sorted by estimated size; wrapper/markup is shown separately so subtotals are explainable",
    ...(wrapperChars > 0 ? [`• skills-list wrapper/markup: ${formatCount(wrapperChars, denominator)}`] : []),
    "",
    ...skillLines,
  ];
  return {
    skills,
    section: {
      id: "skills",
      title: `Skills (${skills.length})`,
      content,
      denominator,
      countLabel: formatCount(content.length, denominator),
      compactRows: [...skills]
        .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
        .map((skill) => ({ name: skill.name, tokens: skill.tokens, desc: skill.description })),
      expandedLines,
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

function expandHomePath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function readJsonConfig(filePath: string): ContextimateConfig | undefined {
  try {
    const expanded = expandHomePath(filePath);
    if (!existsSync(expanded)) return undefined;
    const parsed = JSON.parse(readFileSync(expanded, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as ContextimateConfig : undefined;
  } catch {
    return undefined;
  }
}

function mergeContextimateConfig(base: ContextimateConfig, next?: ContextimateConfig): ContextimateConfig {
  if (!next) return base;
  return {
    ...base,
    ...next,
    defaults: { ...(base.defaults ?? {}), ...(next.defaults ?? {}) },
    profiles: { ...(base.profiles ?? {}), ...(next.profiles ?? {}) },
    toolShapes: { ...(base.toolShapes ?? {}), ...(next.toolShapes ?? {}) },
    rules: [...(base.rules ?? []), ...(Array.isArray(next.rules) ? next.rules : [])],
  };
}

function splitConfigPaths(value: string | undefined): string[] {
  return (value ?? "").split(":").map((entry) => entry.trim()).filter(Boolean);
}

function loadContextimateConfig(cwd: string): ContextimateConfig {
  const configPaths = [
    join(homedir(), ".pi", "agent", "pi-contextimate.json"),
    join(cwd, ".pi", "pi-contextimate.json"),
    // Legacy names from the original prefix-inspector predecessor.
    join(homedir(), ".pi", "agent", "prefix-inspector.json"),
    join(cwd, ".pi", "prefix-inspector.json"),
    ...splitConfigPaths(process.env.PI_CONTEXTIMATE_CONFIG),
    ...splitConfigPaths(process.env.PI_PREFIX_INSPECTOR_CONFIG),
  ];
  return configPaths.reduce<ContextimateConfig>((config, filePath) => mergeContextimateConfig(config, readJsonConfig(filePath)), {});
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

function normalizeHeuristicPatch(patch: HeuristicProfile | Partial<ResolvedHeuristic> | undefined): Partial<ResolvedHeuristic> {
  if (!patch) return {};
  return {
    label: patch.label,
    textDenominator: patch.textDenominator,
    sessionDenominator: patch.sessionDenominator,
    toolDenominator: patch.toolDenominator,
    toolNumerator: patch.toolNumerator ?? (patch as HeuristicProfile).toolNumeratorShape,
  };
}

function applyHeuristicPatch(base: ResolvedHeuristic, patch: HeuristicProfile | Partial<ResolvedHeuristic> | undefined, source: string): ResolvedHeuristic {
  const normalized = normalizeHeuristicPatch(patch);
  return {
    ...base,
    ...normalized,
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

function resolveHeuristic(model: ModelSummary | undefined, config: ContextimateConfig): ResolvedHeuristic {
  let heuristic = defaultHeuristic();
  const defaults = config.defaults ?? {};
  if (defaults.profile && config.profiles?.[defaults.profile]) {
    heuristic = applyHeuristicPatch(heuristic, config.profiles[defaults.profile], `profile:${defaults.profile}`);
  }
  heuristic = applyHeuristicPatch(heuristic, {
    textDenominator: config.defaultTextDenominator ?? defaults.textDenominator,
    sessionDenominator: config.defaultSessionDenominator ?? defaults.sessionDenominator,
    toolDenominator: config.defaultToolDenominator ?? defaults.toolDenominator,
    toolNumerator: config.defaultToolNumerator ?? defaults.toolNumerator,
  }, "configured fallback");
  const builtIn = builtInHeuristicForModel(model);
  if (builtIn) heuristic = applyHeuristicPatch(heuristic, builtIn, builtIn.label ?? "provider-aware heuristic");
  for (const rule of config.rules ?? []) {
    if (!ruleMatchesModel(rule, model)) continue;
    if (rule.profile && config.profiles?.[rule.profile]) {
      heuristic = applyHeuristicPatch(heuristic, config.profiles[rule.profile], `profile:${rule.profile}`);
    }
    heuristic = applyHeuristicPatch(heuristic, {
      label: rule.label ?? heuristic.label,
      textDenominator: rule.textDenominator,
      sessionDenominator: rule.sessionDenominator,
      toolDenominator: rule.toolDenominator,
      toolNumerator: rule.toolNumerator ?? rule.toolNumeratorShape,
    }, rule.label ?? (rule.profile ? `rule:${rule.profile}` : "custom rule"));
  }
  return heuristic;
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

function substituteToolTemplate(value: unknown, tool: ToolSummary): unknown {
  const placeholders: Record<string, unknown> = {
    "$name": tool.name,
    "$description": tool.description,
    "$schema": tool.schema,
    "$parameters": tool.schema,
    "$source": tool.source,
    "$parameterKeys": tool.parameterKeys,
    "$promptGuidelines": tool.promptGuidelines,
    "$strict": null,
  };
  if (typeof value === "string") {
    if (value in placeholders) return placeholders[value];
    return value
      .replace(/\{\{name\}\}/g, tool.name)
      .replace(/\{\{description\}\}/g, tool.description)
      .replace(/\{\{source\}\}/g, tool.source);
  }
  if (Array.isArray(value)) return value.map((entry) => substituteToolTemplate(entry, tool));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substituteToolTemplate(entry, tool)]));
}

function resolveToolShapeSpec(spec: ToolNumeratorSpec, config: ContextimateConfig, seen = new Set<string>()): ToolNumeratorSpec {
  if (typeof spec !== "string") return spec;
  const custom = config.toolShapes?.[spec];
  if (!custom || seen.has(spec)) return spec;
  seen.add(spec);
  return resolveToolShapeSpec(custom, config, seen);
}

function referenceUrlForToolSpec(spec: ToolNumeratorSpec, shape?: string): string | undefined {
  // Retain reference metadata for config compatibility and future renderers even
  // though the default TUI avoids OSC-8 links because several Pi paths strip them.
  if (typeof spec === "object") {
    if (spec.referenceUrl) return spec.referenceUrl;
    if (spec.url) return spec.url;
  }
  return shape === "openai-cookbook" ? OPENAI_TOOL_CALCULATION_REFERENCE_URL : undefined;
}

function toolPayloadForShape(tool: ToolSummary, shape: string | undefined, spec: ToolNumeratorSpec): unknown {
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
      if (typeof spec === "object" && spec.template !== undefined) return substituteToolTemplate(spec.template, tool);
      return openAIResponsesToolPayload(tool);
  }
}

function aggregateToolPayloadForShape(tools: ToolSummary[], shape: string | undefined, spec: ToolNumeratorSpec): unknown {
  if (shape === "gemini" || shape === "google" || shape === "vertex") return geminiToolPayload(tools);
  return tools.map((tool) => toolPayloadForShape(tool, shape, spec));
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

function buildToolNumerator(tools: ToolSummary[], heuristic: ResolvedHeuristic, config: ContextimateConfig): ToolNumeratorResult {
  const spec = resolveToolShapeSpec(heuristic.toolNumerator, config);
  const denominator = typeof spec === "object" ? cleanDenominator(spec.denominator, heuristic.toolDenominator) : heuristic.toolDenominator;
  const shape = typeof spec === "string" ? spec : spec.shape;
  if (shape === "openai-cookbook") {
    const content = safeMinifiedJson(tools.map(openAIResponsesToolPayload));
    return {
      label: typeof spec === "object" && spec.label ? spec.label : "OpenAI-style local formula",
      content,
      chars: content.length,
      tokens: estimateOpenAIFunctionToolTokens(tools),
      detail: `schema text/${formatDenominator(OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR)}`,
      referenceUrl: referenceUrlForToolSpec(spec, shape),
    };
  }

  let label = typeof spec === "object" && spec.label ? spec.label : toolPayloadLabel(shape);
  const payload = aggregateToolPayloadForShape(tools, shape, spec);
  if (typeof spec === "object" && spec.label) label = spec.label;
  const content = safeMinifiedJson(payload);
  return {
    label,
    content,
    chars: content.length,
    denominator,
    referenceUrl: referenceUrlForToolSpec(spec, shape),
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

function buildToolDisplayEstimate(tool: ToolSummary, heuristic: ResolvedHeuristic, config: ContextimateConfig): ToolDisplayEstimate {
  const spec = resolveToolShapeSpec(heuristic.toolNumerator, config);
  const denominator = typeof spec === "object" ? cleanDenominator(spec.denominator, heuristic.toolDenominator) : heuristic.toolDenominator;
  const shape = typeof spec === "string" ? spec : spec.shape;
  const payload = toolPayloadForShape(tool, shape, spec);
  const chars = safeMinifiedJson(payload).length;
  if (shape === "openai-cookbook") {
    return {
      tokens: estimateOpenAIToolDefinitionTokens(tool),
      chars,
      detail: `OpenAI formula; text/${formatDenominator(OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR)}`,
    };
  }
  return {
    tokens: estimateCharsAsTokens(chars, denominator),
    chars,
    detail: `${formatDenominatorDetail(denominator)} · ${typeof spec === "object" && spec.label ? spec.label : toolPayloadLabel(shape)}`,
  };
}

function toolCountMethodLines(numerator: ToolNumeratorResult, denominator: number): string[] {
  if (typeof numerator.tokens === "number") {
    return [
      `• count method: ${numerator.label}; ${compactNumber(numerator.chars)} chars is payload size only, not a divisor; schema text fragments use chars/${formatDenominator(OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR)}`,
      `• formula: +7/function +3/property-section +3/property -3/enum +3/enum-item +12/final; nested object properties counted recursively`,
      "• backup: docs/pi-contextimate.md#practical-openai-style-tool-heuristic",
    ];
  }
  return [
    `• count method: ${numerator.label}; numerator is ${compactNumber(numerator.chars)} chars/${formatDenominator(denominator)}`,
  ];
}

function buildToolsSection(pi: ExtensionAPI, heuristic: ResolvedHeuristic, config: ContextimateConfig): { section?: PrefixSection; tools: ToolSummary[]; loadedToolCount: number } {
  const activeNames = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools();
  const tools = allTools.filter((tool) => activeNames.has(tool.name)).map(summarizeTool);
  if (tools.length === 0) return { tools, loadedToolCount: allTools.length };

  const numerator = buildToolNumerator(tools, heuristic, config);
  const denominator = numerator.denominator ?? heuristic.toolDenominator;
  const effectiveTokens = numerator.tokens ?? estimateCharsAsTokens(numerator.chars, denominator);
  const numeratorLabel = numerator.label;
  const numeratorDetail = typeof numerator.tokens === "number"
    ? `payload size; ${numeratorLabel}; ${numerator.detail ?? `text/${formatDenominator(OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR)}`}`
    : `${formatDenominatorDetail(denominator)} · ${numeratorLabel}`;
  const methodLines = toolCountMethodLines(numerator, denominator);
  const toolSpec = resolveToolShapeSpec(heuristic.toolNumerator, config);
  const toolShape = typeof toolSpec === "string" ? toolSpec : toolSpec.shape;
  const toolEstimates = tools.map((tool) => ({ tool, estimate: buildToolDisplayEstimate(tool, heuristic, config) }));
  const compactToolRows = [...toolEstimates]
    .sort((a, b) => b.estimate.tokens - a.estimate.tokens || a.tool.name.localeCompare(b.tool.name))
    .map(({ tool, estimate }) => ({ name: tool.name, tokens: estimate.tokens, desc: tool.description }));
  const expandedToolLines = [...toolEstimates]
    .sort((a, b) => b.estimate.tokens - a.estimate.tokens || a.tool.name.localeCompare(b.tool.name))
    .flatMap(({ tool, estimate }, index) => [
      ...(index === 0 ? [] : [""]),
      `${tool.name} — ${formatTokenEstimate(estimate.tokens, estimate.chars, estimate.detail)} · source: ${tool.source}`,
      ...safeJson(toolPayloadForShape(tool, toolShape, toolSpec)).split("\n"),
    ]);
  return {
    tools,
    loadedToolCount: allTools.length,
    section: {
      id: "tools",
      title: `Tools (${tools.length} active / ${allTools.length} loaded)`,
      content: numerator.content,
      effectiveTokens,
      rawChars: numerator.chars,
      denominator,
      countLabel: formatTokenEstimate(effectiveTokens, numerator.chars, numeratorDetail),
      compactRows: compactToolRows,
      expandedLines: [
        ...methodLines,
        ...(typeof numerator.tokens === "number" ? ["• per-tool rows exclude the shared +12 final tools overhead shown here", "• shared formula overhead: +12 tokens once for the whole active tool set"] : ["• per-tool rows are approximate; array/bracket/comma payload overhead is included only in the total"]),
        "",
        `Tool definitions (formatted JSON — the provider-shaped payload counted above, sorted by estimated tokens):`,
        "",
        ...expandedToolLines,
      ],
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
  const systemPreview = firstMeaningfulLines(promptRemainder, 5).map((line) => `• ${singleLine(line)}`);
  const sections: PrefixSection[] = [
    {
      id: "system",
      title: "System prompt",
      content: promptRemainder,
      denominator: textDenominator,
      countLabel: formatCount(promptRemainder.length, textDenominator),
      expandedLines: [
        `• counted as text with ${formatDenominatorDetail(textDenominator)}`,
        `• raw standalone chars: ${compactNumber(promptRemainder.length)}`,
        ...(systemPreview.length > 0 ? ["", ...systemPreview] : []),
      ],
    },
    ...parseContextSections(systemPrompt, textDenominator),
  ];

  const { section: skillsSection, skills } = buildSkillsSection(systemPrompt, textDenominator);
  if (skillsSection) sections.push(skillsSection);

  let tools: ToolSummary[] = [];
  let loadedToolCount = 0;
  const toolsResult = safely(() => buildToolsSection(pi, heuristic, config), undefined as ReturnType<typeof buildToolsSection> | undefined);
  if (toolsResult) {
    tools = toolsResult.tools;
    loadedToolCount = toolsResult.loadedToolCount;
    if (toolsResult.section) sections.push(toolsResult.section);
  }

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

function renderTokenTotalRow(label: string, tokens: number, theme: Theme, details?: string): string {
  return `  ${orange(theme.bold(`${padLabel(label)}~${compactTokenNumber(tokens)} tokens`))}${details ? ` ${theme.fg("dim", details)}` : ""}`;
}

function renderEstimatedTokenRow(label: string, tokens: number, chars: number | undefined, theme: Theme, details?: string): string {
  const suffix = typeof chars === "number"
    ? details?.startsWith("chars/")
      ? ` (${compactNumber(chars)} ${details})`
      : ` (${compactNumber(chars)} chars${details ? ` · ${details}` : ""})`
    : details ? ` (${details})` : "";
  return `  ${theme.fg("muted", padLabel(label))}${theme.fg("dim", `~${compactTokenNumber(tokens)} tokens${suffix}`)}`;
}

function renderContextUsageTotalRow(label: string, usage: ContextUsage, theme: Theme): string | undefined {
  if (usage.tokens === null) return undefined;
  const percent = formatPercent(usage.percent);
  const window = usage.contextWindow > 0 ? compactTokenNumber(usage.contextWindow) : undefined;
  const details = percent && window
    ? `(${percent} / ${window} ctx)`
    : "(Pi usage)";
  return `  ${orange(theme.bold(`${padLabel(label)}${compactTokenNumber(usage.tokens)} tokens`))} ${theme.fg("dim", details)}`;
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

function renderSessionRows(snapshot: PrefixSnapshot, theme: Theme): string[] {
  const estimate = buildSessionEstimate(snapshot);
  if (!snapshot.session || !estimate) return [];
  const source = estimate.totalSource === "pi" ? "(Pi current - harness)" : "(heuristic fallback)";
  const rows = [
    "",
    renderTokenTotalRow("Total session", estimate.totalTokens, theme, source),
    `    ${theme.fg("dim", `of which approx. visible buckets use chars/${formatDenominator(estimate.denominator)}; other/reasoning is residual`)}`,
    renderEstimatedTokenRow("Tool outputs", estimate.toolOutputTokens, snapshot.session.toolOutputChars, theme, formatDenominatorDetail(estimate.denominator)),
    renderEstimatedTokenRow("Messages", estimate.messageTokens, snapshot.session.messageChars, theme, formatDenominatorDetail(estimate.denominator)),
    renderEstimatedTokenRow("Other / reasoning", estimate.otherTokens, undefined, theme, "residual"),
  ];
  const requestTotal = snapshot.contextUsage
    ? renderContextUsageTotalRow("Total request", snapshot.contextUsage, theme)
    : undefined;
  if (requestTotal) rows.push(requestTotal);
  return rows;
}

function renderSummary(snapshot: PrefixSnapshot, theme: Theme): string[] {
  const lines = renderHeader(snapshot, "summary", theme);
  lines.push("");
  for (const section of snapshot.sections) {
    lines.push(`  ${theme.fg("muted", padLabel(section.title))}${theme.fg("dim", section.countLabel ?? formatCount(section.content.length, section.denominator ?? snapshot.heuristic.textDenominator))}`);
  }
  lines.push(renderTokenTotalRow("Total harness", totalTokens(snapshot), theme, `(${compactNumber(totalChars(snapshot))} chars)`), ...renderSessionRows(snapshot, theme));
  return lines;
}

function renderScanRows(rows: ScanRow[], theme: Theme, width: number): string[] {
  const nameWidth = Math.min(26, Math.max(...rows.map((row) => row.name.length)));
  const tokenStrings = rows.map((row) => `~${compactTokenNumber(row.tokens)}`);
  const tokenWidth = Math.max(...tokenStrings.map((token) => token.length));
  const descWidth = Math.max(24, width - (4 + nameWidth + 2 + tokenWidth + 2));
  return rows.map((row, index) => {
    const name = row.name.length > nameWidth
      ? `${row.name.slice(0, nameWidth - 1)}…`
      : row.name.padEnd(nameWidth, " ");
    const token = tokenStrings[index].padStart(tokenWidth, " ");
    const desc = row.desc ? singleLine(row.desc, descWidth) : "";
    return `    ${theme.fg("text", name)}  ${orange(token)}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

function renderCompact(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "compact", theme);
  lines.push(`  ${theme.fg("dim", "Scan view: one line per skill/tool, sorted by estimated tokens · Ctrl+O for full detail")}`);
  for (const section of snapshot.sections) {
    const countLabel = section.countLabel ?? formatCount(section.content.length, section.denominator ?? snapshot.heuristic.textDenominator);
    lines.push("", `  ${orange("▸")} ${theme.bold(section.title)}  ${theme.fg("dim", countLabel)}`);
    if (section.compactRows && section.compactRows.length > 0) {
      lines.push(...renderScanRows(section.compactRows, theme, width));
    }
  }
  lines.push("", renderTokenTotalRow("Total harness", totalTokens(snapshot), theme, `(${compactNumber(totalChars(snapshot))} chars)`), ...renderSessionRows(snapshot, theme));
  return lines;
}

function renderExpanded(snapshot: PrefixSnapshot, theme: Theme): string[] {
  const lines = renderHeader(snapshot, "expanded", theme);
  lines.push(`  ${theme.fg("dim", "Expanded view: per-section subtotals, sources, per-skill/per-tool estimates, and the formatted JSON tool definitions that are counted.")}`);
  lines.push(renderTokenTotalRow("Total harness", totalTokens(snapshot), theme, `(${compactNumber(totalChars(snapshot))} chars)`), ...renderSessionRows(snapshot, theme));

  for (const section of snapshot.sections) {
    lines.push("", `${orange(`[${section.title} - ${section.countLabel ?? formatCount(section.content.length, section.denominator ?? snapshot.heuristic.textDenominator)}]`)}`, "");
    if (section.expandedLines) {
      lines.push(...section.expandedLines);
    } else {
      lines.push(section.content || "(empty)");
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
  private lastCycleAt = 0;

  constructor(
    private readonly snapshot: () => PrefixSnapshot,
    private readonly getTheme: () => Theme,
    private mode: ViewMode,
  ) {}

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
    // Fallback path for Pi's native Ctrl+O handler: if our raw terminal-input
    // listener does not see the key first, Pi toggles all expandable rows. Treat
    // that as a request to advance the three-state Context Estimator view.
    this.cycleMode();
  }

  cycleMode(): ViewMode {
    const now = Date.now();
    if (now - this.lastCycleAt < CYCLE_DEDUPE_MS) return this.mode;
    this.lastCycleAt = now;
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
          : renderExpanded(snapshot, theme);

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

function indexAfterRowAndFollowingBlank(chat: any, index: number): number {
  if (!Array.isArray(chat.children)) return index;
  return index + 1 < chat.children.length && isBlankComponent(chat.children[index + 1] as Component) ? index + 1 : index;
}

function insertionIndexAfterContextResource(chat: any): number {
  if (!Array.isArray(chat.children)) return -1;
  let firstResourceIndex = -1;
  for (let i = 0; i < chat.children.length; i++) {
    const child = chat.children[i] as Component;
    if (isPrefixBlock(child)) continue;
    const text = renderPlain(child);
    if (firstResourceIndex === -1 && RESOURCE_HEADER_RE.test(text)) firstResourceIndex = i;
    if (CONTEXT_RESOURCE_HEADER_RE.test(text)) return indexAfterRowAndFollowingBlank(chat, i);
  }
  return firstResourceIndex === -1 ? -1 : indexAfterRowAndFollowingBlank(chat, firstResourceIndex);
}

function installContextBlock(block: StartupContextComponent): boolean {
  const tui = g.__piContextimateTui;
  const chat = findResourceChatContainer(tui);
  if (!chat || !Array.isArray(chat.children)) return false;

  removeExistingPrefixBlocks(chat);
  const insertAfter = insertionIndexAfterContextResource(chat);
  chat.children.splice(insertAfter + 1, 0, block);
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

export default function piContextimate(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Restore Pi's normal header; this extension now renders below Pi's loaded-resource list.
    ctx.ui.setHeader(undefined);

    const currentMode = g.__piContextimateMode ?? DEFAULT_MODE;
    const config = loadContextimateConfig(ctx.cwd);
    g.__piContextimateModel = toModelSummary(ctx.model);
    const block = new StartupContextComponent(
      () => buildSnapshot(
        pi,
        () => ctx.getSystemPrompt(),
        ctx.sessionManager,
        () => ctx.getContextUsage(),
        () => g.__piContextimateModel ?? toModelSummary(ctx.model),
        config,
      ),
      () => ctx.ui.theme,
      currentMode,
    );
    g.__piContextimateBlock = block;

    ctx.ui.setWidget("__pi_contextimate_capture", (tui: any) => {
      g.__piContextimateTui = tui;
      return { render: () => [] as string[], invalidate: () => {} };
    });
    ctx.ui.setWidget("__pi_contextimate_capture", undefined);

    scheduleInstall(block);

    g.__piContextimateInputUnsubscribe?.();
    g.__piContextimateInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "ctrl+o")) return undefined;
      const next = g.__piContextimateBlock?.cycleMode() ?? nextMode(g.__piContextimateMode ?? DEFAULT_MODE);
      setMode(next);
      return { consume: true };
    });
  });

  pi.on("model_select", async (event, ctx) => {
    g.__piContextimateModel = toModelSummary(event.model);
    g.__piContextimateBlock?.invalidate();
    if (ctx.hasUI) g.__piContextimateTui?.requestRender?.(true);
  });

  pi.on("session_shutdown", async () => {
    g.__piContextimateInputUnsubscribe?.();
    g.__piContextimateInputUnsubscribe = undefined;
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
