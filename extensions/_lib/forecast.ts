// Estimate canonical history in a target model's currency. This mirrors the
// material transform rules that significantly affect size; send-time payload sizing
// remains authoritative for provider-specific serialization.

import {
  builtInHeuristicForModel,
  estimateCharsAsTokens,
  fallbackHeuristicNumbers,
  type HeuristicNumbers,
  type ModelSummary,
} from "./heuristics.ts";
import { ESTIMATED_IMAGE_CHARS, type ProviderPromptForecast } from "./provider-prompt.ts";
import { estimateToolListTokens, type ToolShape } from "./tool-payloads.ts";

export type TargetModel = ModelSummary & {
  /** Model input modalities; images are placeholdered for non-vision targets. */
  input?: readonly string[];
};

// Callers pass convertToLlm() output (pi-ai Message[]), typed structurally so _lib
// carries no pi-ai type dependency.
type ForecastBlock = {
  type: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  redacted?: boolean;
  id?: string;
  name?: string;
  arguments?: unknown;
  thoughtSignature?: string;
};

export type ForecastMessage = {
  role: string;
  content: unknown;
  provider?: string;
  api?: string;
  model?: string;
  stopReason?: string;
};

interface HistoryForecast {
  textChars: number;
  keptReasoningChars: number;
  imageChars: number;
}

// pi's transformMessages placeholders for non-vision targets, by message role.
const NON_VISION_USER_PLACEHOLDER_CHARS = "(image omitted: model does not support images)".length;
const NON_VISION_TOOL_PLACEHOLDER_CHARS = "(tool image omitted: model does not support images)".length;

function sameModel(message: ForecastMessage, target: TargetModel): boolean {
  return message.provider === target.provider && message.api === target.api && message.model === target.id;
}

function blockList(content: unknown): ForecastBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ForecastBlock => typeof block === "object" && block !== null);
}

// User and tool-result content. For non-vision targets pi collapses each *run* of
// consecutive images into one role-specific placeholder.
function countUserContent(forecast: HistoryForecast, content: unknown, visionTarget: boolean, placeholderChars: number): void {
  if (typeof content === "string") {
    forecast.textChars += content.length;
    return;
  }
  let inImageRun = false;
  for (const block of blockList(content)) {
    if (block.type === "image") {
      if (visionTarget) forecast.imageChars += ESTIMATED_IMAGE_CHARS;
      else if (!inImageRun) forecast.imageChars += placeholderChars;
      inImageRun = true;
      continue;
    }
    inImageRun = false;
    if (block.type === "text") forecast.textChars += (block.text ?? "").length;
  }
}

function countToolCall(forecast: HistoryForecast, block: ForecastBlock, isSame: boolean): void {
  // The immediate estimate counts the stored id/name/arguments. Provider-specific ID
  // rewriting has a small measured effect; the observed send-time payload supersedes
  // this canonical estimate. Encrypted payload char length remains the size proxy.
  forecast.textChars += JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments }).length;
  if (isSame && typeof block.thoughtSignature === "string") forecast.keptReasoningChars += block.thoughtSignature.length;
}

function countThinking(forecast: HistoryForecast, block: ForecastBlock, isSame: boolean): void {
  const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
  const readable = block.thinking ?? "";
  if (block.redacted) {
    // Redacted thinking is opaque encrypted content: replayed same-model, dropped otherwise.
    if (isSame && signature !== undefined) forecast.keptReasoningChars += signature.length;
    return;
  }
  if (isSame) {
    // Same-model: signatures replay the encrypted payload (the readable summary is
    // not re-sent when a signature exists); signature-less readable thinking replays
    // as-is; blank blocks are skipped.
    if (signature !== undefined) forecast.keptReasoningChars += signature.length;
    else if (readable.trim().length > 0) forecast.keptReasoningChars += readable.length;
    return;
  }
  // Cross-model: readable thinking becomes ordinary assistant text (blank blocks
  // vanish); the encrypted payload, if any, is dropped.
  if (readable.trim().length > 0) forecast.textChars += readable.length;
}

/**
 * What pi's canonical history becomes for a target model, in chars by category.
 * Mirrors the size-material rules of pi-ai's transformMessages (contract-pinned):
 * aborted/error assistant turns are skipped; reasoning is replayed, converted or
 * dropped per model identity; images are placeholdered for non-vision targets.
 * Synthetic "No result provided" tool results are ignored as immaterial.
 */
export function forecastHistoryForTarget(messages: readonly ForecastMessage[], target: TargetModel): HistoryForecast {
  const visionTarget = target.input?.includes("image") ?? true;
  const forecast: HistoryForecast = { textChars: 0, keptReasoningChars: 0, imageChars: 0 };
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const isSame = sameModel(message, target);
      for (const block of blockList(message.content)) {
        if (block.type === "thinking") countThinking(forecast, block, isSame);
        else if (block.type === "toolCall") countToolCall(forecast, block, isSame);
        else if (block.type === "text") forecast.textChars += (block.text ?? "").length;
      }
      continue;
    }
    const placeholderChars = message.role === "toolResult" ? NON_VISION_TOOL_PLACEHOLDER_CHARS : NON_VISION_USER_PLACEHOLDER_CHARS;
    countUserContent(forecast, message.content, visionTarget, placeholderChars);
  }
  return forecast;
}

interface PromptForecast {
  tokens: number;
  heuristic: HeuristicNumbers;
}

function estimatePrompt(
  history: readonly ForecastMessage[],
  systemPromptChars: number,
  tools: ToolShape[],
  model: TargetModel,
): PromptForecast {
  const heuristic = builtInHeuristicForModel(model) ?? fallbackHeuristicNumbers();
  const counts = forecastHistoryForTarget(history, model);
  const historyChars = counts.textChars + counts.keptReasoningChars + counts.imageChars;
  const tokens =
    estimateCharsAsTokens(systemPromptChars, heuristic.textDenominator) +
    estimateToolListTokens(tools, heuristic) +
    estimateCharsAsTokens(historyChars, heuristic.sessionDenominator);
  return { tokens, heuristic };
}

/**
 * Estimate the full first prompt to a target model: system prompt and tools under
 * the family text/tool heuristics, history under the session denominator, all in
 * the target model's currency. At send time, providerPrompt replaces that canonical
 * target estimate with the observed wire fields. Callers must render the result as an
 * estimate (design language §4: ~ and est wording); it is never a provider-exact count.
 * A source-model bill never rescales this estimate because measured token density does
 * not transfer reliably across tokenizers.
 */
export function forecastTargetPrompt(args: {
  history: readonly ForecastMessage[];
  systemPromptChars: number;
  tools: ToolShape[];
  target: TargetModel;
  providerPrompt?: ProviderPromptForecast;
}): PromptForecast {
  const target = args.providerPrompt ?? estimatePrompt(args.history, args.systemPromptChars, args.tools, args.target);
  return { tokens: target.tokens, heuristic: target.heuristic };
}
