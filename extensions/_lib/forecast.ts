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
import { ESTIMATED_IMAGE_CHARS, type ProviderPromptForecast } from "./provider-prompt.ts";
import { estimateToolListTokens, type ToolShape } from "./tool-payloads.ts";

export { ESTIMATED_IMAGE_CHARS } from "./provider-prompt.ts";

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
  /** Images at pi's own flat per-image char convention (compaction's estimate). */
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

function shortHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function normalizedIdPart(value: string, limit = 64): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, limit).replace(/_+$/, "");
}

/** Mirror pi-ai's cross-provider ID normalization for the APIs Cachemire can size
 * before provider serialization. The send-time payload remains authoritative. */
export function normalizeForecastToolCallId(id: string, target: TargetModel, source: ForecastMessage): string {
  if (target.api === "anthropic-messages" || target.api === "bedrock-converse-stream") {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  }
  if (target.api === "google-generative-ai" || target.api === "google-vertex") {
    return target.id.startsWith("claude-") || target.id.startsWith("gpt-oss-")
      ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
      : id;
  }
  if (target.api === "mistral-conversations") {
    const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
    return normalized.length === 9 ? normalized : shortHash(normalized || id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 9);
  }
  if (target.api === "openai-completions") {
    if (!id.includes("|")) return target.provider === "openai" ? id.slice(0, 40) : id;
    const separator = id.indexOf("|");
    const callId = id.slice(0, separator).replace(/[^a-zA-Z0-9_-]/g, "_");
    const itemId = id.slice(separator + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
    const combined = itemId.length > 0 ? `${callId}_${itemId}` : callId;
    if (combined.length <= 40) return combined;
    const hash = shortHash(id).slice(0, 8);
    return `${callId.slice(0, Math.max(1, 39 - hash.length))}_${hash}`;
  }
  if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(target.api)) {
    const allowedProviders = target.api === "azure-openai-responses"
      ? ["openai", "openai-codex", "opencode", "azure-openai-responses"]
      : ["openai", "openai-codex", "opencode"];
    const allowedProvider = allowedProviders.includes(target.provider);
    if (!allowedProvider || !id.includes("|")) return normalizedIdPart(id);
    const [callId = "", itemId = ""] = id.split("|");
    const normalizedCall = normalizedIdPart(callId);
    const foreign = source.provider !== target.provider || source.api !== target.api;
    let normalizedItem = foreign ? `fc_${shortHash(itemId)}` : normalizedIdPart(itemId);
    if (!normalizedItem.startsWith("fc_")) normalizedItem = normalizedIdPart(`fc_${normalizedItem}`);
    return `${normalizedCall}|${normalizedItem}`;
  }
  return id;
}

function countToolCall(
  forecast: HistoryForecast,
  block: ForecastBlock,
  isSame: boolean,
  source: ForecastMessage,
  target: TargetModel,
): void {
  // Tool calls replay as id/name/arguments; cross-model the thoughtSignature is
  // stripped and provider serializers normalize the id. Encrypted payload char length
  // is the size proxy throughout (contextimate's convention).
  const id = !isSame && typeof block.id === "string" ? normalizeForecastToolCallId(block.id, target, source) : block.id;
  forecast.textChars += JSON.stringify({ id, name: block.name, arguments: block.arguments }).length;
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
        else if (block.type === "toolCall") countToolCall(forecast, block, isSame, message, target);
        else if (block.type === "text") forecast.textChars += (block.text ?? "").length;
      }
      continue;
    }
    const placeholderChars = message.role === "toolResult" ? NON_VISION_TOOL_PLACEHOLDER_CHARS : NON_VISION_USER_PLACEHOLDER_CHARS;
    countUserContent(forecast, message.content, visionTarget, placeholderChars);
  }
  return forecast;
}

export interface PromptForecast {
  /** Estimated target-currency prompt tokens (harness + history). */
  tokens: number;
  heuristic: HeuristicNumbers;
  /** Density correction applied from the source anchor, when one was trusted. */
  calibration?: number;
  /** Estimated tokens of source-billed encrypted reasoning the target never receives
   * (priced at the source's calibrated density); present only alongside calibration. */
  droppedThinkingTokens?: number;
}

// Static denominators miss content that tokenizes unusually (dense numeric logs run
// ~2.1 chars/token on Claude vs the 2.6 default). The correction from a billed anchor
// is bounded: past 2x/0.5x the anchor is more likely stale than the content special.
// Exported so callers can tell a trusted correction from a saturated one: at the
// bounds the anchor no longer explains the estimate, only limits it.
export const CALIBRATION_MIN = 0.5;
export const CALIBRATION_MAX = 2;
// Encrypted reasoning payload chars are a size *convention*, not a measurement; when
// they dominate the source serialization the billed/estimated ratio is meaningless.
const CALIBRATION_MAX_REASONING_SHARE = 0.25;

function estimatePrompt(
  history: readonly ForecastMessage[],
  systemPromptChars: number,
  tools: ToolShape[],
  model: TargetModel,
): { tokens: number; heuristic: HeuristicNumbers; counts: HistoryForecast } {
  const heuristic = builtInHeuristicForModel(model) ?? fallbackHeuristicNumbers();
  const counts = forecastHistoryForTarget(history, model);
  const historyChars = counts.textChars + counts.keptReasoningChars + counts.imageChars;
  const tokens =
    estimateCharsAsTokens(systemPromptChars, heuristic.textDenominator) +
    estimateToolListTokens(tools, heuristic) +
    estimateCharsAsTokens(historyChars, heuristic.sessionDenominator);
  return { tokens, heuristic, counts };
}

/**
 * Estimate the full first prompt to a target model: system prompt and tools under
 * the family text/tool heuristics, history under the session denominator, all in
 * the target model's currency. At send time, providerPrompt replaces that canonical
 * target estimate with the observed wire fields while retaining source calibration.
 * Callers must render the result as an estimate (design language §4: ~ and est
 * wording); it is never a provider-exact count.
 *
 * When a calibration anchor is given (the model that last billed this history and
 * its real prompt tokens), the same estimate is run in the source currency and the
 * billed/estimated ratio corrects the target number for this session's actual
 * content density. The anchor is the nearest billed call on the path, typically one
 * response behind the current history; the clamp bounds that drift.
 */
export function forecastTargetPrompt(args: {
  history: readonly ForecastMessage[];
  systemPromptChars: number;
  tools: ToolShape[];
  target: TargetModel;
  providerPrompt?: ProviderPromptForecast;
  calibration?: { source: TargetModel; billedPromptTokens: number };
}): PromptForecast {
  const target = args.providerPrompt ?? estimatePrompt(args.history, args.systemPromptChars, args.tools, args.target);
  const anchor = args.calibration;
  if (anchor === undefined || anchor.billedPromptTokens <= 0 || !Number.isFinite(anchor.billedPromptTokens)) {
    return { tokens: target.tokens, heuristic: target.heuristic };
  }
  const source = estimatePrompt(args.history, args.systemPromptChars, args.tools, anchor.source);
  const sourceChars = source.counts.textChars + source.counts.keptReasoningChars + source.counts.imageChars;
  if (source.tokens <= 0 || sourceChars <= 0 ||
      source.counts.keptReasoningChars / sourceChars > CALIBRATION_MAX_REASONING_SHARE) {
    return { tokens: target.tokens, heuristic: target.heuristic };
  }
  const ratio = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, anchor.billedPromptTokens / source.tokens));
  // Signatures replay only to the exact provider, API and model that produced them.
  const sameIdentity = anchor.source.provider === args.target.provider &&
    anchor.source.api === args.target.api && anchor.source.id === args.target.id;
  const droppedChars = sameIdentity ? 0 : source.counts.keptReasoningChars;
  return {
    tokens: Math.round(target.tokens * ratio),
    heuristic: target.heuristic,
    calibration: ratio,
    droppedThinkingTokens: Math.round((droppedChars / source.heuristic.sessionDenominator) * ratio),
  };
}
