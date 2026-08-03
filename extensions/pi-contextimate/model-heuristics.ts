export type ToolNumeratorKind =
  | "anthropic"
  | "openai-cookbook"
  | "openai-responses"
  | "openai-chat"
  | "gemini"
  | "bedrock";

export type BuiltInHeuristicRule = {
  label: string;
  providerIncludes: string[];
  apiEquals: string[];
  /** Explicit model relays whose model id still identifies the downstream tokenizer. */
  relayedModelRoutes?: Array<{ providerIncludes: string; apiEquals: string }>;
  modelRegex?: RegExp;
  textDenominator: number;
  sessionDenominator: number;
  toolDenominator: number;
  toolNumerator: ToolNumeratorKind;
};

const CLAUDE_RELAYED_MODEL_ROUTES = [
  { providerIncludes: "radius", apiEquals: "pi-messages" },
  { providerIncludes: "openrouter", apiEquals: "openai-completions" },
];
const CLAUDE_47_PLUS_MODEL = /claude.*(?:4[-.]?[78]|(?:fable|opus)[-.]?5(?:$|[:.-]))|4[-.]?[78].*claude/;
const CLAUDE_45_46_MODEL = /claude.*4[-.]?[56]|4[-.]?[56].*claude/;

export function codexNeedsReasoningCorrection(modelId: string): boolean {
  const version = modelId.toLowerCase().match(/gpt[-.]?5[-.](\d{1,2})(?=$|[-.:@])/);
  return version !== null && Number(version[1]) >= 3 && Number(version[1]) < 6;
}

export const BUILT_IN_HEURISTIC_RULES: BuiltInHeuristicRule[] = [
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
