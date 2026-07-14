import { Markdown, truncateToWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

import { OSC_SEQUENCE, rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import type { AssistantRowDataLike } from "../_lib/chat.ts";
import { ELLIPSIS } from "../_lib/style.ts";

const PREVIEW_RENDER_WIDTH = 10_000;

// pi renders one collapsed label per non-empty thinking block. Traceline replaces a
// contiguous run of those labels with one logical multiline preview: every non-empty
// source line gets an informative `Thinking: …` row, source paragraph breaks survive,
// and Pi's spacers between provider-split adjacent blocks disappear. Any non-thinking
// content entry ends the run, even when Pi does not render that entry here (a tool call,
// for example). Empty thinking fragments neither render nor break adjacency. Payloads
// that cannot yield a safe preview keep one native label; labels without corresponding
// payloads retain the duplicate-label fallback. OSC marks move to the last kept run line.
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

const FALLBACK_LABEL = Symbol("fallback-label");
type ThinkingPreviewRow = ThinkingPreview | typeof FALLBACK_LABEL;

type ThinkingLabelPlan = {
  rows: ThinkingPreviewRow[];
  emitsGroup: boolean;
};

function thinkingLabelPlans(comp: AssistantRowDataLike): ThinkingLabelPlan[] {
  const content = comp.lastMessage?.content;
  if (!Array.isArray(content)) return [];

  const plans: ThinkingLabelPlan[] = [];
  let blocks: ThinkingPreview[][] = [];
  const flush = () => {
    if (blocks.length === 0) return;
    const rows: ThinkingPreviewRow[] = [];
    for (const previews of blocks) {
      if (previews.some((preview) => preview !== undefined)) {
        rows.push(...previews);
      } else if (rows.at(-1) !== FALLBACK_LABEL) {
        // A non-empty payload that sanitizes to nothing still needs one native label.
        // Consecutive such blocks keep the old duplicate-label fold inside the run.
        rows.push(FALLBACK_LABEL);
      }
    }
    for (let i = 0; i < blocks.length; i++) {
      plans.push({ rows, emitsGroup: i === 0 });
    }
    blocks = [];
  };

  for (const block of content) {
    if (block?.type === "thinking") {
      if (typeof block.thinking === "string" && block.thinking.trim().length > 0) {
        // Pi skips empty thinking blocks, so only rendered blocks receive a label plan.
        // Empty fragments still leave `blocks` open and therefore preserve adjacency.
        blocks.push(thinkingPreviewForTrace(block.thinking));
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
  return width && width > 0 ? truncateToWidth(replaced, Math.max(1, width), ELLIPSIS) : replaced;
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
          // the group's last preview now, never across a later semantic boundary.
          let spacerMarks = "";
          while (out.length > 0 && stripAnsi(out.at(-1)!).trim().length === 0) {
            spacerMarks = `${oscSequences(out.pop()!)}${spacerMarks}`;
          }
          queueMarks(activePreviewLineAt, spacerMarks + oscSequences(line));
          continue;
        }

        flushPendingMarks();
        let firstRow = true;
        for (const row of plan.rows) {
          if (row === undefined) {
            out.push("");
            continue;
          }
          // Only the first replacement inherits the native row's OSC zone marks.
          // Synthetic continuation rows keep its SGR styling but must not duplicate OSC.
          const template = firstRow ? line : line.replace(OSC_SEQUENCE, "");
          out.push(row === FALLBACK_LABEL ? template : replaceVisibleThinkingLabel(template, `Thinking: ${row}`, width));
          firstRow = false;
        }
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
