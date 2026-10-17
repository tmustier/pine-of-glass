// Decode conversation additions, excluding instructions, tool output and schemas.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../_lib/boundary.ts";
import { countTextContent, countToolCallContent } from "./message-size.ts";

export type RequestMessages = { additive: false } | { additive: true; chars: number };
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

export function measureRequestMessages(saved: AgentMessage[], outgoing: AgentMessage[]) {
  const expected = convertToLlm(saved).filter((message) => message.role !== "system");
  const observed = convertToLlm(outgoing).filter((message) => message.role !== "system");
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
  return { counts, nonTextChars: text.additive ? chars - text.chars : 0, hasImages: hasImages(observed) };
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
