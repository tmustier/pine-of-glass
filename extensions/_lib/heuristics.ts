// Shared token-estimation heuristics for the pine-of-glass family.
//
// One table of model-family char/token denominators so contextimate's startup
// panel and cachemire's model-switch forecast cannot disagree about how many
// tokens the same bytes are likely to be. Contextimate layers user config on top;
// these numbers are the built-in floor both extensions share.

export type ToolNumeratorKind =
  | "anthropic"
  | "openai-cookbook"
  | "openai-responses"
  | "openai-chat"
  | "gemini"
  | "bedrock";

export type ModelSummary = {
  provider: string;
  id: string;
  api: string;
};

/** The built-in per-family numbers. Contextimate's ResolvedHeuristic extends this
 * with config provenance. */
export type HeuristicNumbers = {
  label: string;
  textDenominator: number;
  sessionDenominator: number;
  toolDenominator: number;
  toolNumerator: ToolNumeratorKind;
};

export type BuiltInHeuristicRule = HeuristicNumbers & {
  providerIncludes: string[];
  apiEquals: string[];
  /** Explicit model relays whose model id still identifies the downstream tokenizer. */
  relayedModelRoutes?: Array<{ providerIncludes: string; apiEquals: string }>;
  modelRegex?: RegExp;
};

export function cleanDenominator(value: unknown, fallback = 4): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Denominators are sanitized once, at heuristic resolution; by the time one reaches a
// count it is a trusted positive number.
export function estimateCharsAsTokens(chars: number, denominator: number): number {
  return Math.ceil(chars / denominator);
}

const CLAUDE_RELAYED_MODEL_ROUTES = [
  { providerIncludes: "radius", apiEquals: "pi-messages" },
  { providerIncludes: "openrouter", apiEquals: "openai-completions" },
];
const CLAUDE_47_PLUS_MODEL = /claude.*(?:4[-.]?[7-9](?=$|[-.:@])|(?:fable|opus|sonnet|haiku)[-.]?5(?=$|[-.:@]))|4[-.]?[7-9](?=$|[-.:@]).*claude/;
const CLAUDE_45_46_MODEL = /claude.*4[-.]?[56]|4[-.]?[56].*claude/;

function familyAtLeast(modelId: string, family: string, major: number, minor: number): boolean {
  const versionPattern = `${family}[-.]?(\\d{1,2})(?:[-.](\\d{1,2}))?(?=$|[-.:@])`;
  const version = modelId.toLowerCase().match(new RegExp(versionPattern));
  if (!version) return false;
  const foundMajor = Number(version[1]);
  const foundMinor = Number(version[2] ?? 0);
  return foundMajor > major || (foundMajor === major && foundMinor >= minor);
}

/** Anthropic's default keep-all policy; Pi passes same-model signed blocks back intact. */
export function keepsAllClaudeThinking(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return familyAtLeast(id, "opus", 4, 5)
    || familyAtLeast(id, "sonnet", 4, 6)
    || familyAtLeast(id, "fable", 5, 0)
    || familyAtLeast(id, "mythos", 5, 0)
    || /mythos[-.]?preview/.test(id);
}

/** OpenAI's default all-turns reasoning context starts with the GPT-5.6 family. */
export function keepsAllOpenAIReasoning(modelId: string): boolean {
  return familyAtLeast(modelId, "gpt", 5, 6);
}

export const BUILT_IN_HEURISTIC_RULES: BuiltInHeuristicRule[] = [
  {
    // 5-generation ids end in -5 (claude-fable-5, claude-opus-5), optionally with a
    // date suffix. claude-opus-4-5 and claude-3-5-* must keep their own rules: the
    // \w+ segment cannot span a hyphen, so 4-5/3-5 ids never reach the trailing -5.
    label: "Claude 5 heuristic",
    providerIncludes: ["anthropic"],
    apiEquals: ["anthropic-messages"],
    modelRegex: /claude-\w+-5(?:-\d+)?$/,
    textDenominator: 2.6,
    sessionDenominator: 2.6,
    toolDenominator: 2.6,
    toolNumerator: "anthropic",
  },
  {
    label: "Claude 4.7+ heuristic",
    providerIncludes: ["anthropic"],
    apiEquals: ["anthropic-messages"],
    relayedModelRoutes: CLAUDE_RELAYED_MODEL_ROUTES,
    modelRegex: CLAUDE_47_PLUS_MODEL,
    textDenominator: 2.6,
    sessionDenominator: 2.6,
    toolDenominator: 2.6,
    toolNumerator: "anthropic",
  },
  {
    label: "Claude 4.5/4.6 heuristic",
    providerIncludes: ["anthropic"],
    apiEquals: ["anthropic-messages"],
    relayedModelRoutes: CLAUDE_RELAYED_MODEL_ROUTES,
    modelRegex: CLAUDE_45_46_MODEL,
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
    label: "Claude 4.7+ on Bedrock heuristic",
    providerIncludes: ["bedrock"],
    apiEquals: ["bedrock-converse-stream"],
    modelRegex: CLAUDE_47_PLUS_MODEL,
    textDenominator: 2.6,
    sessionDenominator: 2.6,
    toolDenominator: 4,
    toolNumerator: "bedrock",
  },
  {
    label: "Claude 4.5/4.6 on Bedrock heuristic",
    providerIncludes: ["bedrock"],
    apiEquals: ["bedrock-converse-stream"],
    modelRegex: CLAUDE_45_46_MODEL,
    textDenominator: 3.8,
    sessionDenominator: 3.5,
    toolDenominator: 4,
    toolNumerator: "bedrock",
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

export function builtInRuleMatches(rule: BuiltInHeuristicRule, model: ModelSummary): boolean {
  const provider = model.provider.toLowerCase();
  const api = model.api.toLowerCase();
  const providerOrApiMatches = rule.providerIncludes.some((entry) => provider.includes(entry))
    || rule.apiEquals.includes(api);
  const explicitRelayMatches = rule.relayedModelRoutes?.some(
    (route) => provider.includes(route.providerIncludes) && api === route.apiEquals,
  ) ?? false;
  const modelMatches = rule.modelRegex ? rule.modelRegex.test(model.id.toLowerCase()) : true;
  return (providerOrApiMatches || explicitRelayMatches) && modelMatches;
}

export function builtInHeuristicForModel(model?: ModelSummary): HeuristicNumbers | undefined {
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

/** The family fallback when no built-in rule matches and no config overrides. */
export function fallbackHeuristicNumbers(): HeuristicNumbers {
  return {
    label: "fallback chars/4",
    textDenominator: 4,
    sessionDenominator: 4,
    toolDenominator: 4,
    toolNumerator: "openai-responses",
  };
}
