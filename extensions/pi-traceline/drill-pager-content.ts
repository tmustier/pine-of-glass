// Peek-pager content grammar (design language §9.13): the pager is the fidelity
// surface, so everything the model saw must be renderable here. This module builds the
// text of each section: the invocation (pi's call renderer when the tool has one, the
// complete argument grammar when it does not), the result label, the image fact line,
// and the foreign-block line. Windowing, caching, and image-component lifecycle stay
// in drill-pager.ts.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getImageDimensions, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resultTextCharCount, type ToolRowLike } from "../_lib/chat.ts";
import { compactCount } from "../_lib/fmt.ts";
import { SEP, ink, type Tone } from "../_lib/style.ts";
import { imageMimeShort } from "./image-fact.ts";

export type ImageBlockLike = { type?: unknown; data?: unknown; mimeType?: unknown };

// Pi's call renderer with its real newlines when the tool has one; a tool without one
// (papercut, MCP tools, most extension tools) shows its complete arguments instead
// (§9.13): the arguments are the invocation, a bare tool name is not.
export function invocationLines(theme: Theme | undefined, call: ToolRowLike, width: number): string[] {
  try {
    const out = call.callRendererComponent?.render?.(width);
    if (Array.isArray(out) && out.length > 0) return out.map((line) => String(line));
  } catch {
    // Pi seam: a call renderer may throw mid-stream; fall through to the argument grammar.
  }
  const name = typeof call.toolName === "string" ? call.toolName : "tool";
  return [name, ...argumentLines(theme, call.args, width)];
}

const ARG_KEY_WIDTH_CAP = 24;

/** Aligned `key  value` rows (§9.13): keys dim in one column, string values verbatim,
 * wrapped continuations hanging at the value column, nested objects as indented JSON. */
export function argumentLines(theme: Theme | undefined, args: unknown, width: number): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return [];
  const keyWidth = Math.min(Math.max(...entries.map(([key]) => key.length)), ARG_KEY_WIDTH_CAP);
  const continuation = " ".repeat(keyWidth + 2);
  const bodyWidth = Math.max(10, width - keyWidth - 2);
  const out: string[] = [];
  for (const [key, value] of entries) {
    const text = argumentText(value).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    // An overlong key takes its own line; its value rows all hang at the value column,
    // so the column stays one straight edge (vertical alignment is load-bearing).
    let first = true;
    if (key.length > keyWidth) {
      out.push(ink(theme, "dim", key));
      first = false;
    }
    for (const row of text.split("\n")) {
      const wrapped = row.length === 0 ? [""] : wrapTextWithAnsi(row, bodyWidth);
      for (const piece of wrapped) {
        out.push(first ? `${ink(theme, "dim", key.padEnd(keyWidth))}  ${piece}` : `${continuation}${piece}`);
        first = false;
      }
    }
  }
  return out;
}

function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function resultLabel(theme: Theme | undefined, tone: Tone, call: ToolRowLike): string {
  const word = tone === "error" ? "failed" : tone === "success" ? "success" : "running";
  const chars = resultTextCharCount(call);
  const size = chars !== undefined ? ink(theme, "dim", `${SEP}${compactCount(chars)} ch`) : "";
  return `${ink(theme, "dim", `result${SEP}`)}${ink(theme, tone, word)}${size}`;
}

/** The image fact line (§9.13, §4 grammar: what, then how big): always rendered,
 * whether or not the terminal can also show the pixels. */
export function imageFactLine(theme: Theme | undefined, block: ImageBlockLike): string {
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  const cells = ["image"];
  const short = imageMimeShort(mimeType);
  if (short !== "image") cells.push(short);
  const data = typeof block.data === "string" ? block.data : undefined;
  if (data && mimeType) {
    const dims = getImageDimensions(data, mimeType);
    if (dims) cells.push(`${dims.widthPx}×${dims.heightPx}`);
  }
  if (data) cells.push(`${compactCount(Math.floor((data.length * 3) / 4))} bytes`);
  return ink(theme, "dim", cells.join(SEP));
}

/** A block the pager has no richer rendering for shows its type and metadata (§9.13),
 * never a bare bracket. Bulky payload fields stay out; they are not readable anyway. */
export function foreignBlockLine(theme: Theme | undefined, block: object): string {
  const typed = block as { type?: unknown };
  const kind = typeof typed.type === "string" ? typed.type : "block";
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (key === "type" || key === "data") continue;
    meta[key] = value;
  }
  let json = "";
  try {
    json = Object.keys(meta).length > 0 ? (JSON.stringify(meta) ?? "") : "";
  } catch {
    json = "";
  }
  return ink(theme, "dim", json ? `${kind}${SEP}${json}` : kind);
}

// Pixels mirror pi's own native tool row (§9.13): the row's showImages setting is
// honoured, terminal capabilities decide, and pi's async kitty PNG conversions
// (tool-execution.ts convertedImages) are reused rather than redone. Kitty draws PNG
// only; an unconverted block keeps its fact line, exactly as pi's row does.
export function imagePixelSource(
  call: ToolRowLike,
  imageIndex: number,
  block: ImageBlockLike,
): { data: string; mimeType: string } | undefined {
  if (call.showImages === false) return undefined;
  const caps = getCapabilities();
  if (!caps.images) return undefined;
  const converted = convertedImage(call, imageIndex);
  const data = converted?.data ?? (typeof block.data === "string" ? block.data : undefined);
  const mimeType = converted?.mimeType ?? (typeof block.mimeType === "string" ? block.mimeType : undefined);
  if (!data || !mimeType) return undefined;
  if (caps.images === "kitty" && mimeType !== "image/png") return undefined;
  return { data, mimeType };
}

function convertedImage(call: ToolRowLike, imageIndex: number): { data: string; mimeType: string } | undefined {
  const map = call.convertedImages;
  if (!(map instanceof Map)) return undefined;
  const value: unknown = map.get(imageIndex);
  if (!value || typeof value !== "object") return undefined;
  const typed = value as { data?: unknown; mimeType?: unknown };
  return typeof typed.data === "string" && typeof typed.mimeType === "string"
    ? { data: typed.data, mimeType: typed.mimeType }
    : undefined;
}
