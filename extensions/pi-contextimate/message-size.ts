// The same character grammar for saved messages and request-local additions.
import type { Message, ToolCall } from "@earendil-works/pi-ai";

export function countTextContent(content: Message["content"]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, block) => {
    if (block.type === "text") return sum + block.text.length;
    if (block.type === "image") return sum + `[image:${block.mimeType}:${block.data.length} chars]`.length;
    return sum;
  }, 0);
}

export function countToolCallContent(block: ToolCall): number {
  return JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments }, null, 2).length;
}
