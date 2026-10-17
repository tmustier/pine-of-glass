// The same character grammar for saved messages and request-local additions.
import { isJsonObject } from "../_lib/boundary.ts";

export function countTextContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (!isJsonObject(block)) return sum;
    if (block.type === "text") return sum + (typeof block.text === "string" ? block.text.length : 0);
    if (block.type === "image") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
      const length = typeof block.data === "string" ? block.data.length : 0;
      return sum + `[image:${mimeType}:${length} chars]`.length;
    }
    return sum;
  }, 0);
}

export function countToolCallContent(block: unknown): number {
  if (!isJsonObject(block)) return 0;
  let json: string;
  try {
    json = JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments }, null, 2) ?? "undefined";
  } catch (error) {
    json = `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return json.length;
}
