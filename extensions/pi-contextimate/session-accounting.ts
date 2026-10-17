import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelSummary } from "../_lib/heuristics.ts";
import { keepsAllClaudeThinking, keepsAllOpenAIReasoning } from "../_lib/heuristics.ts";

import { countTextContent, countToolCallContent } from "./message-size.ts";
import { accountingSession } from "./request-messages.ts";

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
  /** Additions in the request behind the latest trusted usage, not saved messages. */
  requestOnly?: { chars: number };
  messageCount: number;
  /** Pi's current total includes a local estimate after the last trusted assistant usage. */
  contextUsageEstimated: boolean;
  /** Provider-measured prompt growth attributed to tool results, in the anchor model's tokens. */
  measuredToolOutputTokens: number;
  /** Characters of the tool results that `measuredToolOutputTokens` covers. */
  measuredToolOutputChars: number;
  /** The first request's exact prompt, present only while the cache proves every later
   * request up to the anchor reused it unchanged. */
  firstPrompt?: { tokens: number; preludeChars: number };
};

export type SessionScan = {
  breakdown?: SessionBreakdown;
  /** Identity behind the last assistant usage that Pi trusts for its context total. */
  lastBilled?: ModelSummary;
};

export type SessionEstimate = {
  totalTokens: number;
  totalSource: "pi" | "heuristic";
  harnessTokens: number;
  harnessSource: "measured" | "estimate";
  toolOutputTokens: number;
  messageTokens: number;
  requestOnlyTokens: number;
  thinkingSummaryTokens: number;
  reasoningTokens?: number;
  unattributedTokens: number;
  denominator: number;
};

// A first message larger than this makes the harness measurement mostly estimate.
const MAX_PRELUDE_TOKENS = 4096; // agent-default (not a user rule): 2026-09-28

export function estimateSessionBreakdown(
  session: SessionBreakdown,
  options: { denominator: number; harnessTokens: number; contextTokens?: number | null },
): SessionEstimate {
  const estimate = (chars: number) => Math.ceil(chars / options.denominator);
  const unmeasuredToolChars = Math.max(0, session.toolOutputChars - session.measuredToolOutputChars);
  const toolOutputTokens = session.measuredToolOutputTokens + estimate(unmeasuredToolChars);
  const messageTokens = estimate(session.messageChars);
  const requestOnlyTokens = estimate(session.requestOnly?.chars ?? 0);
  const thinkingSummaryTokens = estimate(session.thinkingSummaryChars);
  const attributedTokens = toolOutputTokens + messageTokens + requestOnlyTokens + thinkingSummaryTokens + (session.reasoningTokens ?? 0);
  const preludeTokens = estimate(session.firstPrompt?.preludeChars ?? 0);
  const measuredHarness = session.firstPrompt && preludeTokens <= MAX_PRELUDE_TOKENS
    ? session.firstPrompt.tokens - preludeTokens
    : undefined;
  const harnessTokens = measuredHarness ?? options.harnessTokens;
  const piTotal = options.contextTokens === null || options.contextTokens === undefined
    ? undefined
    : Math.max(0, Math.round(options.contextTokens - harnessTokens));
  const totalTokens = piTotal ?? attributedTokens;
  return {
    totalTokens,
    totalSource: piTotal === undefined ? "heuristic" : "pi",
    harnessTokens,
    harnessSource: measuredHarness === undefined ? "estimate" : "measured",
    toolOutputTokens,
    messageTokens,
    requestOnlyTokens,
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

// Codex caches in blocks, so a reused prompt's cache read can stop a few hundred tokens short.
const CACHE_PREFIX_SLACK_TOKENS = 2048; // agent-default (not a user rule): 2026-09-28

function promptTokens(message: AssistantMessage): number {
  const usage = message.usage;
  return Math.max(usage.input + usage.cacheRead + usage.cacheWrite, usage.totalTokens - usage.output, 0);
}

function reusedPrompt(previous: AssistantMessage, next: AssistantMessage): boolean {
  return promptTokens(previous) - next.usage.cacheRead <= CACHE_PREFIX_SLACK_TOKENS;
}

function hasReasoningCarrier(message: AssistantMessage): boolean {
  if (OPENAI_REASONING_REPLAY_APIS.has(message.api)) {
    return message.content.some((block) => {
      if (block.type !== "thinking") return false;
      const signature = block.thinkingSignature;
      if (!signature) return false;
      try {
        const item: unknown = JSON.parse(signature);
        if (!item || typeof item !== "object" || !("encrypted_content" in item)) return false;
        const encryptedContent = item.encrypted_content;
        return typeof encryptedContent === "string" && encryptedContent.length > 0;
      } catch {
        return false;
      }
    });
  }
  return message.content.some((block) => block.type === "thinking" && Boolean(block.thinkingSignature));
}

export function scanSession(sessionManager?: SessionSource): SessionScan {
  if (!sessionManager) return {};
  // Session entries are arbitrary historical content; a malformed session should cost
  // the session rows, not the whole panel.
  try {
    const entries = sessionManager.getEntries();
    const leafId = sessionManager.getLeafId();
    const { messages, requestMessages } = accountingSession(entries, leafId);
    if (messages.length === 0) return {};

    const llmMessages = convertToLlm(messages);
    const breakdown: SessionBreakdown = {
      thinkingSummaryChars: 0,
      toolOutputChars: 0,
      messageChars: 0,
      messageCount: messages.length,
      contextUsageEstimated: true,
      measuredToolOutputTokens: 0,
      measuredToolOutputChars: 0,
    };
    const trusted = llmMessages.flatMap((message, index) =>
      message.role === "assistant" && hasTrustedUsage(message) ? [{ index, message }] : []);
    const lastTrustedUsageIndex = trusted.at(-1)?.index ?? -1;
    const anchor = trusted.at(-1)?.message;
    const additions = anchor && requestMessages.get(anchor);
    if (additions?.additive) breakdown.requestOnly = { chars: additions.chars };
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
    if (anchor) {
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
      for (const { index, message } of trusted) {
        if (!sameModel(message, anchor)) continue;
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
      if (historicalReasoningTokens > promptTokens(anchor)) {
        exactReasoningTokens -= historicalReasoningTokens;
        for (const index of historicalReasoningIndices) exactReasoningIndices.delete(index);
        hasExactReasoning = exactReasoningIndices.size > 0;
      }
    }
    if (hasExactReasoning) breakdown.reasoningTokens = exactReasoningTokens;

    // A reused prompt grew by exactly the replayed response plus what was appended after it.
    for (const [k, next] of trusted.slice(1).entries()) {
      const previous = trusted[k]!.message;
      const appended = llmMessages.slice(trusted[k]!.index + 1, next.index);
      const replayed = previous.usage.output - (hasReasoningCarrier(previous) ? 0 : reportedReasoning(previous) ?? 0);
      const measured = promptTokens(next.message) - promptTokens(previous) - replayed;
      if (requestMessages.has(previous) || requestMessages.has(next.message)
        || !sameModel(previous, anchor!) || !reusedPrompt(previous, next.message) || measured < 0
        || appended.some((message) => message.role !== "toolResult")) continue;
      breakdown.measuredToolOutputTokens += measured;
      breakdown.measuredToolOutputChars += appended.reduce((sum, message) => sum + countTextContent(message.content), 0);
    }

    // The first prompt is harness plus prelude, and still the anchor's harness while every later request reused it.
    const firstPromptHolds = !trusted.some(({ message }) => requestMessages.has(message))
      && !messages.some((message) => message.role === "compactionSummary")
      && trusted.every(({ message }, k) => sameModel(message, anchor!) && (k === 0 || reusedPrompt(trusted[k - 1]!.message, message)));
    const firstPromptIndex = firstPromptHolds ? trusted[0]?.index : undefined;

    for (let index = 0; index < llmMessages.length; index++) {
      const message = llmMessages[index]!;
      if (index === firstPromptIndex) {
        breakdown.firstPrompt = {
          tokens: promptTokens(trusted[0]!.message),
          preludeChars: breakdown.toolOutputChars + breakdown.messageChars + breakdown.thinkingSummaryChars,
        };
      }
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
            const crossModelSummary = anchor !== undefined && !sameModel(message, anchor);
            if (!strippedThinkingIndices.has(index) && !exactReasoningIndices.has(index)
              && !block.redacted && (claudeSummary || plainSummary || crossModelSummary)) {
              breakdown.thinkingSummaryChars += block.thinking.length;
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
    const lastBilled = anchor ? { provider: anchor.provider, id: anchor.model, api: anchor.api } : undefined;
    return { breakdown, lastBilled };
  } catch {
    return {};
  }
}
