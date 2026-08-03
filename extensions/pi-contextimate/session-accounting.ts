import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";

export type SessionBreakdown = {
  thinkingSummaryChars: number;
  /** Exact provider-reported reasoning for the assistant usage anchoring Pi's total. */
  reasoningTokens?: number;
  toolOutputChars: number;
  messageChars: number;
  messageCount: number;
  /** Pi's current total includes a local estimate after the last trusted assistant usage. */
  contextUsageEstimated: boolean;
};

export type SessionEstimate = {
  totalTokens: number;
  totalSource: "pi" | "heuristic";
  toolOutputTokens: number;
  messageTokens: number;
  thinkingSummaryTokens: number;
  reasoningTokens?: number;
  unattributedTokens: number;
  denominator: number;
};

export function estimateSessionBreakdown(
  session: SessionBreakdown,
  options: { denominator: number; harnessTokens: number; contextTokens?: number | null },
): SessionEstimate {
  const estimate = (chars: number) => Math.ceil(chars / options.denominator);
  const toolOutputTokens = estimate(session.toolOutputChars);
  const messageTokens = estimate(session.messageChars);
  const thinkingSummaryTokens = estimate(session.thinkingSummaryChars);
  const attributedTokens = toolOutputTokens + messageTokens + thinkingSummaryTokens + (session.reasoningTokens ?? 0);
  const heuristicTotal = estimate(session.toolOutputChars + session.messageChars + session.thinkingSummaryChars)
    + (session.reasoningTokens ?? 0);
  const piTotal = options.contextTokens === null || options.contextTokens === undefined
    ? undefined
    : Math.max(0, Math.round(options.contextTokens - options.harnessTokens));
  const totalTokens = piTotal ?? heuristicTotal;
  return {
    totalTokens,
    totalSource: piTotal === undefined ? "heuristic" : "pi",
    toolOutputTokens,
    messageTokens,
    thinkingSummaryTokens,
    reasoningTokens: session.reasoningTokens,
    unattributedTokens: Math.max(0, Math.round(totalTokens - attributedTokens)),
    denominator: options.denominator,
  };
}

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

export function buildSessionBreakdown(sessionManager?: SessionSource): SessionBreakdown | undefined {
  if (!sessionManager) return undefined;
  // Session entries are arbitrary historical content; a malformed session should cost
  // the session rows, not the whole panel.
  try {
    const { messages } = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId());
    if (messages.length === 0) return undefined;

    const llmMessages = convertToLlm(messages);
    const breakdown: SessionBreakdown = {
      thinkingSummaryChars: 0,
      toolOutputChars: 0,
      messageChars: 0,
      messageCount: messages.length,
      contextUsageEstimated: true,
    };
    let lastTrustedUsageIndex = -1;
    for (let index = 0; index < llmMessages.length; index++) {
      const message = llmMessages[index]!;
      if (message.role !== "assistant") continue;
      const usage = message.usage;
      const usageTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (message.stopReason !== "aborted" && message.stopReason !== "error" && usageTokens > 0) {
        lastTrustedUsageIndex = index;
      }
    }
    if (lastTrustedUsageIndex >= 0) {
      const anchored = llmMessages[lastTrustedUsageIndex]!;
      if (anchored.role === "assistant" && typeof anchored.usage.reasoning === "number"
        && Number.isFinite(anchored.usage.reasoning) && anchored.usage.reasoning >= 0) {
        breakdown.reasoningTokens = anchored.usage.reasoning;
      }
    }

    for (let index = 0; index < llmMessages.length; index++) {
      const message = llmMessages[index]!;
      if (message.role === "toolResult") {
        breakdown.toolOutputChars += countTextContent(message.content);
        continue;
      }
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "thinking") {
            // Thinking text is a provider-generated summary, not the full reasoning.
            // Earlier Claude summaries are replayed as context; opaque signatures are
            // never treated as token-sized text. When reported, the anchored response
            // uses exact usage.reasoning instead, avoiding a second summary estimate.
            const claudeSummary = message.api === "anthropic-messages"
              || message.model.toLowerCase().includes("claude");
            const plainSummary = !block.thinkingSignature;
            const coveredByExactReasoning = index === lastTrustedUsageIndex
              && breakdown.reasoningTokens !== undefined;
            if (!coveredByExactReasoning && !block.redacted && (claudeSummary || plainSummary)) {
              breakdown.thinkingSummaryChars += (block.thinking ?? "").length;
            }
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
