// The peek pager (design language §9.13): a full-screen overlay opened from drill mode.
// The transcript beneath stays untouched, so esc returns to identical pixels. The panel
// speaks the §8 header form, then anchors on the row's own trace line and shows the
// full invocation and the complete result, each section under a dim label. The pager is
// the fidelity surface: everything the model saw, the reader can see here; the section
// grammar (argument rows, image fact lines, foreign blocks) lives in
// drill-pager-content.ts. Inline images mirror pi's own native tool row and are atomic
// under the pager's offset-based line windowing: pixels render only when the whole cell
// block is inside the viewport, a partially scrolled image shows its dim hint line
// instead, and kitty image ids the pager allocated are deleted when it closes. A folded
// read run renders one invocation and result section per call. Scrolling is offset-based
// line windowing; h/l switch to the neighbouring numbered target without closing.

import {
  Image,
  deleteKittyImage,
  getCapabilities,
  matchesKey,
  truncateToWidth,
  type Component,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";
import { isJsonObject } from "../_lib/boundary.ts";
import { ELLIPSIS, SEP, ink } from "../_lib/style.ts";
import { applyDigit, setSelected, togglePin, type DrillState } from "./drill.ts";
import {
  codeContextFor,
  foreignBlockLine,
  imageFactLine,
  imagePixelSource,
  invocationLines,
  resultLabel,
  textBlockLines,
} from "./drill-pager-content.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const HEADER_LINES = 2;
const FOOTER_LINES = 1;
const SECTION_INDENT = "    ";

type PagerImage = { start: number; lines: string[] };
type PagerBody = { lines: string[]; images: PagerImage[] };
type CachedImage = { data: string; comp: Image };

// A crash mid-peek must not leave transmitted kitty images behind in the terminal:
// pager-owned terminal state has the same bounded lifecycle as the pager (§9.13).
const livePagers = new Set<DrillPager>();
let exitGuardInstalled = false;

export class DrillPager implements Component {
  private readonly st: DrillState;
  private scroll = 0;
  private tui: TUI | undefined;
  private lastRowIndex: number;
  private cache: { row: unknown; result: unknown; width: number; viewport: number; body: PagerBody } | undefined;
  private imageComps = new Map<string, CachedImage>();
  private imageCompsViewport = 0;

  constructor(st: DrillState) {
    this.st = st;
    this.lastRowIndex = st.selected;
  }

  attach(tui: TUI): void {
    this.tui = tui;
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
      this.disposeImages(); // the next row's blocks get fresh, correctly sized components
    }
    const fit = (line: string) => truncateToWidth(line, Math.max(1, width), ELLIPSIS);
    const row = st.rows[st.selected];
    const brand = ink(theme, "accent", `${BOLD}[Traceline]${BOLD_OFF}`);
    const pending = st.digits ? `${ink(theme, "dim", SEP)}${ink(theme, "accent", `#${st.digits}`)}` : "";
    const head = `${brand} ${ink(theme, "dim", `peek${SEP}row ${st.selected + 1} of ${st.rows.length}`)}${pending}`;
    const hint = `  ${ink(theme, "dim", `esc close${SEP}j/k scroll${SEP}h/l switch row${SEP}p expand${SEP}g/G ends`)}`;
    if (!row) return [fit(head), fit(hint), fit(`  ${ink(theme, "dim", "row no longer available")}`)];

    const viewport = this.viewport();
    const streaming = (this.st.host.runRows(row) ?? [row]).some((call) => call.isPartial === true);
    const c = this.cache;
    let body: PagerBody;
    if (!streaming && c && c.row === row && c.result === row.result && c.width === width && c.viewport === viewport) {
      body = c.body;
    } else {
      if (this.imageCompsViewport !== viewport) this.disposeImages(); // height caps are constructor-fixed
      this.imageCompsViewport = viewport;
      const st = this.st;
      const theme = st.host.theme();
      const contentWidth = Math.max(20, width - SECTION_INDENT.length);
      const fit = (line: string) => truncateToWidth(line, Math.max(1, width), ELLIPSIS);
      const lines: string[] = [...st.host.traceLines(row, width)];
      const images: PagerImage[] = [];
      const calls = st.host.runRows(row) ?? [row];
      calls.forEach((call, callIndex) => {
        const callLabel = calls.length > 1 ? `${SEP}call ${callIndex + 1} of ${calls.length}` : "";
        lines.push("", `  ${ink(theme, "dim", `invocation${callLabel}`)}`);
        for (const line of invocationLines(theme, call, contentWidth)) lines.push(fit(`${SECTION_INDENT}${line}`));
        // A composed call's ledger sits between what was asked and what came back (§9.14).
        const ledger = st.host.ledgerLines(call, width);
        if (ledger.length > 0) lines.push("", `  ${ink(theme, "dim", "calls")}`, ...ledger.map(fit));
        const code = codeContextFor(call);
        lines.push("", `  ${resultLabel(theme, st.host.statusTone(call), call, code?.language)}`);
        const content = call.result?.content;
        if (!Array.isArray(content)) {
          lines.push(fit(`${SECTION_INDENT}${ink(theme, "dim", "no output yet")}`));
          return;
        }
        const before = lines.length;
        let imageIndex = 0;
        for (const block of content) {
          if (!isJsonObject(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            for (const line of textBlockLines(theme, block.text, contentWidth, code)) {
              lines.push(line.length === 0 ? "" : fit(`${SECTION_INDENT}${line}`));
            }
          } else if (block.type === "image") {
            const blockImageIndex = imageIndex++;
            lines.push(truncateToWidth(`${SECTION_INDENT}${imageFactLine(theme, block)}`, Math.max(1, width), ELLIPSIS));
            const source = imagePixelSource(call, blockImageIndex, block);
            if (!source) continue;
            // One Image per result block keeps kitty ids stable until async conversion swaps data.
            const key = `${callIndex}:${blockImageIndex}`;
            const cached = this.imageComps.get(key);
            let comp: Image;
            if (cached && cached.data === source.data) comp = cached.comp;
            else {
              if (cached) deleteCompImage(cached.comp);
              comp = new Image(
                source.data,
                source.mimeType,
                { fallbackColor: (s: string) => ink(theme, "dim", s) },
                {
                  maxWidthCells: Math.max(10, contentWidth - 2),
                  // Fit inside the viewport (§9.13): full visibility must always be reachable,
                  // leaving room for the fact line above and one line of breathing space.
                  maxHeightCells: Math.max(4, viewport - 2),
                },
              );
              this.imageComps.set(key, { data: source.data, comp });
            }
            let rendered: string[];
            try {
              rendered = comp.render(contentWidth).map((line) => (line.length > 0 ? `${SECTION_INDENT}${line}` : line));
            } catch {
              continue; // Pi seam: a malformed payload keeps its fact line; pixels are best-effort.
            }
            if (rendered.length === 0) continue;
            // Placeholder lines hold the block's height in the scroll geometry; the hint sits on
            // the first and last line so a partial block explains itself from either direction.
            const hint = ink(theme, "dim", `${SECTION_INDENT}(image${SEP}scroll to view)`);
            const start = lines.length;
            for (let i = 0; i < rendered.length; i++) {
              lines.push(i === 0 || i === rendered.length - 1 ? hint : "");
            }
            images.push({ start, lines: rendered });
            livePagers.add(this);
            if (!exitGuardInstalled) {
              exitGuardInstalled = true;
              process.on("exit", () => {
                for (const pager of livePagers) pager.dispose();
              });
            }
          } else {
            lines.push(fit(`${SECTION_INDENT}${foreignBlockLine(theme, block)}`));
          }
        }
        if (lines.length === before) lines.push(fit(`${SECTION_INDENT}${ink(theme, "dim", "(empty result)")}`));
      });
      body = { lines, images };
      this.cache = streaming ? undefined : { row, result: row.result, width, viewport, body };
    }
    this.scroll = Math.min(this.scroll, Math.max(0, body.lines.length - viewport));
    const view = body.lines.slice(this.scroll, this.scroll + viewport);
    // An inline image is atomic (§9.13): its escape-sequence block substitutes over its
    // placeholder lines only when the whole block sits inside the window. A partial
    // block keeps the placeholder hint; a sliced image sequence would overdraw chrome.
    for (const image of body.images) {
      if (image.start < this.scroll || image.start + image.lines.length > this.scroll + viewport) continue;
      for (let i = 0; i < image.lines.length; i++) view[image.start - this.scroll + i] = image.lines[i]!;
    }
    while (view.length < viewport) view.push(""); // cover the transcript to the full height
    const from = body.lines.length === 0 ? 0 : this.scroll + 1;
    const to = Math.min(body.lines.length, this.scroll + viewport);
    const footer = `  ${ink(theme, "dim", `lines ${from}-${to} of ${body.lines.length}`)}`;
    return [fit(head), fit(hint), ...view, fit(footer)];
  }

  invalidate(): void {
    this.cache = undefined;
  }

  /** Delete every kitty image id this pager allocated; idempotent, safe at exit. */
  dispose(): void {
    this.disposeImages();
    livePagers.delete(this);
  }

  private disposeImages(): void {
    if (this.imageComps.size === 0) return;
    for (const cached of this.imageComps.values()) deleteCompImage(cached.comp);
    this.imageComps.clear();
  }
}

function deleteCompImage(comp: Image): void {
  if (getCapabilities().images !== "kitty") return; // only kitty stores images by id
  const id = comp.getImageId();
  if (id === undefined) return;
  try {
    process.stdout.write(deleteKittyImage(id));
  } catch {
    // Terminal already gone; nothing to clean up.
  }
}
