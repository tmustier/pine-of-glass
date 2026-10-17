import type { Theme } from "@earendil-works/pi-coding-agent";
import { rawIndexAtVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject, stringValue } from "../_lib/boundary.ts";
import type { NoticeRowLike } from "../_lib/chat.ts";
import { ink } from "../_lib/style.ts";
import { stripTrailingExpandHint, trimLeadingVisibleWhitespace } from "./native-lines.ts";
import { dimUnstyledSpans, stripSgrBackgrounds, stripSgrForegrounds } from "./sgr.ts";

export function noticeBody(row: NoticeRowLike, theme: Theme | undefined) {
  const content = row.message?.content;
  const text = typeof content === "string" ? content
    : content?.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const source = row.message ?? row.entry;
  const metadata = row.message ? row.message.details : row.entry.data;
  const summary = isJsonObject(metadata) ? stringValue(metadata.summary)?.replace(/\s+/g, " ").trim() : undefined;
  let native: string | undefined;
  if (!summary) {
    try {
      // Capture wide enough to avoid truncating the extension's collapsed headline.
      native = row.customComponent?.render(10_000).find((line) => stripAnsi(line).trim());
    } catch {
      // An extension renderer can fail; its message text is still usable.
    }
  }
  let label = `[${source.customType}]`;
  let headline = summary ? ` ${ink(theme, "dim", summary)}` : "";
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
  } else if (!summary) {
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
  return { body: `${ink(theme, "text", `\x1b[1m${label}\x1b[22m`)}${headline}`, chars: text?.length };
}
