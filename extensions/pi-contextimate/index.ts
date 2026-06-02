import type { Component } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionAPI, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, highlightCode, keyText } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ViewMode = "summary" | "compact" | "expanded";

type SkillSummary = {
  name: string;
  description: string;
  location: string;
};

type ToolSummary = {
  name: string;
  description: string;
  source: string;
  parameterKeys: string[];
  schema: unknown;
  promptGuidelines: string[];
};

type PrefixSection = {
  id: string;
  title: string;
  content: string;
  countLabel?: string;
  effectiveTokens?: number;
  rawChars?: number;
  denominator?: number;
  compactLines?: string[];
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
};

type ToolNumeratorSpec = string | ToolNumeratorTemplate;

type HeuristicRule = {
  label?: string;
  match?: {
    provider?: string;
    model?: string;
    id?: string;
    api?: string;
  };
  textDenominator?: number;
  sessionDenominator?: number;
  toolDenominator?: number;
  toolNumerator?: ToolNumeratorSpec;
  toolNumeratorShape?: ToolNumeratorSpec;
};

type ContextimateConfig = {
  defaults?: Partial<Pick<ResolvedHeuristic, "textDenominator" | "sessionDenominator" | "toolDenominator" | "toolNumerator">>;
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
  __piContextimateSuppressSetExpanded?: boolean;
  __piContextimateModel?: ModelSummary;
};

const g = globalThis as ContextimateGlobal;

const PROJECT_CONTEXT_RE = /\n?<project_context>\n\n[\s\S]*?\n<\/project_context>\n?/;
const PROJECT_INSTRUCTIONS_RE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const AVAILABLE_SKILLS_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>/;
const SKILL_RE = /<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
const RESOURCE_HEADER_RE = /^\s*\[(Context|Skills|Prompts|Extensions|Themes)\]/m;
const BUILTIN_CONTEXT_HEADER_RE = /^\s*\[Context\]/m;
const INSERT_AFTER_RESOURCE_RE = /^\s*\[(Skills|Prompts|Extensions|Themes)\]/m;
const DEFAULT_MODE: ViewMode = "summary";
const ORANGE = "\x1b[38;2;245;151;52m";
const RESET = "\x1b[0m";

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
  return { tokens: `~${tokenLabel} tokens`, chars: `(${charLabel} chars)` };
}

function formatCount(chars: number, denominator = 4): string {
  const parts = formatCountParts(chars, denominator);
  return `${parts.tokens} ${parts.chars}`;
}

function formatTokenEstimate(tokens: number, chars?: number, charLabel = "chars"): string {
  const suffix = typeof chars === "number" ? ` (${compactNumber(chars)} ${charLabel})` : "";
  return `~${compactTokenNumber(tokens)} tokens${suffix}`;
}

function estimateOpenAITextTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

function parseSkills(content: string): SkillSummary[] {
  return [...content.matchAll(SKILL_RE)].map((m) => ({
    name: unescapeXml((m[1] ?? "").trim()),
    description: unescapeXml((m[2] ?? "").trim()),
    location: unescapeXml((m[3] ?? "").trim()),
  }));
}

function parseContextSections(systemPrompt: string, denominator: number): PrefixSection[] {
  const sections: PrefixSection[] = [];
  for (const match of systemPrompt.matchAll(PROJECT_INSTRUCTIONS_RE)) {
    const [, rawPath, content] = match;
    const filePath = rawPath ?? "";
    const title = compactPath(filePath);
    const body = content ?? "";
    const preview = firstMeaningfulLines(body, 3).map((line) => `• ${singleLine(line)}`);
    sections.push({
      id: `context:${filePath}`,
      title,
      content: body,
      denominator,
      countLabel: formatCount(body.length, denominator),
      compactLines: preview.length > 0 ? preview : ["• (empty)"],
    });
  }
  return sections;
}

function buildSkillsSection(systemPrompt: string, denominator: number): { section?: PrefixSection; skills: SkillSummary[] } {
  const match = systemPrompt.match(AVAILABLE_SKILLS_RE);
  if (!match) return { skills: [] };
  const content = match[0].trim();
  const skills = parseSkills(content);
  return {
    skills,
    section: {
      id: "skills",
      title: `Skills (${skills.length})`,
      content,
      denominator,
      countLabel: formatCount(content.length, denominator),
      compactLines: skills.map(
        (skill) => `• ${skill.name} — ${singleLine(skill.description, 150)} (${compactPath(skill.location)})`,
      ),
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

function applyHeuristicPatch(base: ResolvedHeuristic, patch: Partial<ResolvedHeuristic>, source: string): ResolvedHeuristic {
  return {
    ...base,
    ...patch,
    source,
    textDenominator: cleanDenominator(patch.textDenominator, base.textDenominator),
    sessionDenominator: cleanDenominator(patch.sessionDenominator, base.sessionDenominator),
    toolDenominator: cleanDenominator(patch.toolDenominator, base.toolDenominator),
    toolNumerator: patch.toolNumerator ?? base.toolNumerator,
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
    heuristic = applyHeuristicPatch(heuristic, {
      label: rule.label ?? heuristic.label,
      textDenominator: rule.textDenominator,
      sessionDenominator: rule.sessionDenominator,
      toolDenominator: rule.toolDenominator,
      toolNumerator: rule.toolNumerator ?? rule.toolNumeratorShape,
    }, rule.label ?? "custom rule");
  }
  return heuristic;
}

function formatToolExpandedPlain(tool: ToolSummary): string {
  const lines = [`## ${tool.name}`, `Source: ${tool.source}`, "", "Description:", tool.description];
  if (tool.promptGuidelines.length > 0) {
    lines.push("", "Prompt guidelines:");
    for (const guideline of tool.promptGuidelines) lines.push(`- ${guideline}`);
  }
  lines.push("", "Parameters schema:", safeJson(tool.schema));
  return lines.join("\n");
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

function buildToolNumerator(tools: ToolSummary[], heuristic: ResolvedHeuristic, config: ContextimateConfig): ToolNumeratorResult {
  const spec = resolveToolShapeSpec(heuristic.toolNumerator, config);
  const denominator = typeof spec === "object" ? cleanDenominator(spec.denominator, heuristic.toolDenominator) : heuristic.toolDenominator;
  const shape = typeof spec === "string" ? spec : spec.shape;
  if (shape === "openai-cookbook") {
    const content = safeMinifiedJson(tools.map(openAIResponsesToolPayload));
    return {
      label: "OpenAI cookbook function heuristic",
      content,
      chars: content.length,
      tokens: estimateOpenAIFunctionToolTokens(tools),
    };
  }

  let payload: unknown;
  let label = typeof spec === "object" && spec.label ? spec.label : shape ?? "custom template";
  switch (shape) {
    case "openai-responses":
    case "openai-codex-responses":
      payload = tools.map(openAIResponsesToolPayload);
      label = "OpenAI Responses tool payload";
      break;
    case "openai-chat":
    case "openai-completions":
    case "mistral":
      payload = tools.map(openAIChatToolPayload);
      label = "OpenAI Chat tool payload";
      break;
    case "anthropic":
      payload = tools.map(anthropicToolPayload);
      label = "Anthropic tool payload";
      break;
    case "gemini":
    case "google":
    case "vertex":
      payload = geminiToolPayload(tools);
      label = "Gemini/Vertex tool payload";
      break;
    case "bedrock":
      payload = tools.map(bedrockToolPayload);
      label = "Bedrock tool payload";
      break;
    case "raw-schema":
      payload = tools.map(rawToolPayload);
      label = "Raw tool schema payload";
      break;
    default:
      if (typeof spec === "object" && spec.template !== undefined) {
        payload = tools.map((tool) => substituteToolTemplate(spec.template, tool));
      } else {
        payload = tools.map(openAIResponsesToolPayload);
        label = `Unknown tool shape ${String(shape)}; OpenAI Responses fallback`;
      }
  }

  if (typeof spec === "object" && spec.label) label = spec.label;
  const content = safeMinifiedJson(payload);
  return {
    label,
    content,
    chars: content.length,
    denominator,
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

function estimateOpenAIFunctionToolTokens(tools: ToolSummary[]): number {
  // OpenAI's cookbook does not count raw function-schema JSON. It uses a small
  // set of model-specific constants plus name/description/property summaries.
  // Use the gpt-4o/gpt-5-family constants, and approximate tokenizer counts for
  // text fragments with chars/4 so this remains dependency-free at startup.
  const funcInit = 7;
  const propInit = 3;
  const propKey = 3;
  const enumInit = -3;
  const enumItem = 3;
  const funcEnd = 12;

  let tokens = 0;
  for (const tool of tools) {
    tokens += funcInit;
    tokens += estimateOpenAITextTokens(`${tool.name}:${trimFinalPeriod(tool.description)}`);

    const properties = getSchemaProperties(tool.schema);
    const propertyEntries = Object.entries(properties);
    if (propertyEntries.length > 0) tokens += propInit;
    for (const [propertyName, property] of propertyEntries) {
      tokens += propKey;
      const enumValues = schemaPropertyEnum(property);
      if (enumValues.length > 0) {
        tokens += enumInit;
        for (const enumValue of enumValues) tokens += enumItem + estimateOpenAITextTokens(String(enumValue));
      }
      tokens += estimateOpenAITextTokens(`${propertyName}:${schemaPropertyType(property)}:${schemaPropertyDescription(property)}`);
    }
  }

  if (tools.length > 0) tokens += funcEnd;
  return tokens;
}

function formatToolExpandedLines(tool: ToolSummary): string[] {
  const lines = [`## ${tool.name}`, `Source: ${tool.source}`, "", "Description:", tool.description];
  if (tool.promptGuidelines.length > 0) {
    lines.push("", "Prompt guidelines:");
    for (const guideline of tool.promptGuidelines) lines.push(`- ${guideline}`);
  }
  lines.push("", "Parameters schema:", ...highlightCode(safeJson(tool.schema), "json"));
  return lines;
}

function buildToolsSection(pi: ExtensionAPI, heuristic: ResolvedHeuristic, config: ContextimateConfig): { section?: PrefixSection; tools: ToolSummary[]; loadedToolCount: number } {
  const activeNames = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools();
  const tools = allTools.filter((tool) => activeNames.has(tool.name)).map(summarizeTool);
  if (tools.length === 0) return { tools, loadedToolCount: allTools.length };

  const numerator = buildToolNumerator(tools, heuristic, config);
  const denominator = numerator.denominator ?? heuristic.toolDenominator;
  const effectiveTokens = numerator.tokens ?? estimateCharsAsTokens(numerator.chars, denominator);
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
      countLabel: `${formatTokenEstimate(effectiveTokens, numerator.chars)} · ${numerator.label}`,
      compactLines: tools.map((tool) => {
        const params = tool.parameterKeys.length > 0 ? ` params: ${tool.parameterKeys.join(", ")}` : " no params";
        return `• ${tool.name} — ${singleLine(tool.description, 150)} (${tool.source};${params})`;
      }),
      expandedLines: tools.flatMap((tool, index) => [
        ...(index === 0 ? [] : ["", "---", ""]),
        ...formatToolExpandedLines(tool),
      ]),
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

function buildSnapshot(
  pi: ExtensionAPI,
  getSystemPrompt: () => string,
  sessionManager?: unknown,
  getContextUsage?: () => ContextUsage | undefined,
  getModel?: () => unknown,
  config: ContextimateConfig = {},
): PrefixSnapshot {
  const systemPrompt = getSystemPrompt();
  const model = toModelSummary(getModel?.()) ?? g.__piContextimateModel;
  const heuristic = resolveHeuristic(model, config);
  const textDenominator = heuristic.textDenominator;
  const promptRemainder = getPromptRemainder(systemPrompt);
  const sections: PrefixSection[] = [
    {
      id: "system",
      title: "System prompt",
      content: promptRemainder,
      denominator: textDenominator,
      countLabel: formatCount(promptRemainder.length, textDenominator),
      compactLines: firstMeaningfulLines(promptRemainder, 5).map((line) => `• ${singleLine(line)}`),
    },
    ...parseContextSections(systemPrompt, textDenominator),
  ];

  const { section: skillsSection, skills } = buildSkillsSection(systemPrompt, textDenominator);
  if (skillsSection) sections.push(skillsSection);

  const { section: toolsSection, tools, loadedToolCount } = buildToolsSection(pi, heuristic, config);
  if (toolsSection) sections.push(toolsSection);

  const session = buildSessionBreakdown(sessionManager);
  const contextUsage = getContextUsage?.();
  const cfgSignature = configSignature(config);

  const signature = [
    systemPrompt.length,
    model ? `${model.provider}:${model.id}:${model.api}` : "no-model",
    `${heuristic.label}:${heuristic.textDenominator}:${heuristic.sessionDenominator}:${heuristic.toolDenominator}:${safeJson(heuristic.toolNumerator)}`,
    cfgSignature,
    pi.getActiveTools().join(","),
    pi.getAllTools().map((tool) => `${tool.name}:${tool.description?.length ?? 0}`).join(","),
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

function modeIndex(mode: ViewMode): number {
  return mode === "summary" ? 0 : mode === "compact" ? 1 : 2;
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

function toolNumeratorName(spec: ToolNumeratorSpec): string {
  if (typeof spec === "string") return spec;
  if (spec.label) return spec.label;
  if (spec.shape) return spec.shape;
  if (spec.template !== undefined) return "custom-template";
  return "custom";
}

function toolNumeratorUsesDenominator(spec: ToolNumeratorSpec): boolean {
  if (typeof spec === "string") return spec !== "openai-cookbook";
  if (spec.shape) return spec.shape !== "openai-cookbook";
  return true;
}

function heuristicAccountingDetail(heuristic: ResolvedHeuristic): string {
  const toolName = toolNumeratorName(heuristic.toolNumerator);
  const toolDetail = toolNumeratorUsesDenominator(heuristic.toolNumerator)
    ? `${toolName} ÷${formatDenominator(heuristic.toolDenominator)}`
    : `${toolName} formula`;
  return `accounting: text ÷${formatDenominator(heuristic.textDenominator)} · session ÷${formatDenominator(heuristic.sessionDenominator)} · tools ${toolDetail}`;
}

function renderHeader(snapshot: PrefixSnapshot, mode: ViewMode, theme: Theme): string[] {
  const ctrlO = keyText("app.tools.expand") || "Ctrl+O";
  return [
    "",
    `${orange(theme.bold("[Context summary]"))} ${theme.fg("dim", "assembled prefix ·")} ${renderModePips(mode, theme)}`,
    `  ${theme.fg("dim", `${ctrlO}: cycle view · model ${modelLabel(snapshot.model)} · estimates ${snapshot.heuristic.label}`)}`,
    `  ${theme.fg("dim", heuristicAccountingDetail(snapshot.heuristic))}`,
  ];
}

function renderTokenTotalRow(label: string, tokens: number, theme: Theme, details?: string): string {
  return `  ${orange(theme.bold(`${padLabel(label)}~${compactTokenNumber(tokens)} tokens`))}${details ? ` ${theme.fg("dim", details)}` : ""}`;
}

function renderEstimatedTokenRow(label: string, tokens: number, chars: number | undefined, theme: Theme, details?: string): string {
  const suffix = typeof chars === "number" ? ` (${compactNumber(chars)} chars)` : "";
  return `  ${theme.fg("muted", padLabel(label))}${theme.fg("dim", `~${compactTokenNumber(tokens)} tokens${suffix}${details ? ` · ${details}` : ""}`)}`;
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
    renderEstimatedTokenRow("Tool outputs", estimate.toolOutputTokens, snapshot.session.toolOutputChars, theme),
    renderEstimatedTokenRow("Messages", estimate.messageTokens, snapshot.session.messageChars, theme),
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

function renderCompact(snapshot: PrefixSnapshot, theme: Theme): string[] {
  const lines = renderHeader(snapshot, "compact", theme);
  for (const section of snapshot.sections) {
    lines.push("", `  ${orange("▸")} ${theme.bold(section.title)} ${theme.fg("dim", section.countLabel ?? formatCount(section.content.length, section.denominator ?? snapshot.heuristic.textDenominator))}`);
    for (const line of section.compactLines ?? firstMeaningfulLines(section.content, 4).map((entry) => `• ${singleLine(entry)}`)) {
      lines.push(`    ${theme.fg("dim", line)}`);
    }
  }
  lines.push("", renderTokenTotalRow("Total harness", totalTokens(snapshot), theme, `(${compactNumber(totalChars(snapshot))} chars)`), ...renderSessionRows(snapshot, theme));
  return lines;
}

function renderExpanded(snapshot: PrefixSnapshot, theme: Theme): string[] {
  const lines = renderHeader(snapshot, "expanded", theme);
  lines.push(`  ${theme.fg("dim", "Tool schemas below are provider tool definitions; JSON is pretty-printed/highlighted for transcript-style scanning; counts use provider/model-aware estimates.")}`);
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
    // that as a request to advance the three-state context-summary view.
    if (g.__piContextimateSuppressSetExpanded) return;
    this.cycleMode();
  }

  cycleMode(): ViewMode {
    this.setMode(nextMode(this.mode));
    return this.mode;
  }

  render(width: number): string[] {
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
        ? renderCompact(snapshot, theme)
        : renderExpanded(snapshot, theme);

    this.cachedSignature = snapshot.signature;
    this.cachedMode = this.mode;
    this.cachedWidth = width;
    this.cachedLines = wrapLines(body, Math.max(20, width));
    return this.cachedLines;
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

function hideBuiltInContextSection(chat: any): void {
  if (!Array.isArray(chat.children)) return;
  for (let i = 0; i < chat.children.length; i++) {
    const child = chat.children[i] as Component;
    if (isPrefixBlock(child)) continue;
    if (!BUILTIN_CONTEXT_HEADER_RE.test(renderPlain(child))) continue;
    chat.children.splice(i, 1);
    if (i < chat.children.length && isBlankComponent(chat.children[i] as Component)) {
      chat.children.splice(i, 1);
    }
    i--;
  }
}

function insertionIndexAfterResourceList(chat: any): number {
  if (!Array.isArray(chat.children)) return -1;
  let index = -1;
  for (let i = 0; i < chat.children.length; i++) {
    const child = chat.children[i] as Component;
    if (isPrefixBlock(child)) continue;
    if (INSERT_AFTER_RESOURCE_RE.test(renderPlain(child))) {
      index = i;
      if (i + 1 < chat.children.length && isBlankComponent(chat.children[i + 1] as Component)) index = i + 1;
    }
  }
  return index;
}

function installContextBlock(block: StartupContextComponent): boolean {
  const tui = g.__piContextimateTui;
  const chat = findResourceChatContainer(tui);
  if (!chat || !Array.isArray(chat.children)) return false;

  removeExistingPrefixBlocks(chat);
  hideBuiltInContextSection(chat);
  const insertAfter = insertionIndexAfterResourceList(chat);
  chat.children.splice(insertAfter + 1, 0, block);
  tui?.requestRender?.(true);
  return true;
}

function scheduleInstall(block: StartupContextComponent): void {
  if (g.__piContextimateInstallTimer) clearTimeout(g.__piContextimateInstallTimer);
  let attempts = 0;
  const attempt = () => {
    attempts++;
    if (installContextBlock(block)) return;
    if (attempts < 30) {
      g.__piContextimateInstallTimer = setTimeout(attempt, 50);
    }
  };
  g.__piContextimateInstallTimer = setTimeout(attempt, 0);
}

function syncBuiltInExpansionForMode(ctx: { ui: { setToolsExpanded(expanded: boolean): void } }, mode: ViewMode): void {
  // Keep Pi's own startup lists/tool rows compact until the full expanded mode,
  // without letting Pi's native setExpanded() callback advance this component a
  // second time.
  g.__piContextimateSuppressSetExpanded = true;
  try {
    ctx.ui.setToolsExpanded(mode === "expanded");
  } finally {
    g.__piContextimateSuppressSetExpanded = false;
  }
}

function setMode(mode: ViewMode, ctx?: { ui: { setToolsExpanded(expanded: boolean): void } }): void {
  g.__piContextimateMode = mode;
  g.__piContextimateBlock?.setMode(mode);
  if (ctx) syncBuiltInExpansionForMode(ctx, mode);
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
      setMode(next, ctx);
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
    description: "Show or switch the startup [Context summary] view (summary, compact, expanded)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const requested = args.trim().toLowerCase() as ViewMode | "";
      const mode: ViewMode = requested === "summary" || requested === "compact" || requested === "expanded"
        ? requested
        : nextMode(g.__piContextimateMode ?? g.__piContextimateBlock?.getMode() ?? DEFAULT_MODE);
      setMode(mode, ctx);
      if (g.__piContextimateBlock) scheduleInstall(g.__piContextimateBlock);
      ctx.ui.notify(`[Context summary] view: ${mode}`, "info");
    },
  });
}
