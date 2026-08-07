import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

import { rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import type { AssistantRowDataLike } from "../_lib/chat.ts";
import { middleTruncate } from "../_lib/style.ts";

const PREVIEW_RENDER_WIDTH = 10_000;

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

function markdownToPlainInline(rawLine: string): string {
  const markdown = stripAnsi(rawLine)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!markdown) return "";

  const rendered = new Markdown(markdown, 0, 0, plainMarkdownTheme).render(PREVIEW_RENDER_WIDTH);
  const first = rendered.find((line) => stripAnsi(line).trim().length > 0);
  return first ? stripAnsi(first).replace(/\s+/g, " ").trim() : markdown;
}

function replaceVisibleLabel(line: string, preview: string, width?: number): string {
  const visible = stripAnsi(line);
  const leading = visible.match(/^\s*/)?.[0].length ?? 0;
  const trailing = visible.match(/\s*$/)?.[0].length ?? 0;
  const start = rawIndexAtVisibleIndex(line, leading);
  const end = rawIndexBeforeVisibleIndex(line, visible.length - trailing);
  const suffix = width && width > 0 ? line.slice(end).replace(/[ \t]+$/g, "") : line.slice(end);
  const replaced = `${line.slice(0, start)}${preview}${suffix}`;
  return width && width > 0 ? middleTruncate(replaced, width) : replaced;
}

export function replaceThinkingLabels(comp: AssistantRowDataLike, lines: string[], width?: number): string[] {
  const label = comp.hiddenThinkingLabel;
  const content = comp.lastMessage?.content;
  if (typeof label !== "string" || label.length === 0 || !Array.isArray(content)) return lines;

  const previews: string[] = [];
  let fragments: string[] | undefined;
  for (const block of content) {
    if (block?.type === "thinking") {
      if (typeof block.thinking === "string" && block.thinking.trim()) {
        fragments ??= [];
        for (const line of block.thinking.split(/\r\n|\r|\n/)) {
          const fragment = markdownToPlainInline(line);
          if (fragment) fragments.push(fragment);
        }
      }
      continue;
    }
    if (fragments) previews.push(fragments.join(" · "));
    fragments = undefined;
  }
  if (fragments) previews.push(fragments.join(" · "));

  if (lines.filter((line) => stripAnsi(line).trim() === label).length !== previews.length) return lines;

  let previewIndex = 0;
  return lines.map((line) => {
    if (stripAnsi(line).trim() !== label) return line;
    const preview = previews[previewIndex++]!;
    return preview ? replaceVisibleLabel(line, preview, width) : line;
  });
}
