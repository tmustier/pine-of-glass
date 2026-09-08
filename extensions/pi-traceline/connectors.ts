import { isAssistantRow, isToolRow } from "../_lib/chat.ts";

/** Expanded native tool output breaks the compact block. */
export function isExpandedToolRow(c: unknown): boolean { return isToolRow(c) && c.expanded === true; }

/** Tool-call-only assistant turns are invisible connectors, not visual block breaks. */
export function isEmptyConnector(c: unknown): boolean {
  if (!isAssistantRow(c)) return false;
  const content = c.lastMessage?.content;
  if (!Array.isArray(content)) return true;
  return !content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
    return (b.type === "text" && typeof b.text === "string" && b.text.trim()) ||
      (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim());
  });
}

/** A collapsed reasoning-only turn permits tight spacing and bash preamble reuse. */
export function isCollapsedThinkingRow(c: unknown): boolean {
  if (!isAssistantRow(c) || c.hideThinkingBlock !== true) return false;
  const content = c.lastMessage?.content;
  if (!Array.isArray(content)) return false;
  let hasThinking = false;
  for (const b of content) {
    if (b?.type === "text" && b.text?.trim()) return false;
    if (b?.type === "thinking" && b.thinking?.trim()) hasThinking = true;
  }
  return hasThinking;
}
