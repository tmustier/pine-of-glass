// Provider-payload prompt sizing. before_provider_request exposes the wire body
// observed at this extension, after pi's normalization and earlier transforms. Only fields
// that carry prompt material are measured; model/options metadata is deliberately
// excluded, and image bytes use pi's flat image convention instead of base64 length.

import {
  builtInHeuristicForModel,
  estimateCharsAsTokens,
  fallbackHeuristicNumbers,
  type HeuristicNumbers,
  type ModelSummary,
} from "./heuristics.ts";

// pi's compaction estimator counts an image as 4800 chars; use the same flat
// convention in canonical and provider-wire forecasts.
export const ESTIMATED_IMAGE_CHARS = 4800;

type PromptFields = {
  system: unknown;
  messages: unknown;
  tools: unknown;
};

export type ProviderPromptForecast = {
  tokens: number;
  heuristic: HeuristicNumbers;
};

function promptFieldChars(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value) && value.length === 0) return 0;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return 0;
  try {
    const serialized = JSON.stringify(value, function (key, nested: unknown) {
      // SAFETY: these are the image carriers used by pi's native messages and the
      // Anthropic, OpenAI, and Google wire shapes. Replacing at serialization keeps
      // multi-megabyte base64 out of both memory accounting and the token estimate.
      const container = this as Record<string, unknown>;
      const imageData = key === "data" && (
        container.type === "image" || container.type === "base64" ||
        typeof container.mimeType === "string" || typeof container.media_type === "string"
      );
      if (key === "image_url" || imageData) return "i".repeat(ESTIMATED_IMAGE_CHARS);
      return nested;
    });
    return serialized?.length;
  } catch {
    // SAFETY: provider payloads are an extension boundary and may be cyclic or contain
    // an unsupported custom value. The caller falls back to canonical-history sizing.
    return undefined;
  }
}

function promptFields(payload: unknown): PromptFields | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  // SAFETY: before_provider_request payloads are unknown by contract. Read only the
  // discriminating prompt keys and validate nested containers before using them.
  const root = payload as Record<string, unknown>;
  if (typeof root.context === "object" && root.context !== null && !Array.isArray(root.context)) {
    const context = root.context as Record<string, unknown>;
    if ("messages" in context || "systemPrompt" in context || "tools" in context) {
      return { system: context.systemPrompt, messages: context.messages, tools: context.tools };
    }
  }
  if ("messages" in root) {
    return { system: root.system, messages: root.messages, tools: root.tools };
  }
  if ("input" in root) {
    return { system: root.instructions, messages: root.input, tools: root.tools };
  }
  if ("contents" in root) {
    return { system: root.systemInstruction, messages: root.contents, tools: root.tools };
  }
  return undefined;
}

/** Estimate the prompt-bearing portion of a recognized provider payload. Unknown or
 * unserializable shapes return undefined so callers can retain their canonical
 * history forecast rather than size arbitrary request metadata. */
export function forecastProviderPrompt(payload: unknown, model: ModelSummary): ProviderPromptForecast | undefined {
  const fields = promptFields(payload);
  if (!fields) return undefined;
  const systemChars = promptFieldChars(fields.system);
  const messageChars = promptFieldChars(fields.messages);
  const toolChars = promptFieldChars(fields.tools);
  if (systemChars === undefined || messageChars === undefined || toolChars === undefined) return undefined;
  const heuristic = builtInHeuristicForModel(model) ?? fallbackHeuristicNumbers();
  return {
    tokens:
      estimateCharsAsTokens(systemChars, heuristic.textDenominator) +
      estimateCharsAsTokens(messageChars, heuristic.sessionDenominator) +
      estimateCharsAsTokens(toolChars, heuristic.toolDenominator),
    heuristic,
  };
}
