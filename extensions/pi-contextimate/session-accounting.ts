import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { codexUsageOmitsHistoricalReasoning, keepsAllClaudeThinking } from "./model-heuristics.ts";

const OPENAI_REASONING_REPLAY_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);
const GOOGLE_REASONING_REPLAY_APIS = new Set(["google-generative-ai", "google-vertex"]);

export type SessionBreakdown = {
  thinkingSummaryChars: number;
  /** Exact provider-reported reasoning carried by the active request history. */
  reasoningTokens?: number;
  /** Exact historical reasoning that OpenAI Codex adds outside its reported total. */
  providerOmittedReasoningTokens?: number;
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

export function accountProviderContext(
  session: SessionBreakdown | undefined,
  tokens: number | null | undefined,
): { tokens: number; corrected: boolean } | undefined {
  if (typeof tokens !== "number") return undefined;
  const omitted = session?.providerOmittedReasoningTokens ?? 0;
  return { tokens: tokens + omitted, corrected: omitted > 0 };
}

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
  const accountedContext = accountProviderContext(session, options.contextTokens);
  const piTotal = accountedContext
    ? Math.max(0, Math.round(accountedContext.tokens - options.harnessTokens))
    : undefined;
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

function countTextContent(content: string | Array<TextContent | ImageContent>): number {
  if (typeof content === "string") return content.length;
  return content.reduce(
    (sum, block) => sum + (block.type === "text"
      ? block.text.length
      : `[image:${block.mimeType}:${block.data.length} chars]`.length),
    0,
  );
}

function sameModel(left: AssistantMessage, right: AssistantMessage): boolean {
  return left.provider === right.provider && left.api === right.api && left.model === right.model;
}

function validGoogleSignature(signature: string | undefined): boolean {
  return Boolean(signature && signature.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(signature));
}

function hasEncryptedOpenAIReasoning(signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const item: unknown = JSON.parse(signature);
    if (!item || typeof item !== "object") return false;
    const encryptedContent = (item as { encrypted_content?: unknown }).encrypted_content;
    return typeof encryptedContent === "string" && encryptedContent.length > 0;
  } catch {
    return false;
  }
}

function hasReasoningCarrier(message: AssistantMessage): boolean {
  if (GOOGLE_REASONING_REPLAY_APIS.has(message.api)) {
    return message.content.some((block) => {
      if (block.type === "thinking") return validGoogleSignature(block.thinkingSignature);
      if (block.type === "toolCall") return validGoogleSignature(block.thoughtSignature);
      return validGoogleSignature(block.textSignature);
    });
  }
  if (OPENAI_REASONING_REPLAY_APIS.has(message.api)) {
    return message.content.some((block) => block.type === "thinking"
      && hasEncryptedOpenAIReasoning(block.thinkingSignature));
  }
  return message.content.some((block) => block.type === "thinking" && Boolean(block.thinkingSignature));
}

function hasTrustedUsage(message: AssistantMessage): boolean {
  const usage = message.usage;
  return message.stopReason !== "aborted" && message.stopReason !== "error"
    && (usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite) > 0;
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
    let lastTrustedUsageIndex = llmMessages.length - 1;
    while (lastTrustedUsageIndex >= 0) {
      const message = llmMessages[lastTrustedUsageIndex]!;
      if (message.role === "assistant" && hasTrustedUsage(message)) break;
      lastTrustedUsageIndex--;
    }

    // Measured GPT-5.3 to GPT-5.5 Codex usage omits prior-turn reasoning.
    const exactReasoningIndices = new Set<number>();
    const strippedThinkingIndices = new Set<number>();
    let exactReasoningTokens = 0;
    let providerOmittedReasoningTokens = 0;
    const anchor = llmMessages[lastTrustedUsageIndex];
    if (anchor?.role === "assistant") {
      let turnStart = 0;
      for (let index = 0; index < lastTrustedUsageIndex; index++) {
        if (llmMessages[index]!.role === "user") turnStart = index + 1;
      }
      const anchorIsClaude = anchor.api === "anthropic-messages"
        || anchor.model.toLowerCase().includes("claude");
      const anchorIsOpenAI = OPENAI_REASONING_REPLAY_APIS.has(anchor.api);
      const anchorIsGoogle = GOOGLE_REASONING_REPLAY_APIS.has(anchor.api);
      const keepsRetainedHistory = anchorIsClaude
        ? keepsAllClaudeThinking(anchor.model)
        : anchorIsOpenAI || anchorIsGoogle;
      const historyStart = keepsRetainedHistory ? 0 : anchorIsClaude ? turnStart : lastTrustedUsageIndex;
      for (let index = 0; index <= lastTrustedUsageIndex; index++) {
        const message = llmMessages[index]!;
        if (message.role !== "assistant" || !hasTrustedUsage(message) || !sameModel(message, anchor)) continue;
        if (index < historyStart) {
          if (anchorIsClaude) strippedThinkingIndices.add(index);
          continue;
        }
        if (index !== lastTrustedUsageIndex && !hasReasoningCarrier(message)) continue;
        const tokens = message.usage.reasoning;
        if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) continue;
        exactReasoningTokens += tokens;
        exactReasoningIndices.add(index);
        if (index < turnStart && anchor.provider === "openai-codex"
          && anchor.api === "openai-codex-responses"
          && codexUsageOmitsHistoricalReasoning(anchor.model)) {
          providerOmittedReasoningTokens += tokens;
        }
      }
    }
    if (exactReasoningIndices.size > 0) breakdown.reasoningTokens = exactReasoningTokens;
    if (providerOmittedReasoningTokens > 0) {
      breakdown.providerOmittedReasoningTokens = providerOmittedReasoningTokens;
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
            // Estimate summaries only when no exact token count covers them.
            const claudeSummary = message.api === "anthropic-messages"
              || message.model.toLowerCase().includes("claude");
            const plainSummary = !block.thinkingSignature;
            if (!strippedThinkingIndices.has(index) && !exactReasoningIndices.has(index)
              && !block.redacted && (claudeSummary || plainSummary)) {
              breakdown.thinkingSummaryChars += (block.thinking ?? "").length;
            }
          } else if (block.type === "toolCall") {
            breakdown.messageChars += JSON.stringify({
              id: block.id,
              name: block.name,
              arguments: block.arguments,
            }, null, 2).length;
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
