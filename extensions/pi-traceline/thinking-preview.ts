import { Markdown, truncateToWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

import { OSC_SEQUENCE, rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import type { AssistantRowDataLike } from "../_lib/chat.ts";
import { ELLIPSIS } from "../_lib/style.ts";

const PREVIEW_RENDER_WIDTH = 10_000;

// pi renders one collapsed label per thinking *block*. Traceline replaces each label
// with the block's reasoning lines: every non-empty source line gets an informative
// `Thinking: …` preview, while one or more consecutive empty source lines become one
// blank display line. This preserves thought steps and paragraph boundaries without
// reproducing arbitrary vertical whitespace. If Pi emits labels without corresponding
// reasoning payloads, the old duplicate-label fold remains as a safe fallback. OSC 133
// zone marks on dropped fallback labels are transplanted onto the last kept line.
function oscSequences(line: string): string {
  return (line.match(OSC_SEQUENCE) ?? []).join("");
}

function nativeHiddenThinkingLabel(comp: AssistantRowDataLike): string {
  return typeof comp.hiddenThinkingLabel === "string" && comp.hiddenThinkingLabel.length > 0
    ? comp.hiddenThinkingLabel
    : "Thinking...";
}

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

type ThinkingPreview = string | undefined;

function sanitizeThinkingLine(rawLine: string): string {
  return stripAnsi(rawLine)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownToPlainInline(markdown: string): string {
  try {
    const rendered = new Markdown(markdown, 0, 0, plainMarkdownTheme).render(PREVIEW_RENDER_WIDTH);
    const first = rendered.find((line) => stripAnsi(line).trim().length > 0);
    if (first) return stripAnsi(first).replace(/\s+/g, " ").trim();
  } catch {
    /* fall through to the raw sanitized line */
  }
  return sanitizeThinkingLine(markdown);
}

function thinkingPreviewForTrace(text: string): ThinkingPreview[] {
  const previews: ThinkingPreview[] = [];
  let previousWasBlank = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const sanitized = sanitizeThinkingLine(rawLine);
    if (!sanitized) {
      if (previews.length > 0 && !previousWasBlank) previews.push(undefined);
      previousWasBlank = true;
      continue;
    }
    const plain = markdownToPlainInline(sanitized);
    if (plain) {
      previews.push(plain);
      previousWasBlank = false;
    }
  }
  while (previews.length > 0 && previews.at(-1) === undefined) previews.pop();
  return previews;
}

function thinkingPreviewBlocks(comp: AssistantRowDataLike): ThinkingPreview[][] {
  const content = comp.lastMessage?.content;
  if (!Array.isArray(content)) return [];
  const previews: ThinkingPreview[][] = [];
  for (const block of content) {
    if (block?.type !== "thinking" || typeof block.thinking !== "string") continue;
    // Pi does not render a collapsed label for empty or whitespace-only thinking. Skip
    // those blocks here too, so the next native label stays paired with its real trace.
    if (block.thinking.trim().length === 0) continue;
    previews.push(thinkingPreviewForTrace(block.thinking));
  }
  return previews;
}

function replaceVisibleThinkingLabel(line: string, displayLabel: string, width?: number): string {
  const visible = stripAnsi(line);
  const leading = visible.match(/^\s*/)?.[0].length ?? 0;
  const trailing = visible.match(/\s*$/)?.[0].length ?? 0;
  const start = rawIndexAtVisibleIndex(line, leading);
  const end = rawIndexBeforeVisibleIndex(line, visible.length - trailing);
  // Native collapsed labels are often padded out to the row width. Keep control/style
  // suffixes, but drop that old visible padding before fitting the longer preview.
  const suffix = width && width > 0 ? line.slice(end).replace(/[ \t]+$/g, "") : line.slice(end);
  const replaced = `${line.slice(0, start)}${displayLabel}${suffix}`;
  return width && width > 0 ? truncateToWidth(replaced, Math.max(1, width), ELLIPSIS) : replaced;
}

export function dedupeThinkingLabels(comp: AssistantRowDataLike, lines: string[], width?: number): string[] {
  const label = nativeHiddenThinkingLabel(comp);
  const previewBlocks = thinkingPreviewBlocks(comp);
  const out: string[] = [];
  let previewIndex = 0;
  let lastFallbackLabelAt = -1; // index in `out`, with only blanks after it
  let salvaged = "";
  for (const line of lines) {
    const visible = stripAnsi(line).trim();
    if (visible === label) {
      const previews = previewBlocks[previewIndex++];
      if (previews?.some((preview) => preview !== undefined)) {
        lastFallbackLabelAt = -1;
        let firstPreview = true;
        for (const preview of previews) {
          if (preview === undefined) {
            out.push("");
            continue;
          }
          // Only the first replacement inherits the native row's OSC zone marks.
          // Synthetic continuation rows keep its SGR styling but must not duplicate OSC.
          const template = firstPreview ? line : line.replace(OSC_SEQUENCE, "");
          out.push(replaceVisibleThinkingLabel(template, `Thinking: ${preview}`, width));
          firstPreview = false;
        }
        continue;
      }
      if (lastFallbackLabelAt >= 0) {
        while (out.length > lastFallbackLabelAt + 1) salvaged += oscSequences(out.pop()!);
        salvaged += oscSequences(line);
        continue;
      }
      lastFallbackLabelAt = out.length;
      out.push(line);
      continue;
    }
    if (visible.length > 0) lastFallbackLabelAt = -1;
    out.push(line);
  }
  if (salvaged && out.length > 0) out[out.length - 1] = `${salvaged}${out[out.length - 1]}`;
  return out;
}
