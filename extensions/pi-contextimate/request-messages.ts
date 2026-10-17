// Decode conversation additions, excluding instructions, tool output and schemas.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sessionSdk from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../_lib/boundary.ts";
import { countTextContent, countToolCallContent } from "./message-size.ts";

type RequestMessages = { additive: false } | { additive: true; chars: number };
type TextPart = { role: "user" | "assistant"; text: string };
type Normalization = Pick<typeof import("@earendil-works/pi-ai/api/transform-messages"), "transformMessages">
  & Pick<typeof import("@earendil-works/pi-ai/utils/sanitize-unicode"), "sanitizeSurrogates">;
let normalization: Promise<Normalization> | undefined;

function conversationText(messages: Message[], model?: Model<Api>): TextPart[] {
  const anthropic = model?.api === "anthropic-messages";
  const allowEmptySignature = model?.compat && "allowEmptySignature" in model.compat && model.compat.allowEmptySignature;
  return messages.flatMap((message): TextPart[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const texts = typeof message.content === "string" ? [message.content] : message.content.flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (anthropic && block.type === "thinking" && !block.redacted
        && !block.thinkingSignature?.trim() && !allowEmptySignature) return [block.thinking];
      return [];
    });
    return texts.filter((text) => anthropic ? text.trim().length > 0 : text.length > 0)
      .map((text) => ({ role: message.role, text }));
  });
}

function textAdditions(expected: TextPart[], observed: TextPart[]): RequestMessages {
  let index = 0;
  let chars = 0;
  for (const part of observed) {
    const match = expected[index];
    if (match && match.role === part.role && match.text === part.text) index++;
    else chars += part.text.length;
  }
  return index === expected.length ? { chars, additive: true } : { additive: false };
}

function hasImages(messages: Message[]): boolean {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === "image"));
}

function messageKey(message: Message): string {
  return JSON.stringify({ role: message.role, content: message.content,
    toolCallId: message.role === "toolResult" ? message.toolCallId : undefined });
}

export async function payloadTextAdditions(saved: AgentMessage[], payload: unknown, model: Model<Api>): Promise<RequestMessages | undefined> {
  if (!isJsonObject(payload)) return undefined;
  const messages = convertToLlm(saved);
  // Image conversion depends on Pi settings and can generate captions after the hooks.
  if (hasImages(messages)) return undefined;
  const responses = model.api === "openai-responses" || model.api === "openai-codex-responses" || model.api === "azure-openai-responses";
  const anthropic = model.api === "anthropic-messages";
  if (!responses && !anthropic) return undefined;
  const wire = responses ? payload.input : payload.messages;
  if (!Array.isArray(wire)) return undefined;
  const observed: TextPart[] = [];
  for (const item of wire) {
    if (!isJsonObject(item) || (item.role !== "user" && item.role !== "assistant")) continue;
    if (typeof item.content === "string") {
      if (item.content) observed.push({ role: item.role, text: item.content });
    } else if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (isJsonObject(block) && typeof block.text === "string" && block.text
          && (responses ? block.type === "input_text" || block.type === "output_text" : block.type === "text")) {
          observed.push({ role: item.role, text: block.text });
        }
      }
    }
  }
  normalization ??= (async () => {
    const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
    // SAFETY: public Pi AI exports, exercised by native-converter regression tests.
    // File URLs bypass Pi 0.86's prefix alias, which misresolves package subpaths.
    const messages = await import(pathToFileURL(join(dist, "api/transform-messages.js")).href) as typeof import("@earendil-works/pi-ai/api/transform-messages");
    // SAFETY: paired public Pi AI sanitizer, pinned by the same native-converter tests.
    const unicode = await import(pathToFileURL(join(dist, "utils/sanitize-unicode.js")).href) as typeof import("@earendil-works/pi-ai/utils/sanitize-unicode");
    return { transformMessages: messages.transformMessages, sanitizeSurrogates: unicode.sanitizeSurrogates };
  })();
  const native = await normalization;
  const expected = conversationText(native.transformMessages(messages, model), model)
    .map((part) => ({ ...part, text: native.sanitizeSurrogates(part.text) }));
  return textAdditions(expected, observed);
}

const ENTRY_TYPE = "contextimate-request-messages";

export function observeRequestMessages(pi: ExtensionAPI, markDirty: () => void): void {
  let request: {
    saved: AgentMessage[];
    payload?: unknown;
    counts?: RequestMessages;
    nonTextChars: number;
    hasImages: boolean;
  } | undefined;
  pi.on("turn_start", () => { request = undefined; });
  pi.on("context_with_system", (event, ctx) => {
    const saved = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
    const expected = convertToLlm(saved).filter((message) => message.role !== "system");
    const observed = convertToLlm(event.messages).filter((message) => message.role !== "system");
    const keys = expected.map(messageKey);
    let index = 0;
    let chars = 0;
    let changed = false;
    for (const message of observed) {
      if (messageKey(message) === keys[index]) { index++; continue; }
      changed = true;
      chars += countTextContent(message.content);
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") chars += countToolCallContent(block);
      }
    }
    const counts: RequestMessages | undefined = index !== keys.length ? { additive: false }
      : changed ? { chars, additive: true } : undefined;
    const text = textAdditions(conversationText(expected), conversationText(observed));
    request = { saved, counts, nonTextChars: text.additive ? chars - text.chars : 0, hasImages: hasImages(observed) };
  });
  pi.on("before_provider_request", (event) => {
    if (request) request.payload = structuredClone(event.payload);
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !request) return;
    const { saved, payload, nonTextChars, hasImages } = request;
    let { counts } = request;
    request = undefined;
    const response = event.message;
    if (response.stopReason === "error" || response.stopReason === "aborted") return;
    // A virtual selection can have a different API; the response names the physical route.
    const model = ctx.modelRegistry.find(response.provider, response.model);
    if (model && !hasImages && counts?.additive !== false) {
      const text = await payloadTextAdditions(saved, payload, model);
      if (text) {
        if (!text.additive) counts = text;
        else counts = text.chars > 0 || counts
          ? { additive: true, chars: text.chars + nonTextChars } : undefined;
      }
    }
    // Pi saves the assistant after message_end. Metadata stays on its parent path
    // even when /tree or a fork selects the response itself.
    if (counts) {
      pi.appendEntry(ENTRY_TYPE, { version: 1, ...counts });
      markDirty();
    }
  });
}

/** Return projected messages with request counts attached to their billed responses. */
export function accountingSession(entries: SessionEntry[], leafId: string | null) {
  // Pi 0.86 has no context edits or projection provenance; object identity suffices.
  const projection = sessionSdk.buildSessionProjection?.(entries, leafId) ?? {
    messages: buildSessionContext(entries, leafId).messages,
    entries: entries.flatMap((sourceEntry) => sourceEntry.type === "message"
      ? [{ sourceEntry, messages: [sourceEntry.message] }] : []),
  };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const afterCompaction = new Set<string>();
  let id = leafId;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry || entry.type === "compaction") break;
    afterCompaction.add(id);
    id = entry.parentId;
  }
  const requestMessages = new Map<AssistantMessage, RequestMessages>();
  for (const { sourceEntry, messages } of projection.entries) {
    if (sourceEntry.type !== "message" || sourceEntry.message.role !== "assistant") continue;
    let parent = sourceEntry.parentId === null ? undefined : byId.get(sourceEntry.parentId);
    while (parent && parent.type !== "message" && parent.type !== "compaction") {
      if (parent.type !== "custom" || parent.customType !== ENTRY_TYPE) {
        parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
        continue;
      }
      const data = parent.data;
      if (isJsonObject(data) && data.version === 1) {
        let counts: RequestMessages | undefined;
        if (data.additive === false || !afterCompaction.has(sourceEntry.id)) counts = { additive: false };
        else if (data.additive === true
          && typeof data.chars === "number" && Number.isSafeInteger(data.chars) && data.chars >= 0) {
          counts = { additive: true, chars: data.chars };
        }
        if (counts) for (const message of messages) {
          if (message.role === "assistant") requestMessages.set(message, counts);
        }
      }
      break;
    }
  }
  return { messages: projection.messages, requestMessages };
}
