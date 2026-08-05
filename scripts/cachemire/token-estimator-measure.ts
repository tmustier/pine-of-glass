import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonObject } from "../../extensions/_lib/boundary.ts";
import {
  forecastHistoryForTarget,
  forecastTargetPrompt,
  type ForecastMessage,
  type TargetModel,
} from "../../extensions/_lib/forecast.ts";
import {
  builtInHeuristicForModel,
  estimateCharsAsTokens,
  fallbackHeuristicNumbers,
  type HeuristicNumbers,
} from "../../extensions/_lib/heuristics.ts";
import { ESTIMATED_IMAGE_CHARS } from "../../extensions/_lib/provider-prompt.ts";
import {
  aggregateToolPayloadForShape,
  estimateToolListTokens,
  safeMinifiedJson,
  type ToolShape,
} from "../../extensions/_lib/tool-payloads.ts";
import { activeToolShapes } from "../../extensions/pi-cachemire/forecast.ts";

export type CanonicalPromptMeasurement = {
  totalTokens: number;
  flatTokens: number;
  systemTokens: number;
  toolTokens: number;
  historyTokens: number;
  systemChars: number;
  toolChars: number;
  historyTextChars: number;
  historyReasoningChars: number;
  historyImageChars: number;
  messageCount: number;
  activeToolCount: number;
  heuristic: string;
};

export type ProviderPromptMeasurement = {
  shape: "openai-responses" | "anthropic" | "pi-messages";
  systemChars: number;
  systemJsonChars: number;
  toolCount: number;
  toolJsonChars: number;
  messageJsonChars: number;
  messageCount: number;
  textChars: number;
  toolCallChars: number;
  toolResultChars: number;
  readableReasoningChars: number;
  opaqueReasoningChars: number;
  retainedReasoningChars: number;
  imageCount: number;
  imageChars: number;
  roleCounts: Record<string, number>;
  blockCounts: Record<string, number>;
  normalizedHistoryChars: number;
  framingChars: number;
  flatTokens: number;
  normalizedTokens: number;
  normalizedSystemTokens: number;
  normalizedToolTokens: number;
  normalizedHistoryTokens: number;
  heuristic: string;
};

type MutableHistoryMeasurement = {
  messageCount: number;
  textChars: number;
  toolCallChars: number;
  toolResultChars: number;
  readableReasoningChars: number;
  opaqueReasoningChars: number;
  retainedReasoningChars: number;
  imageCount: number;
  roleCounts: Record<string, number>;
  blockCounts: Record<string, number>;
};

type PromptSections = {
  shape: ProviderPromptMeasurement["shape"];
  system: unknown;
  messages: unknown;
  tools: unknown;
};

function emptyHistoryMeasurement(): MutableHistoryMeasurement {
  return {
    messageCount: 0,
    textChars: 0,
    toolCallChars: 0,
    toolResultChars: 0,
    readableReasoningChars: 0,
    opaqueReasoningChars: 0,
    retainedReasoningChars: 0,
    imageCount: 0,
    roleCounts: {},
    blockCounts: {},
  };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function safeRole(value: string | undefined): string {
  return value === "user" || value === "assistant" || value === "system" ||
    value === "developer" || value === "toolResult" ? value : "other";
}

function safeBlockType(value: string | undefined): string {
  const known = [
    "message", "text", "input_text", "output_text", "input_image", "image", "document",
    "reasoning", "thinking", "redacted_thinking", "toolCall", "tool_use", "tool_result",
    "function_call", "function_call_output", "refusal", "other",
  ];
  return value !== undefined && known.includes(value) ? value : "other";
}

function stringField(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function safeJsonChars(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value, function (key, nested: unknown) {
      // SAFETY: provider payloads are an unknown JSON boundary. These predicates cover
      // Pi's image carriers and keep base64 size out of aggregate study measurements.
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
    return undefined;
  }
}

function countTextValue(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTextValue(item), 0);
  if (!isJsonObject(value)) return 0;
  if (typeof value.text === "string") return value.text.length;
  return 0;
}

function toolCallChars(id: unknown, name: unknown, args: unknown): number {
  let parsedArgs = args;
  if (typeof args === "string") {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      // Keep provider arguments that are incomplete or not JSON.
    }
  }
  return safeMinifiedJson({ id, name, arguments: parsedArgs }).length;
}

function measureOpenAIHistory(messages: unknown): MutableHistoryMeasurement {
  const history = emptyHistoryMeasurement();
  for (const item of objectList(messages)) {
    const type = stringField(item, "type");
    const role = stringField(item, "role");
    if (role !== undefined) {
      history.messageCount++;
      bump(history.roleCounts, safeRole(role));
      bump(history.blockCounts, "message");
    } else {
      bump(history.blockCounts, safeBlockType(type));
    }
    if (type === "function_call") {
      history.toolCallChars += toolCallChars(item.call_id ?? item.id, item.name, item.arguments);
      continue;
    }
    if (type === "function_call_output") {
      history.toolResultChars += countTextValue(item.output);
      continue;
    }
    if (type === "reasoning") {
      const opaque = stringField(item, "encrypted_content")?.length ?? 0;
      const readable = countTextValue(item.summary);
      history.opaqueReasoningChars += opaque;
      history.readableReasoningChars += readable;
      history.retainedReasoningChars += opaque > 0 ? opaque : readable;
      continue;
    }
    const content = item.content;
    if (typeof content === "string") {
      history.textChars += content.length;
      continue;
    }
    for (const block of objectList(content)) {
      const blockType = stringField(block, "type") ?? "";
      bump(history.blockCounts, safeBlockType(blockType));
      if (blockType.includes("image")) history.imageCount++;
      else if (typeof block.text === "string") history.textChars += block.text.length;
      else if (typeof block.refusal === "string") history.textChars += block.refusal.length;
    }
  }
  return history;
}

function measureAnthropicContent(history: MutableHistoryMeasurement, content: unknown, toolResult = false): void {
  if (typeof content === "string") {
    if (toolResult) history.toolResultChars += content.length;
    else history.textChars += content.length;
    return;
  }
  for (const block of objectList(content)) {
    const type = stringField(block, "type") ?? "";
    bump(history.blockCounts, safeBlockType(type));
    if (type === "text") {
      const chars = stringField(block, "text")?.length ?? 0;
      if (toolResult) history.toolResultChars += chars;
      else history.textChars += chars;
    } else if (type === "thinking") {
      const readable = stringField(block, "thinking")?.length ?? 0;
      const opaque = stringField(block, "signature")?.length ?? 0;
      history.readableReasoningChars += readable;
      history.opaqueReasoningChars += opaque;
      history.retainedReasoningChars += opaque > 0 ? opaque : readable;
    } else if (type === "redacted_thinking") {
      const opaque = stringField(block, "data")?.length ?? 0;
      history.opaqueReasoningChars += opaque;
      history.retainedReasoningChars += opaque;
    } else if (type === "tool_use") {
      history.toolCallChars += toolCallChars(block.id, block.name, block.input);
    } else if (type === "tool_result") {
      measureAnthropicContent(history, block.content, true);
    } else if (type === "image" || type === "document") {
      history.imageCount++;
    }
  }
}

function measureAnthropicHistory(messages: unknown): MutableHistoryMeasurement {
  const history = emptyHistoryMeasurement();
  for (const message of objectList(messages)) {
    history.messageCount++;
    bump(history.roleCounts, safeRole(stringField(message, "role")));
    measureAnthropicContent(history, message.content);
  }
  return history;
}

function measurePiContent(history: MutableHistoryMeasurement, content: unknown, toolResult = false): void {
  if (typeof content === "string") {
    if (toolResult) history.toolResultChars += content.length;
    else history.textChars += content.length;
    return;
  }
  for (const block of objectList(content)) {
    const type = stringField(block, "type") ?? "";
    bump(history.blockCounts, safeBlockType(type));
    if (type === "text") {
      const chars = stringField(block, "text")?.length ?? 0;
      if (toolResult) history.toolResultChars += chars;
      else history.textChars += chars;
    } else if (type === "thinking") {
      const readable = stringField(block, "thinking")?.length ?? 0;
      const opaque = stringField(block, "thinkingSignature")?.length ?? 0;
      history.readableReasoningChars += readable;
      history.opaqueReasoningChars += opaque;
      history.retainedReasoningChars += opaque > 0 ? opaque : readable;
    } else if (type === "toolCall") {
      history.toolCallChars += toolCallChars(block.id, block.name, block.arguments);
      const opaque = stringField(block, "thoughtSignature")?.length ?? 0;
      history.opaqueReasoningChars += opaque;
      history.retainedReasoningChars += opaque;
    } else if (type === "image") {
      history.imageCount++;
    }
  }
}

function measurePiHistory(messages: unknown): MutableHistoryMeasurement {
  const history = emptyHistoryMeasurement();
  for (const message of objectList(messages)) {
    history.messageCount++;
    const role = stringField(message, "role");
    bump(history.roleCounts, safeRole(role));
    measurePiContent(history, message.content, role === "toolResult");
  }
  return history;
}

function promptSections(payload: unknown): PromptSections | undefined {
  if (!isJsonObject(payload)) return undefined;
  if (isJsonObject(payload.context)) {
    const context = payload.context;
    if ("messages" in context || "systemPrompt" in context || "tools" in context) {
      return { shape: "pi-messages", system: context.systemPrompt ?? "", messages: context.messages ?? [], tools: context.tools ?? [] };
    }
  }
  if ("input" in payload) {
    return { shape: "openai-responses", system: payload.instructions ?? "", messages: payload.input, tools: payload.tools ?? [] };
  }
  if ("messages" in payload) {
    return { shape: "anthropic", system: payload.system ?? "", messages: payload.messages, tools: payload.tools ?? [] };
  }
  return undefined;
}

function systemTextChars(system: unknown): number {
  if (typeof system === "string") return system.length;
  return objectList(system).reduce((sum, block) => sum + (stringField(block, "text")?.length ?? 0), 0);
}

function parseToolShape(value: JsonObject): ToolShape | undefined {
  const spec = isJsonObject(value.function) ? value.function : value;
  const name = stringField(spec, "name");
  if (name === undefined) return undefined;
  return {
    name,
    description: stringField(spec, "description") ?? "",
    schema: spec.parameters ?? spec.input_schema ?? {},
  };
}

function parseTools(value: unknown): { count: number; shapes: ToolShape[] } {
  const tools = objectList(value);
  return { count: tools.length, shapes: tools.map(parseToolShape).filter((tool): tool is ToolShape => tool !== undefined) };
}

function flatToolPayload(tools: ToolShape[], target: TargetModel): unknown {
  if (target.api === "anthropic-messages") {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      eager_input_streaming: true,
      input_schema: tool.schema,
    }));
  }
  if (target.api === "pi-messages") return aggregateToolPayloadForShape(tools, "raw-schema");
  return aggregateToolPayloadForShape(tools, "openai-responses");
}

export function measureCanonicalPrompt(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: Pick<ExtensionContext, "sessionManager" | "getSystemPrompt">,
  target: TargetModel,
): CanonicalPromptMeasurement {
  const history = convertToLlm(
    buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
  ) as unknown as ForecastMessage[];
  const tools = activeToolShapes(pi);
  const systemChars = ctx.getSystemPrompt().length;
  const historyCounts = forecastHistoryForTarget(history, target);
  const system = forecastTargetPrompt({ history: [], systemPromptChars: systemChars, tools: [], target });
  const staticPrompt = forecastTargetPrompt({ history: [], systemPromptChars: systemChars, tools, target });
  const total = forecastTargetPrompt({ history, systemPromptChars: systemChars, tools, target });
  const toolChars = safeMinifiedJson(flatToolPayload(tools, target)).length;
  const flatChars = systemChars + toolChars + historyCounts.textChars + historyCounts.keptReasoningChars + historyCounts.imageChars;
  return {
    totalTokens: total.tokens,
    flatTokens: estimateCharsAsTokens(flatChars, 4),
    systemTokens: system.tokens,
    toolTokens: staticPrompt.tokens - system.tokens,
    historyTokens: total.tokens - staticPrompt.tokens,
    systemChars,
    toolChars,
    historyTextChars: historyCounts.textChars,
    historyReasoningChars: historyCounts.keptReasoningChars,
    historyImageChars: historyCounts.imageChars,
    messageCount: history.length,
    activeToolCount: tools.length,
    heuristic: total.heuristic.label,
  };
}

export function measureProviderPrompt(payload: unknown, model: TargetModel): ProviderPromptMeasurement | undefined {
  const sections = promptSections(payload);
  if (sections === undefined) return undefined;
  const systemChars = systemTextChars(sections.system);
  const systemJsonChars = safeJsonChars(sections.system);
  const toolJsonChars = safeJsonChars(sections.tools);
  const messageJsonChars = safeJsonChars(sections.messages);
  if (systemJsonChars === undefined || toolJsonChars === undefined || messageJsonChars === undefined) return undefined;
  const history = sections.shape === "openai-responses"
    ? measureOpenAIHistory(sections.messages)
    : sections.shape === "pi-messages"
      ? measurePiHistory(sections.messages)
      : measureAnthropicHistory(sections.messages);
  const tools = parseTools(sections.tools);
  const heuristic: HeuristicNumbers = builtInHeuristicForModel(model) ?? fallbackHeuristicNumbers();
  const imageChars = history.imageCount * ESTIMATED_IMAGE_CHARS;
  const normalizedHistoryChars = history.textChars + history.toolCallChars + history.toolResultChars +
    history.retainedReasoningChars + imageChars;
  const normalizedSystemTokens = estimateCharsAsTokens(systemChars, heuristic.textDenominator);
  const normalizedHistoryTokens = estimateCharsAsTokens(normalizedHistoryChars, heuristic.sessionDenominator);
  const normalizedToolTokens = tools.shapes.length === tools.count
    ? estimateToolListTokens(tools.shapes, heuristic)
    : estimateCharsAsTokens(toolJsonChars, heuristic.toolDenominator);
  const flatTokens = estimateCharsAsTokens(systemChars + normalizedHistoryChars + toolJsonChars, 4);
  const semanticJsonComparableChars = systemChars + normalizedHistoryChars + toolJsonChars;
  return {
    shape: sections.shape,
    systemChars,
    systemJsonChars,
    toolCount: tools.count,
    toolJsonChars,
    messageJsonChars,
    messageCount: history.messageCount,
    textChars: history.textChars,
    toolCallChars: history.toolCallChars,
    toolResultChars: history.toolResultChars,
    readableReasoningChars: history.readableReasoningChars,
    opaqueReasoningChars: history.opaqueReasoningChars,
    retainedReasoningChars: history.retainedReasoningChars,
    imageCount: history.imageCount,
    imageChars,
    roleCounts: history.roleCounts,
    blockCounts: history.blockCounts,
    normalizedHistoryChars,
    framingChars: Math.max(0, systemJsonChars + messageJsonChars + toolJsonChars - semanticJsonComparableChars),
    flatTokens,
    normalizedTokens: normalizedSystemTokens + normalizedToolTokens + normalizedHistoryTokens,
    normalizedSystemTokens,
    normalizedToolTokens,
    normalizedHistoryTokens,
    heuristic: heuristic.label,
  };
}
