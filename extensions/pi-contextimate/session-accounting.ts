import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { codexNeedsReasoningCorrection } from "./model-heuristics.ts";

export type SessionBreakdown = {
  toolOutputChars: number;
  messageChars: number;
  providerOmittedReasoningTokens?: number;
  contextUsageEstimated: boolean;
};

export type SessionEstimate = {
  totalTokens: number;
  totalSource: "pi" | "heuristic";
  toolOutputTokens: number;
  messageTokens: number;
  otherTokens: number;
  denominator: number;
};

export function correctedContextTokens(
  session: SessionBreakdown | undefined,
  tokens: number | null | undefined,
): number | undefined {
  return typeof tokens === "number" ? tokens + (session?.providerOmittedReasoningTokens ?? 0) : undefined;
}

export function estimateSessionBreakdown(
  session: SessionBreakdown,
  options: { denominator: number; harnessTokens: number; contextTokens?: number | null },
): SessionEstimate {
  const estimate = (chars: number) => Math.ceil(chars / options.denominator);
  const toolOutputTokens = estimate(session.toolOutputChars);
  const messageTokens = estimate(session.messageChars);
  const piTokens = correctedContextTokens(session, options.contextTokens);
  const totalTokens = piTokens === undefined
    ? estimate(session.toolOutputChars + session.messageChars)
    : Math.max(0, Math.round(piTokens - options.harnessTokens));
  return {
    totalTokens,
    totalSource: piTokens === undefined ? "heuristic" : "pi",
    toolOutputTokens,
    messageTokens,
    otherTokens: Math.max(0, Math.round(totalTokens - toolOutputTokens - messageTokens)),
    denominator: options.denominator,
  };
}

/** The slice of pi's ReadonlySessionManager the session walk needs. */
export type SessionSource = {
  getEntries(): SessionEntry[];
  getLeafId(): string | null;
};

function countTextContent(content: string | Array<TextContent | ImageContent>): number {
  if (typeof content === "string") return content.length;
  return content.reduce(
    (sum, block) => sum + (block.type === "text"
      ? block.text.length
      : `[image:${block.mimeType}:${block.data.length} chars]`.length),
    0,
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function sameModel(left: AssistantMessage, right: AssistantMessage): boolean {
  return left.provider === right.provider && left.api === right.api && left.model === right.model;
}

function hasTrustedUsage(message: AssistantMessage): boolean {
  const usage = message.usage;
  return message.stopReason !== "aborted" && message.stopReason !== "error"
    && (usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite) > 0;
}

export function buildSessionBreakdown(sessionManager?: SessionSource): SessionBreakdown | undefined {
  if (!sessionManager) return undefined;
  try {
    const { messages } = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId());
    if (messages.length === 0) return undefined;

    const llmMessages = convertToLlm(messages);
    const breakdown: SessionBreakdown = {
      toolOutputChars: 0,
      messageChars: 0,
      contextUsageEstimated: true,
    };
    let lastTrustedUsageIndex = -1;

    for (let index = 0; index < llmMessages.length; index++) {
      const message = llmMessages[index]!;
      if (message.role === "toolResult") {
        breakdown.toolOutputChars += countTextContent(message.content);
        continue;
      }
      if (message.role === "assistant") {
        if (hasTrustedUsage(message)) lastTrustedUsageIndex = index;
        for (const block of message.content) {
          if (block.type === "toolCall") {
            breakdown.messageChars += safeJson({
              id: block.id,
              name: block.name,
              arguments: block.arguments,
            }).length;
          } else if (block.type !== "thinking") {
            breakdown.messageChars += countTextContent([block]);
          }
        }
        continue;
      }
      breakdown.messageChars += countTextContent(message.content);
    }

    const anchor = llmMessages[lastTrustedUsageIndex];
    if (anchor?.role === "assistant" && anchor.provider === "openai-codex"
      && anchor.api === "openai-codex-responses" && codexNeedsReasoningCorrection(anchor.model)) {
      let lastUserIndex = -1;
      for (let index = lastTrustedUsageIndex - 1; index >= 0; index--) {
        if (llmMessages[index]!.role === "user") {
          lastUserIndex = index;
          break;
        }
      }

      let omitted = 0;
      for (let index = 0; index < lastUserIndex; index++) {
        const message = llmMessages[index]!;
        if (message.role !== "assistant" || !hasTrustedUsage(message) || !sameModel(message, anchor)) continue;
        const reasoning = message.usage.reasoning;
        if (typeof reasoning !== "number" || !Number.isFinite(reasoning) || reasoning < 0) continue;
        const hasEncryptedReasoning = message.content.some((block) => {
          if (block.type !== "thinking" || !block.thinkingSignature) return false;
          try {
            const item: unknown = JSON.parse(block.thinkingSignature);
            const encrypted = item && typeof item === "object"
              ? (item as { encrypted_content?: unknown }).encrypted_content
              : undefined;
            return typeof encrypted === "string" && encrypted.length > 0;
          } catch {
            return false;
          }
        });
        if (hasEncryptedReasoning) omitted += reasoning;
      }
      if (omitted > 0) breakdown.providerOmittedReasoningTokens = omitted;
    }

    breakdown.contextUsageEstimated = lastTrustedUsageIndex !== llmMessages.length - 1;
    return breakdown;
  } catch {
    return undefined;
  }
}
