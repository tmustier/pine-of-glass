// How Contextimate turns characters into tokens: built-in per-model heuristics, adjusted by
// the user's pi-contextimate config.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, positiveNumberValue, stringValue, type JsonFields } from "../_lib/boundary.ts";
import { configPaths, readJsonConfig } from "../_lib/config.ts";
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
  defaults?: HeuristicProfile & { profile?: string };
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

function parseHeuristicProfile(value: JsonFields): HeuristicProfile {
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
      if (!isJsonObject(entry)) continue;
      const profile = parseHeuristicProfile(entry);
      if (Object.keys(profile).length > 0) profiles[name] = profile;
    }
    if (Object.keys(profiles).length > 0) config.profiles = profiles;
  }
  if (Array.isArray(value.rules)) {
    const rules: HeuristicRule[] = [];
    for (const entry of value.rules) {
      if (!isJsonObject(entry)) continue;
      const rule: HeuristicRule = parseHeuristicProfile(entry);
      const profile = stringValue(entry.profile);
      if (profile) rule.profile = profile;
      if (isJsonObject(entry.match)) {
        const match: NonNullable<HeuristicRule["match"]> = {};
        const provider = stringValue(entry.match.provider);
        const model = stringValue(entry.match.model);
        const id = stringValue(entry.match.id);
        const api = stringValue(entry.match.api);
        if (provider) match.provider = provider;
        if (model) match.model = model;
        if (id) match.id = id;
        if (api) match.api = api;
        if (Object.keys(match).length > 0) rule.match = match;
      }
      if (Object.keys(rule).length > 0) rules.push(rule);
    }
    if (rules.length > 0) config.rules = rules;
  }
  return config;
}

export function loadContextimateConfig(cwd: string): ContextimateConfig {
  const extraPaths = (process.env.PI_CONTEXTIMATE_CONFIG ?? "").split(":").map((entry) => entry.trim()).filter(Boolean);
  return [...configPaths("pi-contextimate", cwd), ...extraPaths].reduce<ContextimateConfig>((base, filePath) => {
    const next = readJsonConfig(filePath, parseContextimateConfig);
    if (!next) return base;
    return {
      defaults: { ...base.defaults, ...next.defaults },
      profiles: { ...base.profiles, ...next.profiles },
      rules: [...(base.rules ?? []), ...(next.rules ?? [])],
    };
  }, {});
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
  if (pattern.includes("*") || pattern.includes("?")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i").test(value);
  }
  return value.toLowerCase() === pattern.toLowerCase();
}

export function resolveHeuristic(model: ModelSummary | undefined, config: ContextimateConfig): ResolvedHeuristic {
  const candidates: Array<{ patch: HeuristicProfile; source: string }> = [];
  const defaults = config.defaults ?? {};
  if (defaults.profile && config.profiles?.[defaults.profile]) {
    candidates.push({ patch: config.profiles[defaults.profile], source: `profile:${defaults.profile}` });
  }
  candidates.push({ patch: defaults, source: "configured defaults" });
  const builtIn = builtInHeuristicPatchForModel(model);
  if (builtIn) candidates.push({ patch: builtIn, source: builtIn.label });
  for (const rule of config.rules ?? []) {
    const match = rule.match;
    if (!matchesPattern(model?.provider ?? "", match?.provider)
      || !matchesPattern(model?.id ?? "", match?.model ?? match?.id)
      || !matchesPattern(model?.api ?? "", match?.api)) continue;
    if (rule.profile && config.profiles?.[rule.profile]) {
      candidates.push({ patch: config.profiles[rule.profile], source: `profile:${rule.profile}` });
    }
    candidates.push({ patch: rule, source: rule.label ?? (rule.profile ? `rule:${rule.profile}` : "custom rule") });
  }
  return candidates.reduce<ResolvedHeuristic>(
    (base, { patch, source }) => ({
      label: patch.label ?? base.label,
      source,
      textDenominator: patch.textDenominator ?? base.textDenominator,
      sessionDenominator: patch.sessionDenominator ?? base.sessionDenominator,
      toolDenominator: patch.toolDenominator ?? base.toolDenominator,
      toolNumerator: patch.toolNumerator ?? base.toolNumerator,
    }),
    { ...fallbackHeuristicNumbers(), source: "fallback" },
  );
}
