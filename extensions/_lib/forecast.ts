import {
  builtInHeuristicForModel,
  estimateCharsAsTokens,
  fallbackHeuristicNumbers,
  type ModelSummary,
} from "./heuristics.ts";
import { estimateToolListTokens, type ToolShape } from "./tool-payloads.ts";

// Pi's compaction estimator uses the same flat cost for every retained image.
export const ESTIMATED_IMAGE_CHARS = 4800;

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

function blockList(content: unknown): ForecastBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ForecastBlock => typeof block === "object" && block !== null);
}

export function forecastHistoryForTarget(messages: readonly ForecastMessage[], target: TargetModel): HistoryForecast {
  const visionTarget = target.input?.includes("image") ?? true;
  const forecast: HistoryForecast = { textChars: 0, keptReasoningChars: 0, imageChars: 0 };
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const isSame = message.provider === target.provider && message.api === target.api && message.model === target.id;
      for (const block of blockList(message.content)) {
        if (block.type === "thinking") {
          const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
          const readable = block.thinking ?? "";
          if (block.redacted) {
            if (isSame && signature !== undefined) forecast.keptReasoningChars += signature.length;
            continue;
          }
          if (isSame) {
            if (signature !== undefined) forecast.keptReasoningChars += signature.length;
            else if (readable.trim().length > 0) forecast.keptReasoningChars += readable.length;
          } else if (readable.trim().length > 0) {
            forecast.textChars += readable.length;
          }
          continue;
        }
        if (block.type === "toolCall") {
          forecast.textChars += JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments }).length;
          if (isSame && typeof block.thoughtSignature === "string") {
            forecast.keptReasoningChars += block.thoughtSignature.length;
          }
          continue;
        }
        if (block.type === "text") forecast.textChars += (block.text ?? "").length;
      }
      continue;
    }
    if (typeof message.content === "string") {
      forecast.textChars += message.content.length;
      continue;
    }
    const placeholderChars = message.role === "toolResult"
      ? NON_VISION_TOOL_PLACEHOLDER_CHARS
      : NON_VISION_USER_PLACEHOLDER_CHARS;
    let inImageRun = false;
    for (const block of blockList(message.content)) {
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
  return forecast;
}

export function forecastTargetPrompt(args: {
  history: readonly ForecastMessage[];
  systemPromptChars: number;
  tools: ToolShape[];
  target: TargetModel;
}) {
  const heuristic = builtInHeuristicForModel(args.target) ?? fallbackHeuristicNumbers();
  const counts = forecastHistoryForTarget(args.history, args.target);
  const historyChars = counts.textChars + counts.keptReasoningChars + counts.imageChars;
  return {
    tokens:
      estimateCharsAsTokens(args.systemPromptChars, heuristic.textDenominator) +
      estimateToolListTokens(args.tools, heuristic) +
      estimateCharsAsTokens(historyChars, heuristic.sessionDenominator),
    heuristic,
  };
}
