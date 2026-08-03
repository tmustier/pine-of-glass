import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelSummary } from "../_lib/heuristics.ts";
import { keepsAllClaudeThinking, keepsAllOpenAIReasoning } from "./model-heuristics.ts";

const OPENAI_REASONING_REPLAY_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

export type SessionBreakdown = {
  thinkingSummaryChars: number;
  /** Exact reported reasoning retained in the provider usage anchoring Pi's total. */
  reasoningTokens?: number;
  toolOutputChars: number;
  messageChars: number;
  messageCount: number;
  /** Pi's current total includes a local estimate after the last trusted assistant usage. */
  contextUsageEstimated: boolean;
};

export type SessionScan = {
  breakdown?: SessionBreakdown;
  /** Identity behind the last assistant usage that Pi trusts for its context total. */
  lastBilled?: ModelSummary;
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

function reportedReasoning(message: AssistantMessage): number | undefined {
  const tokens = message.usage.reasoning;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
}

function hasTrustedUsage(message: AssistantMessage): boolean {
  const usage = message.usage;
  const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return message.stopReason !== "aborted" && message.stopReason !== "error" && tokens > 0;
}

function sameModel(left: AssistantMessage, right: AssistantMessage): boolean {
  return left.provider === right.provider && left.api === right.api && left.model === right.model;
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
  if (OPENAI_REASONING_REPLAY_APIS.has(message.api)) {
    return message.content.some((block) => block.type === "thinking"
      && hasEncryptedOpenAIReasoning(block.thinkingSignature));
  }
  return message.content.some((block) => block.type === "thinking" && Boolean(block.thinkingSignature));
}

export function scanSession(sessionManager?: SessionSource): SessionScan {
  if (!sessionManager) return {};
  // Session entries are arbitrary historical content; a malformed session should cost
  // the session rows, not the whole panel.
  try {
    const { messages } = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId());
    if (messages.length === 0) return {};

    const llmMessages = convertToLlm(messages);
    const breakdown: SessionBreakdown = {
      thinkingSummaryChars: 0,
      toolOutputChars: 0,
      messageChars: 0,
      messageCount: messages.length,
      contextUsageEstimated: true,
    };
    const trustedAssistantIndices: number[] = [];
    let lastTrustedUsageIndex = -1;
    for (let index = 0; index < llmMessages.length; index++) {
      const message = llmMessages[index]!;
      if (message.role === "assistant" && hasTrustedUsage(message)) {
        trustedAssistantIndices.push(index);
        lastTrustedUsageIndex = index;
      }
    }
    let lastTrustedContextIndex = -1;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      if (message.role === "assistant" && hasTrustedUsage(message)) lastTrustedContextIndex = index;
    }

    // Pi reports generated reasoning per response and the next prompt only as one aggregate.
    // Signed replay carriers plus each provider's effective retention policy identify the
    // historical exact counts; the aggregate prompt total is the final conservation check.
    const exactReasoningIndices = new Set<number>();
    const historicalReasoningIndices = new Set<number>();
    const strippedThinkingIndices = new Set<number>();
    let exactReasoningTokens = 0;
    let historicalReasoningTokens = 0;
    let hasExactReasoning = false;
    const anchor = llmMessages[lastTrustedUsageIndex];
    if (anchor?.role === "assistant") {
      let turnStart = 0;
      for (let index = 0; index < lastTrustedUsageIndex; index++) {
        if (llmMessages[index]!.role === "user") turnStart = index + 1;
      }
      const anchorIsClaude = anchor.api === "anthropic-messages"
        || anchor.model.toLowerCase().includes("claude");
      const anchorIsOpenAI = OPENAI_REASONING_REPLAY_APIS.has(anchor.api);
      const keepsRetainedHistory = anchorIsClaude
        ? keepsAllClaudeThinking(anchor.model)
        : anchorIsOpenAI && keepsAllOpenAIReasoning(anchor.model);
      const keepsCurrentTurn = anchorIsClaude || anchorIsOpenAI;
      const historyStart = keepsRetainedHistory ? 0 : keepsCurrentTurn ? turnStart : lastTrustedUsageIndex;
      for (const index of trustedAssistantIndices) {
        const message = llmMessages[index]!;
        if (message.role !== "assistant" || !sameModel(message, anchor)) continue;
        if (index < historyStart) {
          if (anchorIsClaude) strippedThinkingIndices.add(index);
          continue;
        }
        if (index !== lastTrustedUsageIndex && !hasReasoningCarrier(message)) continue;
        const tokens = reportedReasoning(message);
        if (tokens === undefined) continue;
        exactReasoningTokens += tokens;
        hasExactReasoning = true;
        exactReasoningIndices.add(index);
        if (index !== lastTrustedUsageIndex) {
          historicalReasoningTokens += tokens;
          historicalReasoningIndices.add(index);
        }
      }
      const promptBuckets = anchor.usage.input + anchor.usage.cacheRead + anchor.usage.cacheWrite;
      const reportedPromptTokens = Math.max(promptBuckets, anchor.usage.totalTokens - anchor.usage.output, 0);
      if (historicalReasoningTokens > reportedPromptTokens) {
        exactReasoningTokens -= historicalReasoningTokens;
        for (const index of historicalReasoningIndices) exactReasoningIndices.delete(index);
        hasExactReasoning = exactReasoningIndices.size > 0;
      }
    }
    if (hasExactReasoning) breakdown.reasoningTokens = exactReasoningTokens;

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
            // Estimate summaries only when exact retained reasoning does not already
            // cover the block; opaque signatures are never treated as token-sized text.
            const claudeSummary = message.api === "anthropic-messages"
              || message.model.toLowerCase().includes("claude");
            const plainSummary = !block.thinkingSignature;
            const crossModelSummary = anchor?.role === "assistant" && !sameModel(message, anchor);
            if (!strippedThinkingIndices.has(index) && !exactReasoningIndices.has(index)
              && !block.redacted && (claudeSummary || plainSummary || crossModelSummary)) {
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

    // Pi estimates every raw context message after the last trusted usage, including
    // `!!` bash messages that convertToLlm deliberately omits from provider context.
    breakdown.contextUsageEstimated = lastTrustedContextIndex !== messages.length - 1;
    const lastBilled = anchor?.role === "assistant"
      && typeof anchor.provider === "string"
      && typeof anchor.model === "string"
      && typeof anchor.api === "string"
      ? { provider: anchor.provider, id: anchor.model, api: anchor.api }
      : undefined;
    return { breakdown, lastBilled };
  } catch {
    return {};
  }
}

export function buildSessionBreakdown(sessionManager?: SessionSource): SessionBreakdown | undefined {
  return scanSession(sessionManager).breakdown;
}
