import { Markdown, MouseRegion, Text, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import { rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject } from "../_lib/boundary.ts";
import type { AssistantRowDataLike } from "../_lib/chat.ts";
import { middleTruncate } from "../_lib/style.ts";
import { drillState } from "./drill.ts";
import { gistFor } from "./summaries.ts";

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

// Pi rebuilds thinking regions during streaming updates and click/visibility toggles.
// Reuse derived previews across those rebuilds. Compare source text, not just length:
// OpenAI Responses can replace thinking in place with final text at thinking_end.
// WeakMap keys die with their message.
const blockPreviewCache = new WeakMap<object, { source: string; preview: string }>();

/** Pi's label line around its visible words: indent and opening ink, then closing ink. */
function labelFrame(line: string) {
  const visible = stripAnsi(line);
  const indent = visible.match(/^\s*/)?.[0].length ?? 0;
  const trailing = visible.match(/\s*$/)?.[0].length ?? 0;
  const open = line.slice(0, rawIndexAtVisibleIndex(line, indent));
  const close = line.slice(rawIndexBeforeVisibleIndex(line, visible.length - trailing)).replace(/[ \t]+$/g, "");
  return { open, close, indent };
}

function replaceVisibleLabel(line: string, preview: string, width: number): string {
  const { open, close } = labelFrame(line);
  return middleTruncate(`${open}${preview}${close}`, width);
}

// A run is settled once anything follows it in the message (§9.15): its text is final.
type RunPreview = { text: string; settled: boolean };

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
  let previews: RunPreview[] | undefined;
  if (regions.some((region) => region.child instanceof Text)) {
    const content = comp.lastMessage?.content;
    if (!Array.isArray(content)) return;
    previews = [];
    let group: string[] | undefined;
    for (const block of content) {
      if (isJsonObject(block) && block.type === "thinking") {
        // Non-empty thinking blocks extend the current group; empty ones leave it open,
        // matching the previous accumulation semantics.
        if (typeof block.thinking === "string" && block.thinking.trim()) {
          const source = block.thinking;
          const cached = blockPreviewCache.get(block);
          let preview: string;
          if (cached && cached.source === source) preview = cached.preview;
          else {
            const fragments: string[] = [];
            for (const line of source.split(/\r\n|\r|\n/)) {
              const markdown = stripAnsi(line)
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
                .replace(/\s+/g, " ")
                .trim();
              if (!markdown) continue;
              const rendered = new Markdown(markdown, 0, 0, plainMarkdownTheme).render(PREVIEW_RENDER_WIDTH);
              const first = rendered.find((line) => stripAnsi(line).trim().length > 0);
              const fragment = first ? stripAnsi(first).replace(/\s+/g, " ").trim() : markdown;
              if (fragment) fragments.push(fragment);
            }
            preview = fragments.join(" · ");
            blockPreviewCache.set(block, { source, preview });
          }
          (group ??= []).push(preview);
        }
        continue;
      }
      if (group) previews.push({ text: group.join(" · "), settled: true });
      group = undefined;
    }
    if (group) previews.push({ text: group.join(" · "), settled: false });
    if (regions.length !== previews.length) return;
  }

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!;
    const handleMouse = region.handleMouse;
    region.handleMouse = function (event) {
      return drillState() ? undefined : handleMouse.call(this, event);
    };
    const nativeLabel = region.child;
    const preview = previews?.[i];
    if (!(nativeLabel instanceof Text) || !preview?.text) continue;
    // Fullscreen Pi renders the whole transcript every frame, so every thinking label pays
    // this per frame. The output is a function of the native label line, the width and
    // the run's gist (the preview is fixed per install), so reuse it while all three hold.
    // A preview cut at this width shows its `≈` gist instead, once there is one (§9.15).
    let last: { width: number; line: string; gist: string | undefined; lines: string[] } | undefined;
    region.child = {
      render(width) {
        const lines = nativeLabel.render(width);
        if (lines.length !== 1) return lines;
        const line = lines[0]!;
        const cut = visibleWidth(replaceVisibleLabel(line, preview.text, Number.POSITIVE_INFINITY)) > width;
        const gist = cut ? gistFor("thinking", preview.text, preview.settled) : undefined;
        if (last?.width !== width || last.line !== line || last.gist !== gist) {
          let labelLines: string[];
          if (gist) {
            // A gist wraps under the label's first word, in its ink, never cut (§9.15).
            const { open, close, indent } = labelFrame(line);
            labelLines = wrapTextWithAnsi(gist, Math.max(1, width - indent - 2)).map((text, i) => `${open}${i ? "  " : "≈ "}${text}${close}`);
          } else labelLines = [replaceVisibleLabel(line, preview.text, width)];
          last = { width, line, gist, lines: labelLines };
        }
        return last.lines;
      },
      invalidate: () => nativeLabel.invalidate(),
    };
  }
  installedChildren.add(children);
}
