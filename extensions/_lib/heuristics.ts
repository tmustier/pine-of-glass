// Shared token-estimation heuristics for the pine-of-glass family.
//
// One table of model-family char/token denominators so contextimate's startup
// panel and cachemire's model-switch forecast cannot disagree about how many
// tokens the same bytes are likely to be. Contextimate layers user config on top;
// these numbers are the built-in floor both extensions share.

type ToolNumeratorKind =
  | "anthropic"
  | "openai-cookbook"
  | "openai-responses"
  | "openai-chat"
  | "gemini"
  | "bedrock"
  | "pi-messages";

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

type TokenizerProfile = Omit<HeuristicNumbers, "toolDenominator" | "toolNumerator">;
type ToolProfile = Pick<HeuristicNumbers, "toolDenominator" | "toolNumerator">;
type BuiltInHeuristic = Partial<HeuristicNumbers> & Pick<HeuristicNumbers, "label">;

export function cleanDenominator(value: unknown, fallback = 4): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Denominators are sanitized once, at heuristic resolution; by the time one reaches a
// count it is a trusted positive number.
export function estimateCharsAsTokens(chars: number, denominator: number): number {
  return Math.ceil(chars / denominator);
}

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

const FALLBACK_TOKENIZER: TokenizerProfile = {
  label: "fallback chars/4",
  textDenominator: 4,
  sessionDenominator: 4,
};
const CLAUDE_47_PLUS: TokenizerProfile = {
  label: "Claude 4.7+ heuristic",
  textDenominator: 2.6,
  sessionDenominator: 2.6,
};
const CLAUDE_45_46: TokenizerProfile = {
  label: "Claude 4.5/4.6 heuristic",
  textDenominator: 3.8,
  sessionDenominator: 3.5,
};
const CLAUDE_GENERIC: TokenizerProfile = {
  label: "Anthropic heuristic",
  textDenominator: 3.5,
  sessionDenominator: 3.5,
};

function isClaudeModel(model: ModelSummary): boolean {
  return model.provider.toLowerCase().includes("anthropic") || model.id.toLowerCase().includes("claude");
}

function tokenizerProfile(model: ModelSummary): TokenizerProfile | undefined {
  if (isClaudeModel(model)) {
    const id = model.id.toLowerCase();
    if (CLAUDE_47_PLUS_MODEL.test(id)) return CLAUDE_47_PLUS;
    if (CLAUDE_45_46_MODEL.test(id)) return CLAUDE_45_46;
    return CLAUDE_GENERIC;
  }
  if (model.provider.toLowerCase().includes("openai-codex")) {
    return { label: "OpenAI-Codex heuristic", textDenominator: 4, sessionDenominator: 4 };
  }
  if (model.provider.toLowerCase().includes("openai")) {
    return { label: "OpenAI Responses heuristic", textDenominator: 4, sessionDenominator: 4 };
  }
  if (model.provider.toLowerCase().includes("google") || model.id.toLowerCase().includes("gemini")) {
    return { label: "Gemini/Vertex heuristic", textDenominator: 4, sessionDenominator: 4 };
  }
  return undefined;
}

function toolProfile(model: ModelSummary): ToolProfile | undefined {
  const provider = model.provider.toLowerCase();
  const api = model.api.toLowerCase();
  if (provider.includes("openai-codex")) return { toolDenominator: 5.5, toolNumerator: "openai-cookbook" };
  if (api === "anthropic-messages") {
    let denominator = 4;
    if (isClaudeModel(model)) denominator = CLAUDE_47_PLUS_MODEL.test(model.id.toLowerCase()) ? 2.6 : 3.3;
    return { toolDenominator: denominator, toolNumerator: "anthropic" };
  }
  if (api === "openai-completions" || api === "mistral-conversations") {
    return { toolDenominator: 4, toolNumerator: "openai-chat" };
  }
  if (api === "google-generative-ai" || api === "google-vertex") return { toolDenominator: 4, toolNumerator: "gemini" };
  if (api === "bedrock-converse-stream") return { toolDenominator: 4, toolNumerator: "bedrock" };
  if (api === "pi-messages") return { toolDenominator: 4, toolNumerator: "pi-messages" };
  if (api === "openai-responses" || api === "azure-openai-responses") {
    return { toolDenominator: provider.includes("openai") ? 5.5 : 4, toolNumerator: "openai-responses" };
  }
  return undefined;
}

export function builtInHeuristicPatchForModel(model?: ModelSummary): BuiltInHeuristic | undefined {
  if (!model) return undefined;
  const tokenizer = tokenizerProfile(model);
  const tools = toolProfile(model);
  if (!tokenizer && !tools) return undefined;
  return { label: tokenizer?.label ?? FALLBACK_TOKENIZER.label, ...tokenizer, ...tools };
}

export function builtInHeuristicForModel(model?: ModelSummary): HeuristicNumbers | undefined {
  const patch = builtInHeuristicPatchForModel(model);
  return patch ? { ...fallbackHeuristicNumbers(), ...patch } : undefined;
}

/** The family fallback when no built-in rule matches and no config overrides. */
export function fallbackHeuristicNumbers(): HeuristicNumbers {
  return {
    ...FALLBACK_TOKENIZER,
    toolDenominator: 4,
    toolNumerator: "openai-responses",
  };
}
