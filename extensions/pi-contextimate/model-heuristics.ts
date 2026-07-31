// Compatibility surface for Contextimate's model-retention and tokenizer policies.
// The shared table lives in _lib so Cachemire and Contextimate use one currency.
export {
  BUILT_IN_HEURISTIC_RULES,
  keepsAllClaudeThinking,
  keepsAllOpenAIReasoning,
} from "../_lib/heuristics.ts";
export type { BuiltInHeuristicRule } from "../_lib/heuristics.ts";
