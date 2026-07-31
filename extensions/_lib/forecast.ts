// Target-model prompt forecasting (issue #57).
//
// After a model switch, the only honest token numbers are estimates in the *target*
// model's currency: the old model's exact counts are in the wrong tokenizer and the
// wrong serialization (pi drops or converts reasoning on cross-model handoffs). This
// module estimates what pi's canonical history becomes for a target model: the
// size-material subset of pi-ai's transformMessages, counted with the same family
// denominators contextimate calibrated.
//
// The transform rules are deliberately a narrow local mirror, not a runtime import:
// pi's extension loader only aliases pi-ai's compat surface (which does not export
// transformMessages), and extensions resolve bare imports against their symlink
// path, so a `pi-ai/api/transform-messages` import would only work in this repo's
// dev layout. The contract suite runs in-repo where that import *does* resolve and
// pins this mirror against the real function (tests/contract/pi-transform-messages).

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

// The message shapes below are the pi seam: callers pass convertToLlm() output
// (pi-ai Message[]), typed structurally so _lib carries no pi-ai type dependency.
type ForecastBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  redacted?: boolean;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  thoughtSignature?: string;
};

export type ForecastMessage = {
  role?: string;
  content?: unknown;
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
const ESTIMATED_IMAGE_CHARS = 4800;
const NON_VISION_PLACEHOLDER_CHARS = "(image omitted: model does not support images)".length;

function sameModel(message: ForecastMessage, target: TargetModel): boolean {
  return message.provider === target.provider && message.api === target.api && message.model === target.id;
}

function blockList(content: unknown): ForecastBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ForecastBlock => typeof block === "object" && block !== null);
}

function reasoningPayloadChars(signature: string): number {
  // Encrypted reasoning payloads replay verbatim; their char length is the honest
  // size proxy (mirrors contextimate's session breakdown convention).
  return signature.length;
}

function countImage(forecast: HistoryForecast, visionTarget: boolean): void {
  forecast.imageCount += 1;
  forecast.imageChars += visionTarget ? ESTIMATED_IMAGE_CHARS : NON_VISION_PLACEHOLDER_CHARS;
}

function countTextBlocks(forecast: HistoryForecast, content: unknown, visionTarget: boolean): void {
  if (typeof content === "string") {
    forecast.textChars += content.length;
    return;
  }
  for (const block of blockList(content)) {
    if (block.type === "text") forecast.textChars += (block.text ?? "").length;
    else if (block.type === "image") countImage(forecast, visionTarget);
  }
}

function countToolCall(forecast: HistoryForecast, block: ForecastBlock, isSame: boolean): void {
  // Tool calls replay as id/name/arguments; cross-model the thoughtSignature is
  // stripped (pi-ai transformMessages), so it is never counted for a foreign target.
  forecast.textChars += JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments })?.length ?? 0;
  if (isSame && typeof block.thoughtSignature === "string") {
    forecast.keptReasoningChars += reasoningPayloadChars(block.thoughtSignature);
  } else if (typeof block.thoughtSignature === "string") {
    forecast.droppedReasoningChars += reasoningPayloadChars(block.thoughtSignature);
  }
}

function countThinking(forecast: HistoryForecast, block: ForecastBlock, isSame: boolean): void {
  const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
  const readable = (block.thinking ?? "").trim();
  if (block.redacted) {
    // Redacted thinking is opaque encrypted content: replayed same-model, dropped otherwise.
    if (signature === undefined) return;
    if (isSame) forecast.keptReasoningChars += reasoningPayloadChars(signature);
    else forecast.droppedReasoningChars += reasoningPayloadChars(signature);
    return;
  }
  if (isSame) {
    // Same-model: signatures replay the encrypted payload (the readable summary is
    // not re-sent when a signature exists); signature-less readable thinking replays
    // as text; empty blocks are skipped.
    if (signature !== undefined) forecast.keptReasoningChars += reasoningPayloadChars(signature);
    else if (readable.length > 0) forecast.keptReasoningChars += readable.length;
    return;
  }
  // Cross-model: readable thinking becomes ordinary assistant text; the encrypted
  // payload (if any) is dropped; empty blocks vanish.
  if (readable.length > 0) forecast.textChars += readable.length;
  if (signature !== undefined) forecast.droppedReasoningChars += reasoningPayloadChars(signature);
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
        else if (block.type === "image") countImage(forecast, visionTarget);
      }
      continue;
    }
    forecast.messageCount += 1;
    countTextBlocks(forecast, message.content, visionTarget);
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
