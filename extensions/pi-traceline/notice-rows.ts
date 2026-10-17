// Notice rows (design language §9.15): the one-line form of an extension's custom
// message or custom entry. The row is `[label] headline`; this module decides the
// headline and its ink, and installs the same geometry substitution tool rows get:
// compact at z0, the extension's own block at z1 and z2. Spacing, the rail and the
// fact cell come from the host (index.ts), which owns the trace-row grammar.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { rawIndexAtVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject, stringValue } from "../_lib/boundary.ts";
import { noticeSource, type NoticeRowDataLike, type NoticeRowLike, type NoticeRowPrototypeLike } from "../_lib/chat.ts";
import { ELLIPSIS, GLYPH, ink, rightAlignSuffix } from "../_lib/style.ts";
import { stripTrailingExpandHint, trimLeadingVisibleWhitespace } from "./native-lines.ts";
import { dimUnstyledSpans, stripSgrBackgrounds, stripSgrForegroundsExcept } from "./sgr.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
// Wide enough that no collapsed rendering truncates before the headline is read.
const CAPTURE_WIDTH = 10_000;
const NOTICE_ROW_PATCH_VERSION = 1;

/** Pi's per-row expansion flag, as written by setExpanded(). */
export function noticeExpanded(row: NoticeRowDataLike): boolean {
  return row._expanded === true;
}

/** The text pi sends to the model for a custom message; undefined for an entry. */
export function noticeContentText(row: NoticeRowDataLike): string | undefined {
  const content = noticeSource(row).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .flatMap((block) => {
      const text = isJsonObject(block) && block.type === "text" ? stringValue(block.text) : undefined;
      return text === undefined ? [] : [text];
    })
    .join("\n");
}

/** Chars the model read from a custom message (§9.7's size cell); undefined for an entry. */
export function noticeContentChars(row: NoticeRowDataLike): number | undefined {
  return noticeContentText(row)?.length;
}

// The first line a reader would take as the message: Markdown heading, quote and
// list markers go, inline emphasis and code ticks go, link text stays.
export function firstMeaningfulLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (line && !/^[-*_]{3,}$/.test(line)) return line;
  }
  return undefined;
}

// A `summary` string placed in a message's details or an entry's data: the explicit
// one-line contract an extension can adopt without knowing Traceline's internals.
function explicitSummary(row: NoticeRowDataLike): string | undefined {
  const source = noticeSource(row);
  for (const holder of [source.details, source.data]) {
    const summary = isJsonObject(holder) ? stringValue(holder.summary) : undefined;
    if (summary?.trim()) return summary.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

// The first line of the extension's own collapsed rendering, the sentence its author
// chose for the collapsed state, without the key hint.
function collapsedRenderingLine(row: NoticeRowDataLike): string | undefined {
  const component = row.customComponent;
  if (typeof component?.render !== "function") return undefined;
  try {
    const lines = component.render(CAPTURE_WIDTH);
    if (!Array.isArray(lines)) return undefined;
    const first = lines.find((line): line is string => typeof line === "string" && stripAnsi(line).trim().length > 0);
    return first ? trimLeadingVisibleWhitespace(stripTrailingExpandHint(first).trimEnd()) : undefined;
  } catch {
    return undefined; // Pi seam: a renderer that throws here still gets its native block at z1
  }
}

// The SGR openers of the theme's status tones: the one ink an author applied on purpose.
function statusOpeners(theme: Theme | undefined): Set<string> {
  const openers = new Set<string>();
  if (!theme) return openers;
  for (const tone of ["success", "warning", "error"] as const) {
    const sample = ink(theme, tone, "x");
    const open = sample.slice(0, sample.indexOf("x"));
    if (open) openers.add(open);
  }
  return openers;
}

function labelInk(theme: Theme | undefined, label: string): string {
  return ink(theme, "text", `${BOLD}${label}${BOLD_OFF}`);
}

/** The inked `[label] headline` body of a notice row (§9.15). */
export function noticeHeadline(row: NoticeRowDataLike, theme: Theme | undefined): string {
  const label = `[${noticeSource(row).customType}]`;
  const summary = explicitSummary(row);
  if (summary) return `${labelInk(theme, label)} ${ink(theme, "dim", summary)}`;
  const native = collapsedRenderingLine(row);
  if (native) {
    // Status ink survives, apparatus ink does not: backgrounds and non-status
    // foregrounds drop, unstyled spans demote to dim. The author's own leading
    // `[label]` takes the verb's bold neutral whatever ink it arrived in.
    const demote = (text: string) => dimUnstyledSpans(stripSgrForegroundsExcept(stripSgrBackgrounds(text), statusOpeners(theme)), theme);
    const own = stripAnsi(native).match(/^\[[^\]]+\]/)?.[0];
    if (!own) return `${labelInk(theme, label)} ${demote(native)}`;
    const rest = native.slice(rawIndexAtVisibleIndex(native, own.length));
    return `${labelInk(theme, own)}${demote(rest)}`;
  }
  const content = noticeContentText(row);
  const line = content ? firstMeaningfulLine(content) : undefined;
  return line ? `${labelInk(theme, label)} ${ink(theme, "dim", line)}` : labelInk(theme, label);
}

/** What the trace-row grammar lends a notice row. */
export interface NoticeRowHost {
  theme: () => Theme | undefined;
  /** true while reasoning is hidden: the trace is the view (z0) */
  compact: () => boolean;
  /** Drill mode owns the pointer while open (§9.13) */
  drillActive: () => boolean;
  /** the indented rail and the given bullet, as every trace row opens */
  railPrefix: (bullet: string) => string;
  /** the body+suffix budget inside the two-sided inset */
  available: (width: number) => number;
  charSuffix: (chars: number | undefined) => string;
  leadingBlank: (row: NoticeRowLike) => boolean;
  /** the row's expansion changed: its neighbours re-derive spacing and columns */
  changed: (row: NoticeRowLike) => void;
}

// `[label] headline` behind the rail, the bullet in pi's own custom-message label ink
// (not a status tone: a notice has no success or failure), the char cell at the block's
// shared right edge when the message carried model-facing text.
function noticeTraceLine(row: NoticeRowLike, width: number, host: NoticeRowHost): string {
  const theme = host.theme();
  const bullet = theme ? theme.fg("customMessageLabel", GLYPH.tool) : GLYPH.tool;
  const suffix = host.charSuffix(noticeContentChars(row));
  const fitted = rightAlignSuffix(noticeHeadline(row, theme), suffix, host.available(width), theme);
  return truncateToWidth(`${host.railPrefix(bullet)}${fitted}`, Math.max(1, width), ELLIPSIS);
}

export function renderNoticeRow(row: NoticeRowLike, width: number, host: NoticeRowHost): string[] {
  const line = noticeTraceLine(row, width, host);
  return host.leadingBlank(row) ? ["", line] : [line];
}

// Prototypes patched by this module instance. A reload evaluates the module afresh and
// re-wraps from the saved originals, so wrappers never stack.
const patched = new WeakSet<object>();

/**
 * Give a notice component class the zoom ladder (§9.12): compact geometry while the
 * trace is the view and the row is collapsed, the extension's own block otherwise.
 * Expansion is pi's per-row flag, so Ctrl+O and a click agree. Returns true when this
 * call patched the prototype.
 */
export function installNoticeRows(proto: NoticeRowPrototypeLike, host: NoticeRowHost): boolean {
  if (patched.has(proto) && proto.__tracelineNoticePatchVersion === NOTICE_ROW_PATCH_VERSION) return false;
  if (typeof proto.render !== "function" || typeof proto.setExpanded !== "function") return false;
  const originalRender = proto.__tracelineOriginalNoticeRender ?? proto.render;
  const originalMouse = proto.__tracelineOriginalNoticeMouse ?? proto.handleMouse;
  const originalSetExpanded = proto.__tracelineOriginalNoticeSetExpanded ?? proto.setExpanded;
  proto.__tracelineOriginalNoticeRender = originalRender;
  proto.__tracelineOriginalNoticeMouse = originalMouse;
  proto.__tracelineOriginalNoticeSetExpanded = originalSetExpanded;
  const layouts = new WeakMap<NoticeRowLike, { width: number; lines: string[] }>();
  const compact = (row: NoticeRowLike) => host.compact() && !noticeExpanded(row);
  proto.render = function (this: NoticeRowLike, width: number): string[] {
    layouts.delete(this);
    if (!compact(this)) return originalRender.call(this, width);
    try {
      const lines = renderNoticeRow(this, width, host);
      layouts.set(this, { width, lines: lines.map(stripAnsi) });
      return lines;
    } catch {
      return originalRender.call(this, width); // Pi seam: a failed compact render keeps native geometry
    }
  };
  proto.handleMouse = function (this: NoticeRowLike, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (host.drillActive()) return undefined; // preserve Drill's frozen keyboard targets
    const click = event.type === "click" && event.button === "left";
    const layout = layouts.get(this);
    if (!layout) {
      // The opened block collapses on a click while the trace is the view; z2 is pi's.
      if (click && host.compact()) { this.setExpanded(false); return { handled: true }; }
      return originalMouse?.call(this, event);
    }
    if (!click || layout.width !== event.width) return undefined;
    const line = layout.lines[event.y];
    if (!line?.trim() || event.x < 2 || event.x >= event.width - 2) return undefined;
    this.setExpanded(true);
    return { handled: true };
  };
  proto.setExpanded = function (this: NoticeRowLike, expanded: boolean): void {
    originalSetExpanded.call(this, expanded);
    host.changed(this);
  };
  proto.__tracelineNoticePatchVersion = NOTICE_ROW_PATCH_VERSION;
  patched.add(proto);
  return true;
}
