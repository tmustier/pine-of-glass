import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

import { OSC_SEQUENCE, rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import type { AssistantRowDataLike } from "../_lib/chat.ts";
import { middleTruncate } from "../_lib/style.ts";

const PREVIEW_RENDER_WIDTH = 10_000;

// Pi renders one collapsed label per adjacent thinking run; older versions rendered one
// per non-empty block. Traceline accepts both shapes and replaces the whole run with one
// `Thinking: …` line. Every non-empty source line appends with a middle-dot separator;
// source newlines never become display rows. Any non-thinking content entry ends the run,
// even when Pi does not render that entry here (a tool call, for example). Empty thinking
// fragments neither render nor break adjacency. Runs that cannot yield a safe preview
// keep one native label; labels without corresponding payloads retain the duplicate-label
// fallback. OSC marks move to the one retained run line.
function oscSequences(line: string): string {
  return (line.match(OSC_SEQUENCE) ?? []).join("");
}

function insertAfterLeadingOsc(line: string, marks: string): string {
  let end = 0;
  OSC_SEQUENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OSC_SEQUENCE.exec(line)) && match.index === end) end = OSC_SEQUENCE.lastIndex;
  OSC_SEQUENCE.lastIndex = 0;
  return `${line.slice(0, end)}${marks}${line.slice(end)}`;
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

function thinkingPreviewFragments(text: string): string[] {
  const fragments: string[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const sanitized = sanitizeThinkingLine(rawLine);
    if (!sanitized) continue;
    const plain = markdownToPlainInline(sanitized);
    if (plain) fragments.push(plain);
  }
  return fragments;
}

const FALLBACK_LABEL = Symbol("fallback-label");
type ThinkingPreviewRow = string | typeof FALLBACK_LABEL;

type ThinkingLabelPlan = {
  row: ThinkingPreviewRow;
  emitsGroup: boolean;
};

function thinkingLabelPlans(comp: AssistantRowDataLike): ThinkingLabelPlan[] {
  const content = comp.lastMessage?.content;
  if (!Array.isArray(content)) return [];

  const plans: ThinkingLabelPlan[] = [];
  let blocks: string[][] = [];
  const flush = () => {
    if (blocks.length === 0) return;
    const fragments = blocks.flat();
    const row: ThinkingPreviewRow = fragments.length > 0 ? fragments.join(" · ") : FALLBACK_LABEL;
    for (let i = 0; i < blocks.length; i++) plans.push({ row, emitsGroup: i === 0 });
    blocks = [];
  };

  for (const block of content) {
    if (block?.type === "thinking") {
      if (typeof block.thinking === "string" && block.thinking.trim().length > 0) {
        // Pi skips empty thinking blocks, so only rendered blocks receive a label plan.
        // Empty fragments still leave `blocks` open and therefore preserve adjacency.
        blocks.push(thinkingPreviewFragments(block.thinking));
      }
      continue;
    }
    // Content order is the semantic authority. In particular, an invisible toolCall
    // separates runs even though native assistant rendering may show only a blank spacer.
    flush();
  }
  flush();
  return plans;
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
  return width && width > 0 ? middleTruncate(replaced, Math.max(1, width)) : replaced;
}

export function dedupeThinkingLabels(comp: AssistantRowDataLike, lines: string[], width?: number): string[] {
  const label = nativeHiddenThinkingLabel(comp);
  const labelPlans = thinkingLabelPlans(comp);
  const out: string[] = [];
  let planIndex = 0;
  let lastFallbackLabelAt = -1; // index in `out`, with only blanks after it
  let activePreviewLineAt = -1;
  let pendingMarksAt = -1;
  let pendingMarks = "";
  const flushPendingMarks = () => {
    if (pendingMarks && pendingMarksAt >= 0 && pendingMarksAt < out.length) {
      // Keep marks already carried by the retained native row first, then transplant
      // later dropped marks before its styling/text. Reversing OSC 133 A/B order can
      // produce malformed terminal zones.
      out[pendingMarksAt] = insertAfterLeadingOsc(out[pendingMarksAt]!, pendingMarks);
    }
    pendingMarksAt = -1;
    pendingMarks = "";
  };
  const queueMarks = (target: number, marks: string) => {
    if (!marks || target < 0) return;
    if (pendingMarksAt !== target) flushPendingMarks();
    pendingMarksAt = target;
    pendingMarks += marks;
  };

  for (const line of lines) {
    const visible = stripAnsi(line).trim();
    if (visible === label) {
      const plan = labelPlans[planIndex++];
      if (plan) {
        lastFallbackLabelAt = -1;
        if (!plan.emitsGroup) {
          // Pi inserts a spacer between visible thinking blocks. The first label already
          // emitted this whole adjacent group, so remove only the blanks immediately
          // before its now-redundant continuation label. Transplant dropped OSC marks to
          // the group's one preview now, never across a later semantic boundary.
          let spacerMarks = "";
          while (out.length > 0 && stripAnsi(out.at(-1)!).trim().length === 0) {
            spacerMarks = `${oscSequences(out.pop()!)}${spacerMarks}`;
          }
          queueMarks(activePreviewLineAt, spacerMarks + oscSequences(line));
          continue;
        }

        flushPendingMarks();
        out.push(
          plan.row === FALLBACK_LABEL
            ? line
            : replaceVisibleThinkingLabel(line, `Thinking: ${plan.row}`, width),
        );
        activePreviewLineAt = out.length - 1;
        continue;
      }

      if (lastFallbackLabelAt >= 0) {
        let spacerMarks = "";
        while (out.length > lastFallbackLabelAt + 1) {
          spacerMarks = `${oscSequences(out.pop()!)}${spacerMarks}`;
        }
        queueMarks(lastFallbackLabelAt, spacerMarks + oscSequences(line));
        continue;
      }
      flushPendingMarks();
      activePreviewLineAt = -1;
      lastFallbackLabelAt = out.length;
      out.push(line);
      continue;
    }
    if (visible.length > 0) {
      flushPendingMarks();
      activePreviewLineAt = -1;
      lastFallbackLabelAt = -1;
    }
    out.push(line);
  }
  flushPendingMarks();
  return out;
}
