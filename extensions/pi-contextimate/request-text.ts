// Decode only native text conversation fields, never instructions, tool output or schemas.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../_lib/boundary.ts";
import type { RequestMessages } from "./request-messages.ts";

type TextPart = { role: "user" | "assistant"; text: string };
type Normalization = Pick<typeof import("@earendil-works/pi-ai/api/transform-messages"), "transformMessages">
  & Pick<typeof import("@earendil-works/pi-ai/utils/sanitize-unicode"), "sanitizeSurrogates">;
let normalization: Promise<Normalization | undefined> | undefined;

function nativeNormalization(): Promise<Normalization | undefined> {
  normalization ??= (async () => {
    const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
    // SAFETY: public Pi AI exports, exercised by native-converter regression tests.
    // File URLs bypass Pi 0.86's prefix alias, which misresolves package subpaths.
    const messages = await import(pathToFileURL(join(dist, "api/transform-messages.js")).href) as typeof import("@earendil-works/pi-ai/api/transform-messages");
    // SAFETY: paired public Pi AI sanitizer, pinned by the same native-converter tests.
    const unicode = await import(pathToFileURL(join(dist, "utils/sanitize-unicode.js")).href) as typeof import("@earendil-works/pi-ai/utils/sanitize-unicode");
    return { transformMessages: messages.transformMessages, sanitizeSurrogates: unicode.sanitizeSurrogates };
  })().catch(() => undefined);
  return normalization;
}

function conversationText(messages: AgentMessage[], model?: Model<Api>, native?: Normalization): TextPart[] {
  const llm = convertToLlm(messages);
  const normalized = model && native ? native.transformMessages(llm, model) : llm;
  const anthropic = model?.api === "anthropic-messages";
  const allowEmptySignature = model?.compat && "allowEmptySignature" in model.compat && model.compat.allowEmptySignature;
  return normalized.flatMap((message): TextPart[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const texts = typeof message.content === "string" ? [message.content] : message.content.flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (anthropic && block.type === "thinking" && !block.redacted
        && !block.thinkingSignature?.trim() && !allowEmptySignature) return [block.thinking];
      return [];
    });
    return texts.filter((text) => anthropic ? text.trim().length > 0 : text.length > 0)
      .map((text) => ({ role: message.role, text: native ? native.sanitizeSurrogates(text) : text }));
  });
}

function textAdditions(expected: TextPart[], observed: TextPart[]): RequestMessages {
  let index = 0;
  let chars = 0;
  let count = 0;
  for (const part of observed) {
    const match = expected[index];
    if (match && match.role === part.role && match.text === part.text) index++;
    else { chars += part.text.length; count++; }
  }
  if (index !== expected.length) return { chars: 0, count: 0, additive: false };
  return { chars, count, additive: true };
}

export function conversationTextAdditions(saved: AgentMessage[], outgoing: AgentMessage[]): RequestMessages {
  return textAdditions(conversationText(saved), conversationText(outgoing));
}

export function hasMessageImages(messages: AgentMessage[]): boolean {
  return convertToLlm(messages).some((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === "image"));
}

export async function payloadTextAdditions(saved: AgentMessage[], payload: unknown, model: Model<Api>): Promise<RequestMessages | undefined> {
  if (!isJsonObject(payload)) return undefined;
  // Pi and providers can replace, split or caption images after the context hooks.
  // Without that conversion's settings/provenance, do not call its text an injection.
  if (hasMessageImages(saved)) return undefined;
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
  // A replacement, deletion or provider rewrite is not an additive observation.
  const native = await nativeNormalization();
  return native ? textAdditions(conversationText(saved, model, native), observed) : undefined;
}
