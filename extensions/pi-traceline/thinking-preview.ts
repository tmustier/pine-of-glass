import { Markdown, MouseRegion, Text, type Component, type MarkdownTheme, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import { rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import type { AssistantRowDataLike } from "../_lib/chat.ts";
import { middleTruncate } from "../_lib/style.ts";
import { drillState } from "./drill.ts";

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

function replaceVisibleLabel(line: string, preview: string, width: number): string {
  const visible = stripAnsi(line);
  const leading = visible.match(/^\s*/)?.[0].length ?? 0;
  const trailing = visible.match(/\s*$/)?.[0].length ?? 0;
  const start = rawIndexAtVisibleIndex(line, leading);
  const end = rawIndexBeforeVisibleIndex(line, visible.length - trailing);
  const suffix = line.slice(end).replace(/[ \t]+$/g, "");
  return middleTruncate(`${line.slice(0, start)}${preview}${suffix}`, width);
}

function thinkingPreviews(comp: AssistantRowDataLike): string[] | undefined {
  const content = comp.lastMessage?.content;
  if (!Array.isArray(content)) return undefined;

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
  return previews;
}

type AssistantPreviewRow = AssistantRowDataLike & { contentContainer?: { children?: unknown[] } };
type ThinkingRegion = {
  child: Component;
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};
const installedChildren = new WeakSet<unknown[]>();

/** Replace only Pi's hidden-label child, retaining its native run-level MouseRegion. */
export function installThinkingPreviews(comp: AssistantPreviewRow): void {
  const children = comp.contentContainer?.children;
  if (!Array.isArray(children) || installedChildren.has(children)) return;

  // SAFETY: Pi's AssistantMessageComponent wraps each consecutive thinking run in a
  // MouseRegion whose child is Text when hidden and Markdown when visible. The real
  // component contract tests pin this shape and the one-region-per-run ordering.
  const regions = children
    .filter((child) => child instanceof MouseRegion)
    .map((region) => region as unknown as ThinkingRegion);
  let previews: string[] | undefined;
  if (regions.some((region) => region.child instanceof Text)) {
    previews = thinkingPreviews(comp);
    if (!previews || regions.length !== previews.length) return;
  }

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!;
    const handleMouse = region.handleMouse;
    region.handleMouse = function (event) {
      return drillState() ? undefined : handleMouse.call(this, event);
    };
    const nativeLabel = region.child;
    const preview = previews?.[i];
    if (!(nativeLabel instanceof Text) || !preview) continue;
    region.child = {
      render(width) {
        const lines = nativeLabel.render(width);
        return lines.length === 1 ? [replaceVisibleLabel(lines[0]!, preview, width)] : lines;
      },
      invalidate: () => nativeLabel.invalidate(),
    };
  }
  installedChildren.add(children);
}
