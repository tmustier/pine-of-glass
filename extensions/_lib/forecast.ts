// Target-model prompt forecasting (issue #57): estimate what pi's canonical history
// becomes for a target model, in that model's currency. The size-material rules of
// pi-ai's transformMessages are mirrored locally because extensions cannot import it
// at runtime (pi's loader only aliases the compat surface); the contract suite
// (tests/contract/pi-transform-messages) compares this mirror against the real
// function, so drift fails `npm test`.

import {
  builtInHeuristicForModel,
  estimateCharsAsTokens,
  fallbackHeuristicNumbers,
  type HeuristicNumbers,
  type ModelSummary,
} from "./heuristics.ts";
import { estimateToolListTokens, type ToolShape } from "./tool-payloads.ts";

/** Target identity + capabilities; the slice of pi-ai's Model the forecast needs. */
export type TargetModel = ModelSummary & {
  contextWindow?: number;
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

export interface HistoryForecast {
  /** Text the target will receive: user/assistant text, tool calls/results, and
   * readable reasoning converted to plain text on cross-model handoffs. */
  textChars: number;
  /** Same-model reasoning replayed as-is (encrypted payloads, or readable text). */
  keptReasoningChars: number;
  /** Cross-model reasoning the target will never see (encrypted/redacted payloads). */
  droppedReasoningChars: number;
  imageCount: number;
  /** Images at pi's own flat per-image char convention (compaction's estimate). */
  imageChars: number;
  messageCount: number;
}

// pi's compaction estimator counts an image as 4800 chars; reuse that convention
// rather than inventing a second one (real image tokens are model-specific).
export const ESTIMATED_IMAGE_CHARS = 4800;
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
      forecast.imageCount += 1;
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
  // Tool calls replay as id/name/arguments; cross-model the thoughtSignature is
  // stripped, so it is never counted for a foreign target. Encrypted payload char
  // length is the size proxy throughout (contextimate's convention).
  forecast.textChars += JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments }).length;
  if (typeof block.thoughtSignature !== "string") return;
  if (isSame) forecast.keptReasoningChars += block.thoughtSignature.length;
  else forecast.droppedReasoningChars += block.thoughtSignature.length;
}

function countThinking(forecast: HistoryForecast, block: ForecastBlock, isSame: boolean): void {
  const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
  const readable = block.thinking ?? "";
  if (block.redacted) {
    // Redacted thinking is opaque encrypted content: replayed same-model, dropped otherwise.
    if (signature === undefined) return;
    if (isSame) forecast.keptReasoningChars += signature.length;
    else forecast.droppedReasoningChars += signature.length;
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
  if (signature !== undefined) forecast.droppedReasoningChars += signature.length;
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
  const forecast: HistoryForecast = {
    textChars: 0,
    keptReasoningChars: 0,
    droppedReasoningChars: 0,
    imageCount: 0,
    imageChars: 0,
    messageCount: 0,
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      forecast.messageCount += 1;
      const isSame = sameModel(message, target);
      for (const block of blockList(message.content)) {
        if (block.type === "thinking") countThinking(forecast, block, isSame);
        else if (block.type === "toolCall") countToolCall(forecast, block, isSame);
        else if (block.type === "text") forecast.textChars += (block.text ?? "").length;
      }
      continue;
    }
    forecast.messageCount += 1;
    const placeholderChars = message.role === "toolResult" ? NON_VISION_TOOL_PLACEHOLDER_CHARS : NON_VISION_USER_PLACEHOLDER_CHARS;
    countUserContent(forecast, message.content, visionTarget, placeholderChars);
  }
  return forecast;
}

export interface PromptForecast {
  /** Estimated target-currency prompt tokens (harness + history). */
  tokens: number;
  historyChars: number;
  droppedReasoningChars: number;
  imageCount: number;
  heuristic: HeuristicNumbers;
}

/**
 * Estimate the full first prompt to a target model: system prompt and tools under
 * the family text/tool heuristics, history under the session denominator, all in
 * the target model's currency. Callers must render the result as an estimate
 * (design language §4: ~ and est wording); it is never a provider-exact count.
 */
export function forecastTargetPrompt(args: {
  history: readonly ForecastMessage[];
  systemPromptChars: number;
  tools: ToolShape[];
  target: TargetModel;
}): PromptForecast {
  const heuristic = builtInHeuristicForModel(args.target) ?? fallbackHeuristicNumbers();
  const history = forecastHistoryForTarget(args.history, args.target);
  const historyChars = history.textChars + history.keptReasoningChars + history.imageChars;
  const tokens =
    estimateCharsAsTokens(args.systemPromptChars, heuristic.textDenominator) +
    estimateToolListTokens(args.tools, heuristic) +
    estimateCharsAsTokens(historyChars, heuristic.sessionDenominator);
  return {
    tokens,
    historyChars,
    droppedReasoningChars: history.droppedReasoningChars,
    imageCount: history.imageCount,
    heuristic,
  };
}
