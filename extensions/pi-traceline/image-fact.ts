// The image what-fact for trace rows (design language §9.7): an image-bearing result
// wears `png 1044×646` in the size cell's berth instead of a char count, because
// counting only the text note beside an image claims the result was tiny when the
// model actually received the pixels. It is a what-fact, not a how-big-fact: ink and
// column policy stay in index.ts.
import { getImageDimensions } from "@earendil-works/pi-tui";
import type { ToolRowDataLike } from "../_lib/chat.ts";

// Dimension parsing decodes the payload, so facts cache per result identity like
// record facts do (results never change once settled).
const imageFactCache = new WeakMap<object, string>();

export function resultImageFact(comp: ToolRowDataLike | undefined): string {
  const result = comp?.result;
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return "";
  const cached = imageFactCache.get(result);
  if (cached !== undefined) return cached;
  const blocks = result.content.filter(
    (block): block is { type: "image"; data?: unknown; mimeType?: unknown } =>
      !!block && typeof block === "object" && (block as { type?: unknown }).type === "image",
  );
  let fact = "";
  if (blocks.length > 1) fact = `${blocks.length} images`;
  else if (blocks.length === 1) {
    const block = blocks[0]!;
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
    const data = typeof block.data === "string" ? block.data : undefined;
    const short = imageMimeShort(mimeType);
    const dims = data && mimeType ? getImageDimensions(data, mimeType) : null;
    fact = dims ? `${short} ${dims.widthPx}×${dims.heightPx}` : short;
  }
  imageFactCache.set(result, fact);
  return fact;
}

export function imageMimeShort(mimeType: string | undefined): string {
  if (!mimeType) return "image";
  const slash = mimeType.indexOf("/");
  return slash >= 0 && slash < mimeType.length - 1 ? mimeType.slice(slash + 1) : mimeType;
}
