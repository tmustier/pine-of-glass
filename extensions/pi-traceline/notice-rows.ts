// Extension notices borrow the trace geometry at z0 and keep Pi's own block at z1/z2.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { rawIndexAtVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject, stringValue } from "../_lib/boundary.ts";
import type { NoticeRowLike, NoticeRowPrototypeLike } from "../_lib/chat.ts";
import { ELLIPSIS, GLYPH, ink, rightAlignSuffix } from "../_lib/style.ts";
import { stripTrailingExpandHint, trimLeadingVisibleWhitespace } from "./native-lines.ts";
import { dimUnstyledSpans, stripSgrBackgrounds, stripSgrForegrounds } from "./sgr.ts";

// Wide enough to read the collapsed headline without truncation.
const CAPTURE_WIDTH = 10_000;

export interface NoticeRowHost {
  theme: () => Theme | undefined;
  compact: () => boolean;
  drillActive: () => boolean;
  railPrefix: (bullet: string) => string;
  available: (width: number) => number;
  charSuffix: (chars: number | undefined) => string;
  leadingBlank: (row: NoticeRowLike) => boolean;
  changed: (row: NoticeRowLike) => void;
}

// Each reload re-wraps the saved originals with the new host, without stacking wrappers.
const patched = new WeakSet<NoticeRowPrototypeLike>();

export function installNoticeRows(proto: NoticeRowPrototypeLike, host: NoticeRowHost): boolean {
  if (patched.has(proto)) return false;
  const originalRender = proto.__tracelineOriginalNoticeRender ?? proto.render;
  const originalMouse = proto.__tracelineOriginalNoticeMouse ?? proto.handleMouse;
  const originalSetExpanded = proto.__tracelineOriginalNoticeSetExpanded ?? proto.setExpanded;
  proto.__tracelineOriginalNoticeRender = originalRender;
  proto.__tracelineOriginalNoticeMouse = originalMouse;
  proto.__tracelineOriginalNoticeSetExpanded = originalSetExpanded;
  const layouts = new WeakMap<NoticeRowLike, { width: number; y: number }>();
  proto.render = function (this: NoticeRowLike, width: number): string[] {
    layouts.delete(this);
    if (!host.compact() || this._expanded) return originalRender.call(this, width);
    const theme = host.theme();
    const content = this.message?.content;
    const text = typeof content === "string" ? content
      : content?.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const source = this.message ?? this.entry;
    const metadata = this.message ? this.message.details : this.entry.data;
    const summary = isJsonObject(metadata) ? stringValue(metadata.summary)?.replace(/\s+/g, " ").trim() : undefined;
    let label = `[${source.customType}]`;
    let headline = "";
    if (summary) {
      headline = ` ${ink(theme, "dim", summary)}`;
    } else {
      let native: string | undefined;
      try {
        native = this.customComponent?.render(CAPTURE_WIDTH).find((line) => stripAnsi(line).trim());
      } catch {
        // An extension component may fail at the capture width; use its message text.
      }
      if (native) {
        native = trimLeadingVisibleWhitespace(stripTrailingExpandHint(native).trimEnd());
        const ownLabel = stripAnsi(native).match(/^\[[^\]]+\]/)?.[0];
        if (ownLabel) {
          label = ownLabel;
          native = native.slice(rawIndexAtVisibleIndex(native, ownLabel.length));
        } else {
          native = ` ${native}`;
        }
        const statusOpeners = new Set((["success", "warning", "error"] as const).map((tone) => {
          const sample = ink(theme, tone, "x");
          return sample.slice(0, sample.indexOf("x"));
        }));
        const filtered = stripSgrBackgrounds(native).replace(/\x1b\[[0-9;]*m/g,
          (seq) => statusOpeners.has(seq) ? seq : stripSgrForegrounds(seq));
        headline = dimUnstyledSpans(filtered, theme);
      } else {
        for (const raw of text?.split(/\r?\n/) ?? []) {
          const line = raw.trim()
            .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
            .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
            .replace(/`([^`]*)`/g, "$1")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/\s+/g, " ").trim();
          if (!line || /^[-*_]{3,}$/.test(line)) continue;
          headline = ` ${ink(theme, "dim", line)}`;
          break;
        }
      }
    }
    const labelText = ink(theme, "text", `\x1b[1m${label}\x1b[22m`);
    const body = `${labelText}${headline}`;
    const suffix = host.charSuffix(text?.length);
    const fitted = rightAlignSuffix(body, suffix, host.available(width), theme);
    const bullet = theme ? theme.fg("customMessageLabel", GLYPH.tool) : GLYPH.tool;
    const line = truncateToWidth(`${host.railPrefix(bullet)}${fitted}`, Math.max(1, width), ELLIPSIS);
    const lines = host.leadingBlank(this) ? ["", line] : [line];
    layouts.set(this, { width, y: lines.length - 1 });
    return lines;
  };
  proto.handleMouse = function (this: NoticeRowLike, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (host.drillActive()) return undefined;
    const click = event.type === "click" && event.button === "left";
    const layout = layouts.get(this);
    if (!layout) {
      if (click && host.compact()) { this.setExpanded(false); return { handled: true }; }
      return originalMouse?.call(this, event);
    }
    if (!click || layout.width !== event.width || layout.y !== event.y || event.x < 2 || event.x >= event.width - 2) return undefined;
    this.setExpanded(true);
    return { handled: true };
  };
  proto.setExpanded = function (this: NoticeRowLike, expanded: boolean): void {
    originalSetExpanded.call(this, expanded);
    host.changed(this);
  };
  patched.add(proto);
  return true;
}
