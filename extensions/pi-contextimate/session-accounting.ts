import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";

export type SessionBreakdown = {
  thinkingChars: number;
  toolOutputChars: number;
  messageChars: number;
  messageCount: number;
  /** Pi's current total includes a local estimate after the last trusted assistant usage. */
  contextUsageEstimated: boolean;
};

/** The slice of pi's ReadonlySessionManager the session walk needs. */
export type SessionSource = {
  getEntries(): SessionEntry[];
  getLeafId(): string | null;
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function countTextContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (!block || typeof block !== "object") return sum;
    const typed = block as { type?: string; text?: string; data?: string; mimeType?: string };
    if (typed.type === "text") return sum + (typed.text ?? "").length;
    if (typed.type === "image") return sum + `[image:${typed.mimeType ?? "unknown"}:${typed.data?.length ?? 0} chars]`.length;
    return sum;
  }, 0);
}

function countToolCallContent(block: unknown): number {
  if (!block || typeof block !== "object") return 0;
  const toolCall = block as { id?: string; name?: string; arguments?: unknown };
  return safeJson({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }).length;
}

function countReasoningPayload(value: unknown): number {
  if (!value) return 0;
  if (typeof value !== "string") return safeJson(value).length;
  try {
    return safeJson(JSON.parse(value)).length;
  } catch {
    return value.length;
  }
}

export function buildSessionBreakdown(sessionManager?: SessionSource): SessionBreakdown | undefined {
  if (!sessionManager) return undefined;
  // Session entries are arbitrary historical content; a malformed session should cost
  // the session rows, not the whole panel.
  try {
    const { messages } = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId());
    if (messages.length === 0) return undefined;

    const llmMessages = convertToLlm(messages);
    const breakdown: SessionBreakdown = {
      thinkingChars: 0,
      toolOutputChars: 0,
      messageChars: 0,
      messageCount: messages.length,
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
        const usage = message.usage;
        const usageTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (message.stopReason !== "aborted" && message.stopReason !== "error" && usageTokens > 0) {
          lastTrustedUsageIndex = index;
        }
        for (const block of message.content) {
          if (block.type === "thinking") {
            // Claude replays thinking text with its signature, including through relays;
            // the signature is not a text-sized reasoning carrier. OpenAI/Codex replays
            // the signed encrypted payload, so only that family counts its carrier bytes.
            const replaysThinkingText = message.api === "anthropic-messages"
              || message.model.toLowerCase().includes("claude");
            breakdown.thinkingChars += replaysThinkingText
              ? (block.thinking ?? "").length
              : block.thinkingSignature
                ? countReasoningPayload(block.thinkingSignature)
                : (block.thinking ?? "").length;
          } else if (block.type === "toolCall") {
            breakdown.messageChars += countToolCallContent(block);
          } else {
            breakdown.messageChars += countTextContent([block]);
          }
        }
        continue;
      }
      breakdown.messageChars += countTextContent(message.content);
    }

    breakdown.contextUsageEstimated = lastTrustedUsageIndex !== llmMessages.length - 1;
    return breakdown;
  } catch {
    return undefined;
  }
}
