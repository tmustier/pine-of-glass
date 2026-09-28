// How Contextimate turns characters into tokens: built-in per-model heuristics, adjusted by
// the user's pi-contextimate config.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, positiveNumberValue, stringValue } from "../_lib/boundary.ts";
import { configPaths, expandHomePath, readJsonConfig } from "../_lib/config.ts";
import { builtInHeuristicPatchForModel, fallbackHeuristicNumbers, type ModelSummary } from "../_lib/heuristics.ts";

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

export type ContextimateConfig = {
  profiles?: Record<string, HeuristicProfile>;
  defaults?: Partial<Pick<ResolvedHeuristic, "textDenominator" | "sessionDenominator" | "toolDenominator" | "toolNumerator">> & { profile?: string };
  rules?: HeuristicRule[];
};

export type ResolvedHeuristic = {
  label: string;
  source: string;
  textDenominator: number;
  sessionDenominator: number;
  toolDenominator: number;
  toolNumerator: string;
};

// pi does not re-export pi-ai's Model type; ctx.model carries it.
type PiModel = NonNullable<ExtensionContext["model"]>;

export function toModelSummary(model: PiModel | undefined): ModelSummary | undefined {
  return model ? { provider: model.provider, id: model.id, api: model.api } : undefined;
}

function mergeContextimateConfig(base: ContextimateConfig, next?: ContextimateConfig): ContextimateConfig {
  if (!next) return base;
  return {
    ...base,
    ...next,
    defaults: { ...base.defaults, ...next.defaults },
    profiles: { ...base.profiles, ...next.profiles },
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

export function parseContextimateConfig(value: unknown): ContextimateConfig {
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

export function loadContextimateConfig(cwd: string): ContextimateConfig {
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

function applyHeuristicPatch(base: ResolvedHeuristic, patch: HeuristicProfile | Partial<ResolvedHeuristic>, source: string): ResolvedHeuristic {
  return {
    label: patch.label ?? base.label,
    source,
    textDenominator: patch.textDenominator ?? base.textDenominator,
    sessionDenominator: patch.sessionDenominator ?? base.sessionDenominator,
    toolDenominator: patch.toolDenominator ?? base.toolDenominator,
    toolNumerator: patch.toolNumerator ?? base.toolNumerator,
  };
}

export function resolveHeuristic(model: ModelSummary | undefined, config: ContextimateConfig): ResolvedHeuristic {
  const candidates: Array<{ patch: HeuristicProfile | Partial<ResolvedHeuristic>; source: string }> = [];
  const defaults = config.defaults ?? {};
  if (defaults.profile && config.profiles?.[defaults.profile]) {
    candidates.push({ patch: config.profiles[defaults.profile], source: `profile:${defaults.profile}` });
  }
  candidates.push({ patch: defaults, source: "configured defaults" });
  const builtIn = builtInHeuristicPatchForModel(model);
  if (builtIn) candidates.push({ patch: builtIn, source: builtIn.label });
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
