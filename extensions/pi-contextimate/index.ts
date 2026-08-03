import type { Component } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionAPI, ExtensionContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject, positiveNumberValue, stringValue } from "../_lib/boundary.ts";
import { findContainerBy, isResourceRow, RESOURCE_HEADER_RE, type ContainerLike } from "../_lib/chat.ts";
import { configPaths, expandHomePath, readJsonConfig } from "../_lib/config.ts";
import { compactCount } from "../_lib/fmt.ts";
import {
  builtInHeuristicForModel,
  cleanDenominator,
  estimateCharsAsTokens,
  fallbackHeuristicNumbers,
  type ModelSummary,
} from "../_lib/heuristics.ts";
import {
  aggregateToolPayloadForShape,
  arrayItemsSchema,
  estimateOpenAIFunctionToolTokens,
  estimateOpenAIToolDefinitionTokens,
  getSchemaProperties,
  getSchemaRequired,
  OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR,
  openAIResponsesToolPayload,
  safeMinifiedJson,
  schemaArrayItemProperties,
  schemaPropertyDescription,
  schemaPropertyType,
  toolPayloadForShape,
  toolPayloadLabel,
} from "../_lib/tool-payloads.ts";
import { ELLIPSIS, GLYPH, SEP, ink, panelHeader } from "../_lib/style.ts";
import {
  buildSessionBreakdown,
  estimateSessionBreakdown,
  scanSession,
  type SessionBreakdown,
  type SessionEstimate,
  type SessionSource,
} from "./session-accounting.ts";

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
  detail: string;
  /** Tools only: formula-derived tokens replacing the ch ÷ denominator estimate. */
  effectiveTokens?: number;
  /** Tools only: minified-payload size, when content.length is not the counted chars. */
  rawChars?: number;
  denominator: number;
  compactRows?: ScanRow[];
  expanded: ExpandedContent;
};

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
  toolNumerator: string;
};

type ToolNumeratorResult = {
  label: string;
  content: string;
  chars: number;
  /** Present only for the openai-cookbook formula; ratio shapes divide chars instead. */
  tokens?: number;
};

type ToolDisplayEstimate = {
  tokens: number;
  chars: number;
};

type PrefixSnapshot = {
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

type ContextimateTui = {
  children?: unknown[];
  requestRender?: (force?: boolean) => void;
};

type ContextimateGlobal = typeof globalThis & {
  __piContextimateTui?: ContextimateTui;
  __piContextimateChat?: ContainerLike;
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
const DEFAULT_MODE: ViewMode = "summary";

// The family accent (design language §3): theme-derived, used sparingly — the panel
// brand, token figures, total rows, and the carried part of the context bar.
function accent(theme: Theme | undefined, text: string): string {
  return ink(theme, "accent", text);
}

type TokenLabelLayout = { unitWidth: number; fieldWidth: number };

function tokenIntegerWidth(tokens: number): number {
  return compactCount(tokens).split(".", 1)[0].length;
}

function estimatedTokenLabel(tokens: number, layout: TokenLabelLayout = tokenLabelLayout([tokens])): string {
  const leftPad = " ".repeat(Math.max(0, layout.unitWidth - tokenIntegerWidth(tokens)));
  return `${leftPad}~${compactCount(tokens)}`;
}

function estimatedTokenField(tokens: number, layout: TokenLabelLayout): string {
  return estimatedTokenLabel(tokens, layout).padEnd(layout.fieldWidth, " ");
}

function exactTokenLabel(tokens: number, layout: TokenLabelLayout = tokenLabelLayout([tokens])): string {
  const leftPad = " ".repeat(Math.max(0, layout.unitWidth - tokenIntegerWidth(tokens)) + 1);
  return `${leftPad}${compactCount(tokens)}`;
}

function tokenLabelLayout(tokens: number[]): TokenLabelLayout {
  const unitWidth = Math.max(0, ...tokens.map(tokenIntegerWidth));
  const rawLabels = tokens.map((token) => {
    const leftPad = " ".repeat(Math.max(0, unitWidth - tokenIntegerWidth(token)));
    return `${leftPad}~${compactCount(token)}`;
  });
  return { unitWidth, fieldWidth: Math.max(0, ...rawLabels.map((label) => label.length)) };
}

function formatPercent(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  return `${value.toFixed(1)}%`;
}

// Denominators are sanitized once, at heuristic resolution (applyHeuristicPatch); by
// the time one reaches a count it is a trusted positive number. The shared estimator
// slice (denominators, payload shapes, the OpenAI tool formula) lives in
// _lib/heuristics.ts so cachemire's model-switch forecast uses the same numbers.

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
  return `~${compactCount(estimateCharsAsTokens(chars, denominator))} tokens ${countDetail(chars, ratioDetail(denominator))}`;
}

function compactPath(filePath: string): string {
  const home = homedir();
  if (filePath === `${home}/.pi/agent/AGENTS.md`) return "Global AGENTS.md";
  if (filePath.startsWith(`${home}/`)) return `~/${filePath.slice(home.length + 1)}`;
  return filePath;
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
        note: `${tildeAll(filePath)} · preview only`,
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
  return `of which tool/extension instructions: ~${compactCount(tokens)} tokens (${parts.join(", ")}) · already counted in this row`;
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

// Provenance short form (design language §8): the local defining path *is* the
// audit trail, and the origin URL / package ref / `top-level` decorations duplicate
// it, so the label is `scope · path` (falling back to the loader source when no path
// exists) and builtins collapse to one word. Pi keeps the full SourceInfo.
function sourceInfoLabel(tool: ToolInfo): string {
  const sourceInfo = tool.sourceInfo;
  if (sourceInfo.source === "builtin") return "builtin";
  const where = sourceInfo.path ?? sourceInfo.source;
  return [sourceInfo.scope, where].filter(Boolean).join(SEP) || "unknown";
}

function summarizeTool(tool: ToolInfo): ToolSummary {
  return {
    name: tool.name,
    description: tool.description.trim() || "(no description)",
    source: sourceInfoLabel(tool),
    schema: tool.parameters,
    promptGuidelines: tool.promptGuidelines ?? [],
  };
}

// pi does not re-export pi-ai's Model type; ctx.model carries it.
type PiModel = NonNullable<ExtensionContext["model"]>;

function toModelSummary(model: PiModel | undefined): ModelSummary | undefined {
  return model ? { provider: model.provider, id: model.id, api: model.api } : undefined;
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

function parseHeuristicProfile(value: unknown): HeuristicProfile {
  if (!isJsonObject(value)) return {};
  const profile: HeuristicProfile = {};
  const label = stringValue(value.label);
  const textDenominator = positiveNumberValue(value.textDenominator);
  const sessionDenominator = positiveNumberValue(value.sessionDenominator);
  const toolDenominator = positiveNumberValue(value.toolDenominator);
  const toolNumerator = stringValue(value.toolNumerator);
  if (label) profile.label = label;
  if (textDenominator) profile.textDenominator = textDenominator;
  if (sessionDenominator) profile.sessionDenominator = sessionDenominator;
  if (toolDenominator) profile.toolDenominator = toolDenominator;
  if (toolNumerator) profile.toolNumerator = toolNumerator;
  return profile;
}

function parseHeuristicRule(value: unknown): HeuristicRule | undefined {
  if (!isJsonObject(value)) return undefined;
  const rule: HeuristicRule = parseHeuristicProfile(value);
  const profile = stringValue(value.profile);
  if (profile) rule.profile = profile;
  if (isJsonObject(value.match)) {
    const match: NonNullable<HeuristicRule["match"]> = {};
    const provider = stringValue(value.match.provider);
    const model = stringValue(value.match.model);
    const id = stringValue(value.match.id);
    const api = stringValue(value.match.api);
    if (provider) match.provider = provider;
    if (model) match.model = model;
    if (id) match.id = id;
    if (api) match.api = api;
    if (Object.keys(match).length > 0) rule.match = match;
  }
  return Object.keys(rule).length > 0 ? rule : undefined;
}

function parseContextimateConfig(value: unknown): ContextimateConfig {
  if (!isJsonObject(value)) return {};
  const config: ContextimateConfig = {};
  if (isJsonObject(value.defaults)) {
    const defaults: NonNullable<ContextimateConfig["defaults"]> = parseHeuristicProfile(value.defaults);
    const profile = stringValue(value.defaults.profile);
    if (profile) defaults.profile = profile;
    if (Object.keys(defaults).length > 0) config.defaults = defaults;
  }
  if (isJsonObject(value.profiles)) {
    const profiles: Record<string, HeuristicProfile> = {};
    for (const [name, entry] of Object.entries(value.profiles)) {
      const profile = parseHeuristicProfile(entry);
      if (Object.keys(profile).length > 0) profiles[name] = profile;
    }
    if (Object.keys(profiles).length > 0) config.profiles = profiles;
  }
  if (Array.isArray(value.rules)) {
    const rules = value.rules.map(parseHeuristicRule).filter((rule): rule is HeuristicRule => !!rule);
    if (rules.length > 0) config.rules = rules;
  }
  return config;
}

function splitConfigPaths(value: string | undefined): string[] {
  return (value ?? "").split(":").map((entry) => expandHomePath(entry.trim())).filter(Boolean);
}

function loadContextimateConfig(cwd: string): ContextimateConfig {
  const paths = [...configPaths("pi-contextimate", cwd), ...splitConfigPaths(process.env.PI_CONTEXTIMATE_CONFIG)];
  return paths.reduce<ContextimateConfig>(
    (config, filePath) => mergeContextimateConfig(config, readJsonConfig(filePath, parseContextimateConfig)),
    {},
  );
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
  return { ...fallbackHeuristicNumbers(), source: "fallback" };
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
    // otherwise reach renderHeader with label undefined and crash methodologyHint.
    label: normalized.label ?? base.label,
    source,
    textDenominator: cleanDenominator(normalized.textDenominator, base.textDenominator),
    sessionDenominator: cleanDenominator(normalized.sessionDenominator, base.sessionDenominator),
    toolDenominator: cleanDenominator(normalized.toolDenominator, base.toolDenominator),
    toolNumerator: normalized.toolNumerator ?? base.toolNumerator,
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
  };
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
    collectToolFields(name, property, 0, requiredKeys.has(name), fields);
  }
  return fields;
}

function buildToolDisplayEstimate(tool: ToolSummary, heuristic: ResolvedHeuristic): ToolDisplayEstimate {
  const shape = heuristic.toolNumerator;
  const chars = safeMinifiedJson(toolPayloadForShape(tool, shape)).length;
  if (shape === "openai-cookbook") {
    return { tokens: estimateOpenAIToolDefinitionTokens(tool), chars };
  }
  return { tokens: estimateCharsAsTokens(chars, heuristic.toolDenominator), chars };
}

function buildToolsSection(pi: ExtensionAPI, heuristic: ResolvedHeuristic): { section?: PrefixSection; tools: ToolSummary[] } {
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
    ? `· OpenAI formula · schema text ${ratioDetail(OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR)}`
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
        "formula  +7/fn +3/prop-section +3/prop -3/enum +3/enum-item +12 once · nested counted recursively",
        `counted on the minified provider payload (${compactCount(numerator.chars)} ch); tree below is the readable view of it`,
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

// Only for walking the foreign TUI component tree, whose objects we do not control.
// Snapshot building deliberately has no such guards: if pi's session callbacks throw
// (resume race), render()'s catch shows the honest "unavailable" line instead of a
// quietly zeroed panel.
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// May throw while pi is still wiring a resumed session; StartupContextComponent.render()
// catches, renders the "unavailable" line, and recovers on the next snapshot.
function buildSnapshot(
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
    session ? `${session.thinkingSummaryChars}:${session.reasoningTokens ?? "unreported"}:${session.toolOutputChars}:${session.messageChars}:${session.messageCount}:${session.contextUsageEstimated}` : "no-session",
    contextUsage ? `${contextUsage.tokens}:${contextUsage.contextWindow}:${contextUsage.percent}` : "no-usage",
    preSwitchUsage ? `pre-switch:${preSwitchUsage.billedModel}` : "currency-ok",
  ].join("|");

  return { signature, sections, tools, heuristic, model, session, contextUsage, preSwitchUsage };
}

function sectionTokens(section: PrefixSection): number {
  return section.effectiveTokens ?? estimateCharsAsTokens(section.content.length, section.denominator);
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

function padLabel(label: string, width = 42): string {
  // Overlong labels truncate rather than overflow: the token column is a column, and a
  // single 40-char title must not shift it (the … keeps the loss visible).
  const fitted = label.length >= width ? `${label.slice(0, Math.max(0, width - 2))}${ELLIPSIS}` : label;
  return fitted.padEnd(width, " ");
}

// Methodology is stated here, once, in the dim hint line (design language §5) — data
// rows carry only raw sizes. When the session or tool method deviates from the text
// ratio, say so here (tool tokens may come from the OpenAI formula or a different
// denominator); the expanded view stays the per-section audit trail.
function methodologyHint(heuristic: ResolvedHeuristic): string {
  const sessionPart = heuristic.sessionDenominator !== heuristic.textDenominator
    ? `${SEP}session ${ratioDetail(heuristic.sessionDenominator)}`
    : "";
  const toolsPart = heuristic.toolNumerator === "openai-cookbook"
    ? `${SEP}tools: OpenAI formula`
    : heuristic.toolDenominator !== heuristic.textDenominator
      ? `${SEP}tools ${ratioDetail(heuristic.toolDenominator)}`
      : "";
  return `counts ch ${ratioDetail(heuristic.textDenominator)}${sessionPart}${toolsPart} (${heuristic.label})`;
}

function renderHeader(snapshot: PrefixSnapshot, mode: ViewMode, theme: Theme): string[] {
  const ctrlO = keyText("app.tools.expand") || "Ctrl+O";
  return panelHeader(theme, "Contextimate", {
    modes: ["summary", "compact", "expanded"],
    active: mode,
    hint: `${ctrlO}: cycle view${SEP}model ${modelLabel(snapshot.model)}${SEP}${methodologyHint(snapshot.heuristic)}`,
  });
}

// One renderer for every label/tokens/detail row — section rows, session rows, and
// totals all flow through here, so alignment and grammar can never diverge.
type MetricRow = {
  label: string;
  tokens: number;
  /** pi-reported numbers render without the ~ estimate marker. */
  exact?: boolean;
  /** total rows: accent + bold. */
  emphasis?: boolean;
  /** dim suffix, parens included, e.g. "(1.2k ch)" or "(residual)". */
  detail?: string;
  /** summary section rows open with the family ▸ glyph (design language §1). */
  section?: boolean;
};

function renderMetricRow(row: MetricRow, theme: Theme, layout?: TokenLabelLayout): string {
  const tokenText = `${row.exact ? exactTokenLabel(row.tokens, layout) : estimatedTokenLabel(row.tokens, layout)} tokens`;
  if (row.emphasis) {
    return `  ${accent(theme, theme.bold(`${padLabel(row.label)}${tokenText}`))}${row.detail ? ` ${theme.fg("dim", row.detail)}` : ""}`;
  }
  const lead = row.section ? `${accent(theme, GLYPH.section)} ` : "";
  const labelWidth = row.section ? 40 : 42; // glyph + space keep the token column aligned
  return `  ${lead}${theme.fg("muted", padLabel(row.label, labelWidth))}${theme.fg("dim", `${tokenText}${row.detail ? ` ${row.detail}` : ""}`)}`;
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

function renderExpandedSectionHeader(section: PrefixSection, theme: Theme, width: number): string {
  const tokens = sectionTokens(section);
  const chars = sectionChars(section);
  const left = `  ${theme.bold(section.title)}  ${accent(theme, `${estimatedTokenLabel(tokens)} tokens`)}`;
  const right = theme.fg("dim", `${compactCount(chars)} ch ${section.detail}`);
  return joinLeftRight(left, right, Math.max(40, width));
}

function renderExpandedNote(note: string, theme: Theme): string {
  return `    ${theme.fg("dim", note)}`;
}

function renderExpandedPreview(lines: string[], theme: Theme, width: number): string[] {
  const max = Math.max(24, width - 4);
  return lines.map((line) => `    ${theme.fg("dim", singleLine(line, max))}`);
}

type FieldColumns = { nameCol: number; typeCol: number; hasRequired: boolean };

const fieldIndent = (depth: number) => 6 + depth * 2;

// Column layout across *all* fields in the tools block (design language §8): each
// tool used to size its own columns, so the section read as a stack of differently
// ragged mini-tables instead of one aligned table.
function toolFieldColumns(fields: ToolField[]): FieldColumns {
  return {
    nameCol: Math.min(30, Math.max(0, ...fields.map((field) => fieldIndent(field.depth) + field.name.length))),
    typeCol: Math.min(10, Math.max(0, ...fields.map((field) => field.type.length))),
    hasRequired: fields.some((field) => field.required),
  };
}

function renderToolFieldRows(fields: ToolField[], theme: Theme, width: number, columns?: FieldColumns): string[] {
  if (fields.length === 0) return [`      ${theme.fg("dim", "(no parameters)")}`];
  const { nameCol, typeCol, hasRequired } = columns ?? toolFieldColumns(fields);
  return fields.map((field) => {
    const rawName = `${" ".repeat(fieldIndent(field.depth))}${field.name}`;
    const namePart = rawName.length > nameCol ? `${rawName.slice(0, nameCol - 1)}…` : rawName.padEnd(nameCol, " ");
    const typePart = field.type.length > typeCol ? `${field.type.slice(0, typeCol - 1)}…` : field.type.padEnd(typeCol, " ");
    const reqPart = hasRequired ? (field.required ? "required" : "        ") : "";
    const prefixWidth = namePart.length + 2 + typePart.length + (hasRequired ? 2 + reqPart.length : 0);
    const descWidth = Math.max(16, width - prefixWidth - 3);
    const desc = field.description ? singleLine(field.description, descWidth) : "";
    return `${theme.fg("text", namePart)}  ${theme.fg("muted", typePart)}${hasRequired ? `  ${theme.fg("dim", reqPart)}` : ""}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

// Tool entry header (design language §8): the name is the L0 anchor — bold — with
// the shortened provenance beside it at L3-dim, so a column of tools scans by name
// while the audit trail stays present without competing. Tokens keep the accent,
// right-aligned. When width runs out the provenance gives way before the name does.
function renderExpandedToolHeader(tool: ToolExpanded, tokenLayout: TokenLabelLayout, theme: Theme, width: number): string {
  const maxWidth = Math.max(40, width);
  const indent = "    ";
  const gap = 2;
  const token = estimatedTokenField(tool.tokens, tokenLayout);
  const labelWidth = Math.max(12, maxWidth - indent.length - gap - tokenLayout.fieldWidth);
  const name = tool.name.length > labelWidth ? middleTruncatePath(tool.name, labelWidth) : tool.name;
  const sourceRoom = labelWidth - name.length - SEP.length;
  const source = tool.source && sourceRoom >= 8 ? middleTruncatePath(tildeAll(tool.source), sourceRoom) : "";
  const plainLabel = source ? `${name}${SEP}${source}` : name;
  const used = indent.length + plainLabel.length + tokenLayout.fieldWidth;
  const styled = `${theme.fg("text", theme.bold(name))}${source ? theme.fg("dim", `${SEP}${source}`) : ""}`;
  return `${indent}${styled}${" ".repeat(Math.max(gap, maxWidth - used))}${accent(theme, token)}`;
}

function renderExpandedToolsBlock(content: { notes: string[]; tools: ToolExpanded[] }, theme: Theme, width: number): string[] {
  const out: string[] = [];
  const tokenLayout = tokenLabelLayout(content.tools.map((tool) => tool.tokens));
  const allFields = content.tools.flatMap((tool) => tool.fields);
  const columns = allFields.length > 0 ? toolFieldColumns(allFields) : undefined;
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
    out.push(...renderToolFieldRows(tool.fields, theme, width, columns));
  }
  return out;
}

function buildSessionEstimate(snapshot: PrefixSnapshot): SessionEstimate | undefined {
  if (!snapshot.session) return undefined;
  const session = snapshot.preSwitchUsage
    ? { ...snapshot.session, reasoningTokens: undefined }
    : snapshot.session;
  return estimateSessionBreakdown(session, {
    denominator: snapshot.heuristic.sessionDenominator,
    harnessTokens: totalTokens(snapshot),
    contextTokens: snapshot.preSwitchUsage ? undefined : snapshot.contextUsage?.tokens,
  });
}

// --- proportion (design language §8): "of what" — shares of the context window --------

/**
 * Integer percent of the context window; `<1%` rather than a dishonest `0%`. Shares
 * derived from estimated token counts carry the ~ marker — a wrong harness estimate
 * must not masquerade as exact (only a fully provider-backed Total request drops ~).
 */
function ctxShareLabel(tokens: number, usage: ContextUsage | undefined, options: { estimate?: boolean } = {}): string | undefined {
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) return undefined;
  const percent = (tokens / usage.contextWindow) * 100;
  if (!Number.isFinite(percent) || percent < 0) return undefined;
  const rounded = Math.round(percent);
  if (rounded === 0 && tokens > 0) return "<1% ctx";
  return `${options.estimate ? "~" : ""}${rounded}% ctx`;
}

// The window is a budget label, not a measurement: 200k, not 200.0k.
function contextWindowLabel(tokens: number): string {
  return compactCount(tokens).replace(/\.0(k|M)$/, "$1");
}

function harnessDetail(snapshot: PrefixSnapshot): string {
  const share = ctxShareLabel(totalTokens(snapshot), snapshot.contextUsage, { estimate: true });
  return countDetail(totalChars(snapshot), share ? `· ${share}` : undefined);
}

// One stacked bar under Total request: the carried part (harness + session) in accent,
// free window dim — the half-second "how full am I?" answer.
function renderContextBar(snapshot: PrefixSnapshot, estimate: SessionEstimate, theme: Theme, width: number): string[] {
  const usage = snapshot.contextUsage;
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) return [];
  const free = Math.max(0, usage.contextWindow - usage.tokens);
  const legend =
    `harness ~${compactCount(totalTokens(snapshot))}${SEP}session ~${compactCount(estimate.totalTokens)}${SEP}free ${compactCount(free)}`;
  const room = Math.max(0, width - 4 - legend.length - 2);
  const sameLine = room >= 12;
  const barWidth = Math.min(28, Math.max(12, sameLine ? room : width - 4));
  const carried = Math.min(1, Math.max(0, usage.tokens / usage.contextWindow));
  const filled = Math.min(barWidth, Math.max(usage.tokens > 0 ? 1 : 0, Math.round(carried * barWidth)));
  const bar = `${accent(theme, "█".repeat(filled))}${theme.fg("dim", "▒".repeat(barWidth - filled))}`;
  return sameLine
    ? [`  ${bar}  ${theme.fg("dim", legend)}`]
    : [`  ${bar}`, `  ${theme.fg("dim", legend)}`];
}

function renderSessionRows(snapshot: PrefixSnapshot, theme: Theme, width: number, layout?: TokenLabelLayout): string[] {
  const estimate = buildSessionEstimate(snapshot);
  if (!snapshot.session || !estimate) return [];
  const sessionShare = ctxShareLabel(estimate.totalTokens, snapshot.contextUsage, { estimate: true });
  const provenance = estimate.totalSource === "pi" ? "Pi-based" : "heuristic fallback";
  const rows = [
    "",
    renderMetricRow({ label: "Tool outputs", tokens: estimate.toolOutputTokens, detail: countDetail(snapshot.session.toolOutputChars) }, theme, layout),
    renderMetricRow({ label: "Messages", tokens: estimate.messageTokens, detail: countDetail(snapshot.session.messageChars) }, theme, layout),
  ];
  if (estimate.thinkingSummaryTokens > 0) {
    rows.push(renderMetricRow({
      label: "Thinking summaries",
      tokens: estimate.thinkingSummaryTokens,
      detail: countDetail(snapshot.session.thinkingSummaryChars),
    }, theme, layout));
  }
  if (estimate.reasoningTokens !== undefined) {
    rows.push(renderMetricRow({
      label: "Reasoning context",
      tokens: estimate.reasoningTokens,
      exact: true,
      detail: "(provider)",
    }, theme, layout));
  }
  rows.push(
    renderMetricRow({ label: "Unattributed", tokens: estimate.unattributedTokens, detail: "(accounting gap)" }, theme, layout),
    renderMetricRow({
      label: "Total session",
      tokens: estimate.totalTokens,
      emphasis: true,
      detail: sessionShare ? `(${sessionShare} · ${provenance})` : `(${provenance})`,
    }, theme, layout),
  );
  const usage = snapshot.contextUsage;
  if (usage && usage.tokens !== null) {
    if (snapshot.preSwitchUsage) {
      // The provider-backed portion is in the old model's currency (issue #58).
      // Name it without dividing by the new window; preserve Pi's estimate marker
      // when trailing local messages have been added after that billed response.
      const usageEstimated = snapshot.session.contextUsageEstimated;
      rows.push(renderMetricRow({
        label: "Total request",
        tokens: usage.tokens,
        exact: !usageEstimated,
        emphasis: true,
        detail: usageEstimated
          ? `(pre-switch total \u00b7 ${snapshot.preSwitchUsage.billedModel} usage + Pi est.)`
          : `(pre-switch usage \u00b7 ${snapshot.preSwitchUsage.billedModel} tokens)`,
      }, theme, layout));
      return rows;
    }
    const percent = formatPercent(usage.percent);
    const window = usage.contextWindow > 0 ? contextWindowLabel(usage.contextWindow) : undefined;
    const usageEstimated = snapshot.session.contextUsageEstimated;
    rows.push(renderMetricRow({
      label: "Total request",
      tokens: usage.tokens,
      exact: !usageEstimated,
      emphasis: true,
      detail: percent && window
        ? usageEstimated ? `(${percent} · Pi est.)` : `(${percent} / ${window} ctx)`
        : usageEstimated ? "(Pi est.)" : "(Pi usage)",
    }, theme, layout));
    rows.push(...renderContextBar(snapshot, estimate, theme, width));
  }
  return rows;
}

function summaryTokenLayout(snapshot: PrefixSnapshot): TokenLabelLayout {
  const values = [...snapshot.sections.map(sectionTokens), totalTokens(snapshot)];
  const sessionEstimate = buildSessionEstimate(snapshot);
  if (sessionEstimate) values.push(
    sessionEstimate.totalTokens,
    sessionEstimate.toolOutputTokens,
    sessionEstimate.messageTokens,
    sessionEstimate.thinkingSummaryTokens,
    sessionEstimate.unattributedTokens,
  );
  if (sessionEstimate?.reasoningTokens !== undefined) values.push(sessionEstimate.reasoningTokens);
  if (typeof snapshot.contextUsage?.tokens === "number") values.push(snapshot.contextUsage.tokens);
  return tokenLabelLayout(values);
}

function renderSummary(snapshot: PrefixSnapshot, theme: Theme, width = 80): string[] {
  const lines = renderHeader(snapshot, "summary", theme);
  const layout = summaryTokenLayout(snapshot);
  lines.push("");
  for (const section of snapshot.sections) {
    lines.push(renderMetricRow({
      label: section.title,
      tokens: sectionTokens(section),
      detail: countDetail(sectionChars(section)),
      section: true,
    }, theme, layout));
  }
  lines.push(
    renderMetricRow({ label: "Total harness", tokens: totalTokens(snapshot), emphasis: true, detail: harnessDetail(snapshot) }, theme, layout),
    ...renderSessionRows(snapshot, theme, width, layout),
  );
  lines.push(""); // panel tail spacer (design language §8)
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
    return `    ${theme.fg("text", name)}  ${accent(theme, token)}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

function renderCompactTotalRow(snapshot: PrefixSnapshot, theme: Theme, layout: CompactLayout): string {
  const label = compactLabel("Total harness", layout.labelWidth + 2);
  const token = `${estimatedTokenLabel(totalTokens(snapshot), layout.tokenLayout)} tokens`;
  return `  ${accent(theme, theme.bold(`${label}  ${token}`))} ${theme.fg("dim", harnessDetail(snapshot))}`;
}

function renderCompact(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "compact", theme);
  const layout = compactLayout(snapshot);
  for (const section of snapshot.sections) {
    const title = compactLabel(section.title, layout.labelWidth);
    const counts = `${estimatedTokenLabel(sectionTokens(section), layout.tokenLayout)} tokens ${countDetail(sectionChars(section))}`;
    lines.push("", `  ${accent(theme, GLYPH.section)} ${theme.bold(title)}  ${theme.fg("dim", counts)}`);
    if (section.compactRows && section.compactRows.length > 0) {
      lines.push(...renderScanRows(section.compactRows, theme, width, layout));
    }
  }
  const sessionTokenLayout = summaryTokenLayout(snapshot);
  lines.push("", renderCompactTotalRow(snapshot, theme, layout), ...renderSessionRows(snapshot, theme, width, sessionTokenLayout));
  lines.push(""); // panel tail spacer (design language §8)
  return lines;
}

function renderExpanded(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "expanded", theme);
  const layout = summaryTokenLayout(snapshot);
  lines.push(
    renderMetricRow({ label: "Total harness", tokens: totalTokens(snapshot), emphasis: true, detail: harnessDetail(snapshot) }, theme, layout),
    ...renderSessionRows(snapshot, theme, width, layout),
  );

  for (const section of snapshot.sections) {
    lines.push("", renderExpandedSectionHeader(section, theme, width));
    const expanded = section.expanded;
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

  lines.push(""); // panel tail spacer (design language §8)
  return lines;
}

function wrapLines(lines: string[], width: number): string[] {
  const maxWidth = Math.max(24, width);
  const out: string[] = [];
  for (const rawLine of lines) {
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
        ? renderSummary(snapshot, theme, width)
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
        `${accent(undefined, "[Contextimate]")} unavailable while Pi finishes resuming this session`,
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

// _lib/chat.ts isResourceRow, minus the panel itself: the [Contextimate] block renders
// arbitrary text the fuzzy [Section] regex must never re-anchor on.
function isResourceComponent(component: unknown): boolean {
  return !isPrefixBlock(component) && isResourceRow(component);
}

function isBlankComponent(component: Component): boolean {
  const text = renderPlain(component, 80);
  return text.trim().length === 0;
}

function findResourceChatContainer(node: unknown): ContainerLike | undefined {
  return findContainerBy(node, (children) => children.some((child) => isResourceComponent(child)));
}

function removeExistingPrefixBlocks(chat: ContainerLike): void {
  if (!Array.isArray(chat.children)) return;
  chat.children = chat.children.filter((child) => !isPrefixBlock(child));
}

function insertionIndexAfterResourceList(chat: ContainerLike): number {
  if (!Array.isArray(chat.children)) return -1;
  let index = -1;
  for (let i = 0; i < chat.children.length; i++) {
    if (!isResourceComponent(chat.children[i])) continue;
    index = i;
    if (i + 1 < chat.children.length && isBlankComponent(chat.children[i + 1] as Component)) index = i + 1;
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

// Test-only surface. Named exports are runtime-inert under Pi's jiti loader; this object
// exists for the repo test suites (see docs/testing.md) and is not a stable public API.
export const internals = {
  // system-prompt parsing
  PROJECT_CONTEXT_RE,
  AVAILABLE_SKILLS_RE,
  RESOURCE_HEADER_RE,
  getPromptRemainder,
  parseSkills,
  parseContextSections,
  buildSkillsSection,
  // heuristic resolution
  parseContextimateConfig,
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
  tokenLabelLayout,
  estimatedTokenLabel,
  estimatedTokenField,
  exactTokenLabel,
  // proportion (design language §8)
  ctxShareLabel,
  contextWindowLabel,
  methodologyHint,
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
  // Branch checkout can change the model that billed the latest usage (issue #58).
  pi.on("session_tree", async () => markDirty());

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

    ctx.ui.setWidget("__pi_contextimate_capture", (tui: ContextimateTui) => {
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
    description: "Show or switch the startup [Contextimate] view (summary, compact, expanded)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const requested = args.trim().toLowerCase() as ViewMode | "";
      const mode: ViewMode = requested === "summary" || requested === "compact" || requested === "expanded"
        ? requested
        : nextMode(g.__piContextimateMode ?? g.__piContextimateBlock?.getMode() ?? DEFAULT_MODE);
      setMode(mode);
      if (g.__piContextimateBlock) scheduleInstall(g.__piContextimateBlock);
      ctx.ui.notify(`[Contextimate] view: ${mode}`, "info");
    },
  });
}
