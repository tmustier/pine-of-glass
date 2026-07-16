// The peek pager (design language §9.13): a full-screen overlay opened from drill mode.
// The transcript beneath stays untouched, so esc returns to identical pixels. The panel
// speaks the §8 header form, then anchors on the row's own trace line and shows the
// full invocation (pi's call renderer, real newlines) and the complete result text,
// each section under a dim label. A folded read run renders one invocation and result
// section per call. Scrolling is offset-based line windowing; h/l switch to the
// neighbouring numbered target without closing.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import type { ToolRowLike } from "../_lib/chat.ts";
import { compactCount } from "../_lib/fmt.ts";
import { ELLIPSIS, SEP, ink, type Tone } from "../_lib/style.ts";
import { applyDigit, setSelected, togglePin, type DrillState } from "./drill.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const HEADER_LINES = 2;
const FOOTER_LINES = 1;
const SECTION_INDENT = "    ";

type TerminalSizeLike = { terminal?: { rows?: number } };

export class DrillPager implements Component {
  private readonly st: DrillState;
  private scroll = 0;
  private tui: TerminalSizeLike | undefined;
  private lastRowIndex: number;
  private cache: { row: unknown; result: unknown; width: number; lines: string[] } | undefined;

  constructor(st: DrillState) {
    this.st = st;
    this.lastRowIndex = st.selected;
  }

  attach(tui: TUI): void {
    this.tui = tui as TerminalSizeLike;
  }

  scrollBy(delta: number): void {
    this.scroll = Math.max(0, this.scroll + delta); // upper clamp happens at render, where the height is known
    this.st.host.requestRender();
  }

  private viewport(): number {
    const rows = this.tui?.terminal?.rows;
    const height = typeof rows === "number" && rows > 0 ? rows : 24;
    return Math.max(1, height - HEADER_LINES - FOOTER_LINES);
  }

  handleInput(data: string): void {
    const st = this.st;
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
      st.closePager?.();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) return this.scrollBy(-1);
    if (matchesKey(data, "down") || matchesKey(data, "j")) return this.scrollBy(1);
    if (matchesKey(data, "pageUp")) return this.scrollBy(-this.viewport());
    if (matchesKey(data, "pageDown") || matchesKey(data, "space")) return this.scrollBy(this.viewport());
    if (matchesKey(data, "g")) return this.scrollBy(-Number.MAX_SAFE_INTEGER);
    if (matchesKey(data, "shift+g")) return this.scrollBy(Number.MAX_SAFE_INTEGER);
    if (matchesKey(data, "left") || matchesKey(data, "h")) return setSelected(st, st.selected + 1); // older
    if (matchesKey(data, "right") || matchesKey(data, "l")) return setSelected(st, st.selected - 1); // newer
    if (matchesKey(data, "p")) return togglePin(st);
    for (let d = 0; d <= 9; d++) {
      if (matchesKey(data, String(d) as KeyId)) {
        applyDigit(st, String(d));
        return;
      }
    }
  }

  render(width: number): string[] {
    const st = this.st;
    const theme = st.host.theme();
    if (this.lastRowIndex !== st.selected) {
      this.lastRowIndex = st.selected;
      this.scroll = 0;
      this.cache = undefined;
    }
    const fit = (line: string) => truncateToWidth(line, Math.max(1, width), ELLIPSIS);
    const row = st.rows[st.selected];
    const brand = ink(theme, "accent", `${BOLD}[Traceline]${BOLD_OFF}`);
    const pending = st.digits ? `${ink(theme, "dim", SEP)}${ink(theme, "accent", `#${st.digits}`)}` : "";
    const head = `${brand} ${ink(theme, "dim", `peek${SEP}row ${st.selected + 1} of ${st.rows.length}`)}${pending}`;
    const hint = `  ${ink(theme, "dim", `esc close${SEP}j/k scroll${SEP}h/l switch row${SEP}p expand${SEP}g/G ends`)}`;
    if (!row) return [fit(head), fit(hint), fit(`  ${ink(theme, "dim", "row no longer available")}`)];

    const body = this.bodyLines(row, width);
    const viewport = this.viewport();
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - viewport));
    const view = body.slice(this.scroll, this.scroll + viewport);
    while (view.length < viewport) view.push(""); // cover the transcript to the full height
    const from = body.length === 0 ? 0 : this.scroll + 1;
    const to = Math.min(body.length, this.scroll + viewport);
    const footer = `  ${ink(theme, "dim", `lines ${from}-${to} of ${body.length}`)}`;
    return [head, hint, ...view, footer].map(fit);
  }

  private bodyLines(row: ToolRowLike, width: number): string[] {
    const streaming = (this.st.host.runRows(row) ?? [row]).some((call) => call.isPartial === true);
    const c = this.cache;
    if (!streaming && c && c.row === row && c.result === row.result && c.width === width) return c.lines;
    const lines = buildPagerBody(this.st, row, width);
    this.cache = streaming ? undefined : { row, result: row.result, width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

// --- body construction ------------------------------------------------------------------

function buildPagerBody(st: DrillState, row: ToolRowLike, width: number): string[] {
  const theme = st.host.theme();
  const contentWidth = Math.max(20, width - SECTION_INDENT.length);
  const lines: string[] = [...st.host.traceLines(row, width)];
  const calls = st.host.runRows(row) ?? [row];
  calls.forEach((call, index) => {
    const callLabel = calls.length > 1 ? `${SEP}call ${index + 1} of ${calls.length}` : "";
    lines.push("", `  ${ink(theme, "dim", `invocation${callLabel}`)}`);
    for (const line of invocationLines(call, contentWidth)) lines.push(`${SECTION_INDENT}${line}`);
    lines.push("", `  ${resultLabel(theme, st.host.statusTone(call), call)}`);
    for (const line of resultLines(theme, call, contentWidth)) lines.push(`${SECTION_INDENT}${line}`);
  });
  return lines;
}

function invocationLines(call: ToolRowLike, width: number): string[] {
  try {
    const out = call.callRendererComponent?.render?.(width);
    if (Array.isArray(out)) return out.map((line) => String(line));
  } catch {
    // Pi seam: a call renderer may throw mid-stream; fall through to the tool name.
  }
  return [typeof call.toolName === "string" ? call.toolName : "tool"];
}

function resultChars(call: ToolRowLike): number | undefined {
  const content = call.result?.content;
  if (!Array.isArray(content)) return undefined;
  let sum = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type === "text" && typeof textBlock.text === "string") sum += textBlock.text.length;
  }
  return sum;
}

function resultLabel(theme: Theme | undefined, tone: Tone, call: ToolRowLike): string {
  const word = tone === "error" ? "failed" : tone === "success" ? "success" : "running";
  const chars = resultChars(call);
  const size = chars !== undefined ? ink(theme, "dim", `${SEP}${compactCount(chars)} ch`) : "";
  return `${ink(theme, "dim", `result${SEP}`)}${ink(theme, tone, word)}${size}`;
}

function resultLines(theme: Theme | undefined, call: ToolRowLike, width: number): string[] {
  const content = call.result?.content;
  if (!Array.isArray(content)) return [ink(theme, "dim", "no output yet")];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type === "text" && typeof textBlock.text === "string") {
      const text = textBlock.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
      for (const raw of text.split("\n")) {
        if (raw.length === 0) {
          out.push("");
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(raw, width)) out.push(wrapped);
      }
    } else {
      out.push(ink(theme, "dim", `[${typeof textBlock.type === "string" ? textBlock.type : "block"}]`));
    }
  }
  if (out.length === 0) out.push(ink(theme, "dim", "(empty result)"));
  return out;
}
