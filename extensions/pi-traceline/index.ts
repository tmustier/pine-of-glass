import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OSC_SEQUENCE, rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { captureTui } from "../_lib/capture.ts";
import { findChatContainer, isAssistantRow, isToolRow } from "../_lib/chat.ts";
import { configPaths, readJsonConfig } from "../_lib/config.ts";
import { compactCount } from "../_lib/fmt.ts";
import {
  ELLIPSIS,
  GLYPH,
  SEP,
  SIZE_THRESHOLDS,
  ink,
  middleTruncate,
  rightAlignSuffix,
  sizeTone,
  tildify,
  type SizeThresholds,
  type Tone,
} from "../_lib/style.ts";

/**
 * pi-traceline — collapse each tool call to one scannable trace line so the full arc of
 * a turn (which path pi took, what context it pulled, which outputs ballooned) reads at
 * a glance. Tool rows follow pi's reasoning-visibility toggle (Ctrl+T).
 *
 * pi's built-in Ctrl+T hides/shows model reasoning (collapsing each thinking block to
 * a dim "Thinking..." line). This extension makes tool rows track that same state, so
 * Ctrl+T toggles between two states:
 *   native   = reasoning shown  + pi's native tool rows, unchanged by this extension
 *   one-line = reasoning hidden + each tool row collapsed to one invocation trace line
 *
 * pi announces that toggle with a dim "Thinking blocks: hidden/visible" status line at
 * the chat tail. Under traceline the flip is self-evident (every tool row visibly
 * collapses or expands), so that status pair is suppressed before it renders (§12.24);
 * every other showStatus message passes through untouched.
 *
 * One-line rendering reuses pi's native tool call renderer for most tools, so visual
 * defaults (accent paths/backticks, warning line ranges, custom renderers) drift with pi;
 * bash rows re-ink their body from the rendered *text* instead, so the wall of commands
 * stays quiet. Rows are intentionally unbanded by default (the edit-tool look): status
 * stays in the bullet and severity suffixes, while the old pi-background borrowing path
 * remains behind a config flag for easy rollback. Multiline bash commands are flattened
 * into the one trace line with a dim ↵ marking each original break, so heredocs and
 * inline scripts keep their operative tail instead of collapsing to `$ python3 -c "`.
 * The ink follows the family hierarchy (docs/design-language.md, amended §12): every
 * trace row opens with a dim `▏` rail so a run of tool rows fuses into one visible
 * block against assistant prose; verbs are neutral bold with status in the › bullet
 * (failed rows tint the discriminators — verb, bash head, basename — error, §12.14);
 * bash bodies sit at the one L3-dim supporting grey with the informative command
 * heads L0-bold (§12.20/§12.25/§12.26: sequencers — space-delimited or attached `;`,
 * quote-aware — and flattened `↵` breaks start new commands; pipes and redirects
 * continue one; heredoc bodies are inert; `cd`/`set` preambles and echo/true-style
 * plumbing only wear a crown when no real command does), and native rows for other
 * tools demote unstyled spans to dim (§12.12); the boilerplate
 * `(timeout Ns)` suffix is dropped — the full invocation is one Ctrl+T away.
 * Home-dir prefixes are tildified, and over-long invocations are *middle*-truncated with
 * a dimmed `…` so the tail survives — the basename + `:line-range` for a path, or the
 * operative end of a command — because that is where the discriminating information lives;
 * the cut snaps to a nearby `/` or space. Plain file reads, edits, and writes additionally
 * dim the directory so the basename stands out. Once a result exists, a right-aligned `1.2k ch` result-size
 * suffix is reserved at the end — dim while healthy, warning-/error-tinted when an output
 * balloons past the size thresholds, so "what flooded the context" pops out of the column.
 * Rows render into a 2-column right inset mirroring the left gutter (§12.21), with a
 * ≥2-space gap between body and suffix, so the block nests on both sides and truncated
 * tails stop crowding the facts.
 * Results under 100 ch render no char suffix (§12.13) unless a neighbouring row in the
 * same block clears the floor — the column is block-scoped (§12.15), so a live column
 * shows every cell and stays vertically aligned, while an all-tiny block stays clean. File-mutation rows with a real diff also reserve `+N -M` in that suffix
 * (zero sides dropped: `+2 -0` → `+2`), so the collapsed trace shows how much the
 * model changed without expanding the row.
 * All ink is theme-derived (style.ts ink()), with raw-ANSI fallbacks before a theme exists.
 *
 * Repetition the model emits is folded rather than re-printed (issue #14): a bash row
 * whose `cd <dir> && ` preamble repeats the previous bash row's renders it as a dim `⋯`,
 * giving the width back to the part of the command that differs; consecutive reads paging
 * through one file collapse into a single `read path:1-200,201-400 · 2 calls` row; and an
 * assistant message whose adjacent thinking blocks would print repeated collapsed thinking
 * labels gets one `Thinking: <first reasoning line>` preview.
 *
 * Spacing: one blank line before a tool group (restoring the spacer pi drops), none
 * between consecutive tools. One-shot click mode toggles a clicked row only, without
 * changing Pi's global tool expansion state.
 *
 * Nothing in pi's node_modules is modified, so this survives `pi update`.
 */

type ToolDisplayMode = "native" | "oneLine";

type ToolHit = {
  start: number;
  end: number;
  comp: any;
};

type TracelineGlobal = typeof globalThis & {
  __tracelinePatched?: boolean;
  __tracelinePatchVersion?: number;
  __tracelineContainerPatchVersion?: number;
  __tracelineTui?: any;
  __tracelineChat?: any;
  __tracelineInputUnsubscribe?: () => void;
  __tracelineLayoutActive?: boolean;
  __tracelineLayoutRow?: number;
  __tracelineLayoutHits?: ToolHit[];
  __tracelineHitMap?: ToolHit[];
  __tracelineTotalRows?: number;
  __tracelineClickEnabled?: boolean;
  __tracelineClickOneShot?: boolean;
  __tracelineClickArmTimer?: ReturnType<typeof setTimeout>;
  __tracelineMouseReportingEnabled?: boolean;
  __tracelineGetTheme?: () => Theme | undefined;
  __tracelineAssistantPatchVersion?: number;
};
const g = globalThis as TracelineGlobal;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const TOOL_RAIL = GLYPH.rail;
const TOOL_BULLET = GLYPH.tool;
const TOOL_INDENT = "  "; // trace blocks nest one gutter under the prose margin (§12.8)
const TOOL_AFTER_BULLET = " ";
// indent + ▏ + space + › + space — six visible columns; prose owns the margin.
const TOOL_PREFIX_VISIBLE_WIDTH = TOOL_INDENT.length + 2 + 1 + TOOL_AFTER_BULLET.length;
// The block nests on both sides (§12.21): a 2-column right inset mirrors the left
// gutter, so the suffix column never touches the terminal edge.
const TOOL_RIGHT_MARGIN = 2;
const ONE_LINE_CAPTURE_WIDTH = 10_000;
const LINE_BREAK_MARK = "\u21b5"; // ↵ — marks a real newline in a flattened invocation
const PREAMBLE_MARK = "\u22ef"; // ⋯ — stands in for a preamble identical to the row above
const TRACELINE_PATCH_VERSION = 25;
const TRACELINE_CONTAINER_PATCH_VERSION = 1;
const TRACELINE_ASSISTANT_PATCH_VERSION = 2;

// --- theme-derived ink (design language §3) --------------------------------------------
// The live Theme handle is captured at session_start; before that (and in unit tests
// without one) ink() falls back to basic raw ANSI.

function currentTheme(): Theme | undefined {
  try {
    return g.__tracelineGetTheme?.();
  } catch {
    return undefined;
  }
}

function dim(text: string): string {
  return ink(currentTheme(), "dim", text);
}
const MOUSE_REPORTING_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_REPORTING_DISABLE = "\x1b[?1000l\x1b[?1006l";

// --- chat container (holds assistant + tool rows as siblings) -------------------------
// Structural detection (isToolRow / isAssistantRow / findChatContainer) lives in _lib
// and is shared across the extension family.

function chatChildren(): any[] | undefined {
  let chat = g.__tracelineChat;
  if (!chat || !Array.isArray(chat.children)) {
    chat = g.__tracelineTui ? findChatContainer(g.__tracelineTui) : undefined;
    g.__tracelineChat = chat;
  }
  return chat?.children;
}

// --- reasoning-visibility = source of truth for tool collapse -------------------------

function readHideThinkingFromDisk(): boolean {
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8");
    return JSON.parse(raw).hideThinkingBlock ?? false;
  } catch {
    return false;
  }
}

// True when pi is currently hiding reasoning. Read from a live assistant row so tool
// visibility can never desync from reasoning; fall back to disk before any row exists.
function thinkingHidden(): boolean {
  const sibs = chatChildren();
  if (sibs) {
    for (let i = sibs.length - 1; i >= 0; i--) {
      if (isAssistantRow(sibs[i])) return sibs[i].hideThinkingBlock;
    }
  }
  return readHideThinkingFromDisk();
}

function displayMode(): ToolDisplayMode {
  return thinkingHidden() ? "oneLine" : "native";
}

// --- suppressing pi's Ctrl+T status line (design language §12.24) ---------------------
// pi's toggleThinkingBlockVisibility appends a dim "Thinking blocks: hidden/visible"
// status pair (Spacer + Text) to the chat tail — a holdover from when the toggle's only
// visible effect was each thinking block collapsing to a label. With traceline loaded
// the flip is self-evident (every tool row collapses to a trace line or expands back),
// so the label is redundant noise; drop the pair inside the requestRender that
// announces it, before it ever reaches the screen. Other showStatus messages
// ("Forked to new session", …) are announcements of otherwise-invisible actions and
// pass through untouched.
const THINKING_TOGGLE_STATUS = /^Thinking blocks: (?:hidden|visible)$/;

function isThinkingToggleStatusRow(comp: any): boolean {
  return (
    !!comp &&
    typeof comp.text === "string" &&
    typeof comp.setText === "function" &&
    THINKING_TOGGLE_STATUS.test(stripAnsi(comp.text).trim())
  );
}

// pi's showStatus pairs the Text with a one-line Spacer; drop that too so no stray
// blank line accumulates at the chat tail.
function isSpacerRow(comp: any): boolean {
  return !!comp && typeof comp.setLines === "function" && typeof comp.lines === "number" && !("text" in comp);
}

function suppressThinkingToggleStatus(): void {
  const sibs = chatChildren();
  if (!sibs || sibs.length === 0 || !isThinkingToggleStatusRow(sibs[sibs.length - 1])) return;
  sibs.pop();
  if (sibs.length > 0 && isSpacerRow(sibs[sibs.length - 1])) sibs.pop();
}

// --- click-to-expand hit testing ------------------------------------------------------

function envEnablesPersistentClicks(): boolean {
  const value = (process.env.PI_TRACELINE_CLICK ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

function shouldEnableClicks(): boolean {
  if (g.__tracelineClickEnabled === undefined) {
    // Mouse reporting steals wheel/trackpad scrolling from the terminal. Keep it off by
    // default, unless the user explicitly opts into persistent click handling.
    g.__tracelineClickEnabled = envEnablesPersistentClicks();
  }
  return g.__tracelineClickEnabled;
}

function clearClickArmTimer(): void {
  if (!g.__tracelineClickArmTimer) return;
  clearTimeout(g.__tracelineClickArmTimer);
  g.__tracelineClickArmTimer = undefined;
}

function enableMouseReporting(): void {
  if (!shouldEnableClicks() || g.__tracelineMouseReportingEnabled) return;
  if (!process.stdout.isTTY) return;
  process.stdout.write(MOUSE_REPORTING_ENABLE);
  g.__tracelineMouseReportingEnabled = true;
}

function disableMouseReporting(): void {
  if (!g.__tracelineMouseReportingEnabled) return;
  if (process.stdout.isTTY) process.stdout.write(MOUSE_REPORTING_DISABLE);
  g.__tracelineMouseReportingEnabled = false;
}

function setClickHandling(enabled: boolean, options: { oneShot?: boolean; ttlMs?: number } = {}): void {
  clearClickArmTimer();
  g.__tracelineClickEnabled = enabled;
  g.__tracelineClickOneShot = enabled && options.oneShot === true;

  if (enabled) {
    enableMouseReporting();
    // Hit-map layout tracking only runs while clicks are enabled; render now so the
    // map is populated before the click lands.
    g.__tracelineTui?.requestRender?.(true);
    if (g.__tracelineClickOneShot && options.ttlMs && options.ttlMs > 0) {
      g.__tracelineClickArmTimer = setTimeout(() => {
        if (g.__tracelineClickOneShot) setClickHandling(false);
      }, options.ttlMs);
    }
  } else {
    g.__tracelineClickOneShot = false;
    disableMouseReporting();
  }
}

function armClickOnce(ttlMs = 8_000): void {
  setClickHandling(true, { oneShot: true, ttlMs });
}

function findContainerPrototype(tui: any): any {
  let proto = Object.getPrototypeOf(tui);
  while (proto) {
    if (proto.constructor?.name === "Container" && typeof proto.render === "function") return proto;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

function registerToolHit(comp: any, start: number, end: number): void {
  if (!g.__tracelineLayoutActive || end < start) return;
  g.__tracelineLayoutHits?.push({ start, end, comp });
}

function withLayoutSuppressed<T>(fn: () => T): T {
  const wasActive = g.__tracelineLayoutActive;
  g.__tracelineLayoutActive = false;
  try {
    return fn();
  } finally {
    g.__tracelineLayoutActive = wasActive;
  }
}

function patchContainerPrototype(tui: any): void {
  const proto = findContainerPrototype(tui);
  if (!proto || proto.__tracelineContainerPatchVersion === TRACELINE_CONTAINER_PATCH_VERSION) {
    return;
  }

  const original = proto.__tracelineOriginalRender ?? proto.render;
  proto.__tracelineOriginalRender = original;
  proto.render = function (width: number) {
    if (!g.__tracelineLayoutActive || !Array.isArray(this.children)) {
      return original.call(this, width);
    }

    const lines: string[] = [];
    for (const child of this.children) {
      const start = g.__tracelineLayoutRow ?? 0;
      const rendered = typeof child?.render === "function" ? child.render(width) : [];
      const childLines = Array.isArray(rendered) ? rendered : [];
      if (isToolRow(child)) registerToolHit(child, start, start + childLines.length - 1);
      g.__tracelineLayoutRow = start + childLines.length;
      for (const line of childLines) lines.push(line);
    }
    return lines;
  };
  proto.__tracelineContainerPatchVersion = TRACELINE_CONTAINER_PATCH_VERSION;
}

function wrapTuiRender(tui: any): void {
  if (!tui || tui.__tracelineRenderWrapVersion === TRACELINE_PATCH_VERSION) return;

  const original = tui.__tracelineOriginalRender ?? tui.render;
  tui.__tracelineOriginalRender = original;
  tui.render = function (width: number) {
    if (g.__tracelineLayoutActive) return original.call(this, width);
    // Hit-map tracking exists only for click-to-expand. Clicks are opt-in, so the
    // tracking pass must cost nothing while they are off.
    if (!shouldEnableClicks()) {
      g.__tracelineHitMap = undefined;
      return original.call(this, width);
    }

    g.__tracelineLayoutActive = true;
    g.__tracelineLayoutRow = 0;
    g.__tracelineLayoutHits = [];
    try {
      const lines = original.call(this, width);
      g.__tracelineHitMap = g.__tracelineLayoutHits ?? [];
      g.__tracelineTotalRows = Array.isArray(lines) ? lines.length : 0;
      return lines;
    } finally {
      g.__tracelineLayoutActive = false;
      g.__tracelineLayoutRow = undefined;
      g.__tracelineLayoutHits = undefined;
    }
  };
  tui.__tracelineRenderWrapVersion = TRACELINE_PATCH_VERSION;
}

type SgrMouseEvent = {
  code: number;
  col: number;
  row: number;
  isPress: boolean;
};

function parseSgrMouse(data: string): SgrMouseEvent | undefined {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
  if (!match) return undefined;
  return {
    code: Number.parseInt(match[1]!, 10),
    col: Number.parseInt(match[2]!, 10),
    row: Number.parseInt(match[3]!, 10),
    isPress: match[4] === "M",
  };
}

function isLeftMousePress(event: SgrMouseEvent): boolean {
  if (!event.isPress) return false;
  if ((event.code & 64) !== 0) return false; // wheel event
  return (event.code & 3) === 0;
}

function toolAtViewportRow(row: number): any | undefined {
  const hits = g.__tracelineHitMap ?? [];
  if (hits.length === 0) return undefined;

  const totalRows = g.__tracelineTotalRows ?? 0;
  const terminalRows = Math.max(1, Number(g.__tracelineTui?.terminal?.rows ?? process.stdout.rows ?? 24));
  const lineIndex = Math.max(0, totalRows - terminalRows) + row - 1;

  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]!;
    if (lineIndex >= hit.start && lineIndex <= hit.end) return hit.comp;
  }
  return undefined;
}

function toolIsIndividuallyExpanded(comp: any): boolean {
  return comp?.__tracelineIndividuallyExpanded === true;
}

function setToolExpanded(comp: any, expanded: boolean): void {
  comp.__tracelineIndividuallyExpanded = expanded;
  try {
    if (typeof comp.setExpanded === "function") comp.setExpanded(expanded);
    else comp.expanded = expanded;
    comp.invalidate?.();
  } catch {
    /* ignore row-local expansion failures */
  }
}

function toggleClickedTool(comp: any): void {
  const currentlyExpanded = displayMode() === "oneLine" ? toolIsIndividuallyExpanded(comp) : comp?.expanded === true;
  setToolExpanded(comp, !currentlyExpanded);
  g.__tracelineTui?.requestRender?.();
}

function handleMouseInput(data: string): { consume?: boolean } | undefined {
  if (!shouldEnableClicks()) return undefined;
  const mouse = parseSgrMouse(data);
  if (!mouse) return undefined;

  if (isLeftMousePress(mouse)) {
    const comp = toolAtViewportRow(mouse.row);
    if (comp) toggleClickedTool(comp);
    if (g.__tracelineClickOneShot) setClickHandling(false);
  }

  // Always consume mouse escape sequences while reporting is enabled; otherwise raw
  // CSI bytes can leak into the editor when the click is outside a tool row.
  return { consume: true };
}

// --- one-line rendering ---------------------------------------------------------------

// Raw tool name exactly as pi reports it (read, edit, bash, mcp/tool names, etc.).
function toolLabel(name: unknown): string {
  return typeof name === "string" && name.length > 0 ? name : "tool";
}

type ToolStatus = "success" | "running" | "error";

type DiffStats = {
  added: number;
  removed: number;
};

function toolStatus(comp: any): ToolStatus {
  if (comp?.result?.isError) return "error";
  if (comp?.result && comp?.isPartial !== true) return "success";
  return "running";
}

function statusTone(comp: any): Tone {
  const status = toolStatus(comp);
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "running";
}

// Verb ink (design language §2/§12): identity is neutral bold — status lives in the ›
// bullet — so a healthy column of read/edit/$ verbs stays calm while assistant prose
// owns full brightness. Only a real anomaly (a failed call) tints its verb.
function verbTone(comp: any): Tone {
  return toolStatus(comp) === "error" ? "error" : "text";
}

function verbInk(comp: any, verb: string): string {
  return ink(currentTheme(), verbTone(comp), `${BOLD}${verb}${BOLD_OFF}`);
}

// Bold is the trace row's white (design language §12.11) and errors tint the
// discriminators (§12.14): basenames and bash head commands take exactly the verb's
// treatment — bold `text` on healthy rows, bold `error` on failed rows — so plain
// prose-weight white never appears inside a trace row and a failed call is more than
// one red glyph in a dim wall.
function discriminatorInk(comp: any, text: string): string {
  return verbInk(comp, text);
}

// Every trace row indents one gutter, then opens with the dim ▏ rail (design language
// §1/§5/§12): the block nests under the narrative line that motivated it, consecutive
// rows fuse into one visible block, and the blank spacer before a group ends the rail.
function toolPrefix(tone: Tone): string {
  return `${TOOL_INDENT}${dim(TOOL_RAIL)} ${ink(currentTheme(), tone, TOOL_BULLET)}${TOOL_AFTER_BULLET}`;
}

function hiddenToolPrefix(comp: any): string {
  return toolPrefix(statusTone(comp));
}

function formatCharCount(value: number): string {
  return compactCount(Math.max(0, Math.floor(value)));
}

// Severity thresholds (design language §6): dim while healthy, warning/error when an
// output balloons. Overridable via the family config convention
// (~/.pi/agent/pi-traceline.json / <cwd>/.pi/pi-traceline.json).
let sizeThresholds: SizeThresholds = SIZE_THRESHOLDS;

type TracelineConfig = {
  sizeWarningChars?: unknown;
  sizeErrorChars?: unknown;
  toolBackgrounds?: unknown;
};

function configureSizeThresholds(config: TracelineConfig | undefined): void {
  const warning =
    typeof config?.sizeWarningChars === "number" && config.sizeWarningChars > 0
      ? Math.floor(config.sizeWarningChars)
      : SIZE_THRESHOLDS.warning;
  const error =
    typeof config?.sizeErrorChars === "number" && config.sizeErrorChars > 0
      ? Math.floor(config.sizeErrorChars)
      : SIZE_THRESHOLDS.error;
  sizeThresholds = { warning, error: Math.max(error, warning) };
}

let paintToolBackgrounds = false;

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return undefined;
}

function configureToolBackgrounds(config: TracelineConfig | undefined): void {
  const configured = parseBooleanFlag(config?.toolBackgrounds);
  paintToolBackgrounds = configured ?? parseBooleanFlag(process.env.PI_TRACELINE_TOOL_BACKGROUNDS) ?? false;
}

function toolBackgroundsEnabled(): boolean {
  return paintToolBackgrounds;
}

// A fact suffix must carry a fact (design language §12.13): results smaller than one
// line of text render no char suffix — the bullet already says the call completed.
// The floor is block-scoped (§12.15): when the surrounding block's size column is
// live, even a below-floor cell renders — a blank inside a live column is a
// misalignment, not a calm.
const CHAR_SUFFIX_FLOOR = 100;

function charSuffix(chars: number | undefined, columnLive = false): string {
  if (chars === undefined) return "";
  if (chars < CHAR_SUFFIX_FLOOR && !columnLive) return "";
  return ink(currentTheme(), sizeTone(chars, sizeThresholds), `${formatCharCount(chars)} ch`);
}

function resultTextCharCount(comp: any): number | undefined {
  const content = comp?.result?.content;
  if (!Array.isArray(content)) return undefined;
  return content.reduce((sum: number, block: any) => {
    if (!block || typeof block !== "object") return sum;
    if (block.type === "text" && typeof block.text === "string") return sum + block.text.length;
    return sum;
  }, 0);
}

function resultCharSuffix(comp: any): string {
  return charSuffix(resultTextCharCount(comp), blockSizeColumnLive(comp));
}

// The row's contiguous visual block — the rail-fused run. Boundaries mirror the
// *rendered* rail: tool rows fuse across invisible empty connectors; visible prose
// breaks the block, and so does a collapsed thinking preview — it renders with a
// blank line above it, which breaks the rail and starts a new block. §12.15
// (block-scoped columns), §12.16 (boring-prefix path emphasis) and §12.17 (shared
// cut columns) all scope their facts to this run.
function blockToolRows(comp: any): any[] {
  const found = componentLocation(comp);
  if (!found) return [comp];
  const breaksBlock = (c: any) => !isToolRow(c) && !isEmptyConnector(c);
  let start = found.index;
  for (let j = found.index - 1; j >= 0; j--) {
    if (breaksBlock(found.sibs[j])) break;
    start = j;
  }
  const rows: any[] = [];
  for (let j = start; j < found.sibs.length; j++) {
    const c = found.sibs[j];
    if (breaksBlock(c)) break;
    if (isToolRow(c)) rows.push(c);
  }
  return rows.length ? rows : [comp];
}

// Columns are block-scoped (design language §12.15): the size column lights up for a
// whole contiguous trace block when any of its completed rows clears the fact floor.
// An all-tiny block (a `mkdir`/`rm` cleanup run) keeps a clean right edge.
function blockSizeColumnLive(comp: any): boolean {
  return blockToolRows(comp).some((c) => {
    const chars = resultTextCharCount(c);
    return chars !== undefined && chars >= CHAR_SUFFIX_FLOOR;
  });
}

// Rows in a block share one body budget (design language §12.17): reserve the block's
// widest rendered fact suffix — folded read runs count as their single `N calls · size`
// cell — plus the two-space gap (§12.21), so every truncated row in the block cuts at
// the same columns and its tail ends flush where the suffix column begins.
function blockSuffixReserve(comp: any, available = Number.POSITIVE_INFINITY): number {
  let widest = 0;
  for (const row of blockToolRows(comp)) {
    const run = readRun(row);
    const suffix = run ? foldedReadSuffix(run.rows) : toolFactSuffix(row, available);
    widest = Math.max(widest, visibleWidth(suffix));
  }
  return widest > 0 ? widest + 2 : 0;
}

const LCS_CELL_LIMIT = 200_000;

type WriteInput = {
  path: string;
  content: string;
  cwd: string;
};

type WriteSnapshot = WriteInput & {
  stats: DiffStats | undefined;
};

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = normalizeLineEndings(text).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function boundedLcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > LCS_CELL_LIMIT) return 0;

  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[b.length]!;
}

function diffStatsFromContents(oldContent: string, newContent: string): DiffStats | undefined {
  if (normalizeLineEndings(oldContent) === normalizeLineEndings(newContent)) return undefined;

  const oldLines = splitDiffLines(oldContent);
  const newLines = splitDiffLines(newContent);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const oldMiddle = oldLines.slice(start, oldEnd);
  const newMiddle = newLines.slice(start, newEnd);
  const unchangedMiddle = boundedLcsLength(oldMiddle, newMiddle);
  const stats = {
    added: Math.max(0, newMiddle.length - unchangedMiddle),
    removed: Math.max(0, oldMiddle.length - unchangedMiddle),
  };
  return stats.added > 0 || stats.removed > 0 ? stats : undefined;
}

function writeInput(comp: any): WriteInput | undefined {
  if (toolLabel(comp?.toolName) !== "write") return undefined;
  const path = comp?.args?.path ?? comp?.args?.file_path;
  const content = comp?.args?.content;
  if (typeof path !== "string" || typeof content !== "string") return undefined;
  const cwd = typeof comp?.cwd === "string" && comp.cwd.length > 0 ? comp.cwd : process.cwd();
  return { path, content, cwd };
}

function readWriteOldContent(input: WriteInput): string {
  try {
    return readFileSync(resolve(input.cwd, input.path), "utf8");
  } catch {
    return "";
  }
}

function writeSnapshot(comp: any): WriteSnapshot | undefined {
  const snapshot = comp?.__tracelineWriteSnapshot;
  if (!snapshot || typeof snapshot !== "object") return undefined;
  return snapshot as WriteSnapshot;
}

function sameWriteInput(a: WriteInput | undefined, b: WriteInput | undefined): boolean {
  return !!a && !!b && a.path === b.path && a.cwd === b.cwd && a.content === b.content;
}

function captureWriteSnapshot(comp: any): void {
  const input = writeInput(comp);
  if (!input) return;
  const previous = writeSnapshot(comp);
  if (sameWriteInput(previous, input)) return;
  const oldContent = readWriteOldContent(input);
  comp.__tracelineWriteSnapshot = { ...input, stats: diffStatsFromContents(oldContent, input.content) } satisfies WriteSnapshot;
}

function writeDiffStats(comp: any): DiffStats | undefined {
  const input = writeInput(comp);
  const snapshot = writeSnapshot(comp);
  if (!sameWriteInput(snapshot, input)) return undefined;
  return snapshot?.stats;
}

function diffTextFromComp(comp: any): string | undefined {
  const details = comp?.result?.details;
  if (typeof details?.diff === "string") return details.diff;
  if (typeof details?.patch === "string") return details.patch;

  // Pi's edit renderer computes a diff preview before the tool has settled. The preview
  // lives on the call renderer component, so collapsed rows can show `+N -M` while the
  // mutation is still pending, then switch to the result-backed diff once available.
  const preview = comp?.callRendererComponent?.preview;
  if (preview && typeof preview === "object" && !("error" in preview) && typeof preview.diff === "string") {
    return preview.diff;
  }
  return undefined;
}

function diffStatsFromText(diff: string | undefined): DiffStats | undefined {
  if (!diff) return undefined;
  let added = 0;
  let removed = 0;
  for (const rawLine of diff.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    if (line.startsWith("+++") || line.startsWith("---")) continue; // unified-patch file headers
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return added > 0 || removed > 0 ? { added, removed } : undefined;
}

function mutationDiffStats(comp: any): DiffStats | undefined {
  return diffStatsFromText(diffTextFromComp(comp)) ?? writeDiffStats(comp);
}

// Zero sides are dropped (design language §12.13): `+2 -0` → `+2` — the dimmed zero
// was a half-measure, and every new-file write wore a guaranteed-noise `-0`. But the
// drop is ink-only: within a block the diff cells form two right-aligned columns
// (§12.22/§12.27) — every cell pads left so units sit under units, and a dropped side
// holds its column as blank space — so each column's right edge and the `·` share one
// x down the block. Without column widths (a lone row), a cell pads to itself and
// renders exactly as before.
type DiffColumns = { plus: number; minus: number; size: number };

function blockDiffColumns(comp: any): DiffColumns {
  let plus = 0;
  let minus = 0;
  let size = 0;
  for (const row of blockToolRows(comp)) {
    const stats = mutationDiffStats(row);
    if (stats) {
      if (stats.added > 0) plus = Math.max(plus, 1 + String(stats.added).length);
      if (stats.removed > 0) minus = Math.max(minus, 1 + String(stats.removed).length);
    }
    size = Math.max(size, visibleWidth(resultCharSuffix(row)));
  }
  return { plus, minus, size };
}

function formatMutationDiffStats(
  stats: DiffStats,
  theme = currentTheme(),
  cols?: Pick<DiffColumns, "plus" | "minus">,
): string {
  const plusTok = stats.added > 0 ? `+${stats.added}` : "";
  const minusTok = stats.removed > 0 ? `-${stats.removed}` : "";
  const plusW = cols ? cols.plus : plusTok.length;
  const minusW = cols ? cols.minus : minusTok.length;
  const cells: string[] = [];
  if (plusW > 0) cells.push(" ".repeat(plusW - plusTok.length) + (plusTok ? ink(theme, "success", plusTok) : ""));
  if (minusW > 0) cells.push(" ".repeat(minusW - minusTok.length) + (minusTok ? ink(theme, "error", minusTok) : ""));
  return cells.join(" ");
}

// --- records of consequence (design language §12.19) -----------------------------------

// Some bash rows change shared state beyond the working tree — a commit, a push, a PR
// merged or closed, an issue closed, a release or package published. The invocation
// says only what was *attempted*, and truncation may eat even that; the proof is
// porcelain in the result, which one-line mode hides. These rows earn verb-first
// record facts in the suffix — `committed a4f21c9 · pushed main · 0.3k ch` — stated
// only from what the output reported: the command must name the operation *and* its
// success porcelain must appear. A failed push after a good commit therefore shows
// `committed a4f21c9` on a red row — committed, demonstrably not landed. `git tag`
// earns nothing: its success porcelain is silence.
type RecordFact = { verb: string; datum: string; at: number };

type RecordRule = { gate: RegExp; parse: (out: string) => RecordFact[] };

function factsFrom(out: string, pattern: RegExp, verb: string, datum: (m: RegExpMatchArray) => string): RecordFact[] {
  const facts: RecordFact[] = [];
  for (const m of out.matchAll(pattern)) facts.push({ verb, datum: datum(m), at: m.index ?? 0 });
  return facts;
}

function decodedTag(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Success porcelain only. Push failures (`! [rejected] main -> main`) have neither a
// hex range nor a `[new …]` head, so they never match; `Everything up-to-date`
// contributes nothing. Gates scan the raw command within one shell segment (`[^|;&]*`),
// so `git -c user.email=… commit` gates like `git commit`; a record phrase quoted
// inside a commit message can pass a gate, but then finds no porcelain in the output.
const RECORD_RULES: RecordRule[] = [
  {
    // `[main a4f21c9]`, `[main (root-commit) a4f21c9]`, `[detached HEAD a4f21c9]`
    gate: /\bgit\b[^|;&]*\bcommit\b/,
    parse: (out) => factsFrom(out, /^\[[^\n\]]*?([0-9a-f]{7,40})\]/gm, "committed", (m) => m[1]!),
  },
  {
    // `   1c75c2a..50cf33f  main -> main`, ` + … (forced update)`, ` * [new tag] …`
    gate: /\bgit\b[^|;&]*\bpush\b/,
    parse: (out) =>
      factsFrom(
        out,
        /^\s*(?:\+?\s?[0-9a-f]+\.\.\.?[0-9a-f]+|\* \[new (?:branch|tag)\])\s+\S+\s+->\s+(\S+)/gm,
        "pushed",
        (m) => m[1]!,
      ),
  },
  {
    gate: /\bgh\s+pr\s+merge\b/,
    parse: (out) =>
      factsFrom(out, /(?:Merged|Squashed and merged|Rebased and merged) pull request \S*?#(\d+)/g, "merged", (m) => `PR #${m[1]}`),
  },
  {
    gate: /\bgh\s+pr\s+close\b/,
    parse: (out) => factsFrom(out, /Closed pull request \S*?#(\d+)/g, "closed", (m) => `PR #${m[1]}`),
  },
  {
    gate: /\bgh\s+pr\s+create\b/,
    parse: (out) => factsFrom(out, /\/pull\/(\d+)\b/g, "opened", (m) => `PR #${m[1]}`),
  },
  {
    gate: /\bgh\s+issue\s+close\b/,
    parse: (out) => factsFrom(out, /Closed issue \S*?#(\d+)/g, "closed", (m) => `#${m[1]}`),
  },
  {
    gate: /\bgh\s+release\s+create\b/,
    parse: (out) => factsFrom(out, /\/releases\/tag\/([^\s/]+)/g, "released", (m) => decodedTag(m[1]!)),
  },
  {
    // npm's publish porcelain: `+ pine-of-glass@0.5.10`
    gate: /\bnpm\s+publish\b/,
    parse: (out) => factsFrom(out, /^\+ \S+@([^\s@]+)\s*$/gm, "published", (m) => m[1]!),
  },
];

function resultText(comp: any): string {
  const content = comp?.result?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += `${block.text}\n`;
  }
  return out;
}

// Facts depend only on the row's own command+result, so they cache against the result
// object identity (rows re-render every frame; porcelain never changes once settled).
const recordFactCache = new WeakMap<object, { result: unknown; facts: RecordFact[] }>();

function recordFacts(comp: any): RecordFact[] {
  if (toolLabel(comp?.toolName) !== "bash") return [];
  const command = comp?.args?.command;
  if (typeof command !== "string" || !comp?.result || typeof comp.result !== "object") return [];
  const cached = recordFactCache.get(comp);
  if (cached && cached.result === comp.result) return cached.facts;
  const out = stripAnsi(resultText(comp));
  const facts: RecordFact[] = [];
  if (out) {
    for (const rule of RECORD_RULES) {
      if (rule.gate.test(command)) facts.push(...rule.parse(out));
    }
    facts.sort((a, b) => a.at - b.at);
  }
  recordFactCache.set(comp, { result: comp.result, facts });
  return facts;
}

// Facts chain in output order; consecutive same-verb facts merge their data
// (`pushed main, v0.5.9`) and exact duplicates collapse.
function recordCells(comp: any): string[] {
  const merged: { verb: string; data: string[] }[] = [];
  for (const fact of recordFacts(comp)) {
    const last = merged[merged.length - 1];
    if (last && last.verb === fact.verb) {
      if (!last.data.includes(fact.datum)) last.data.push(fact.datum);
    } else {
      merged.push({ verb: fact.verb, data: [fact.datum] });
    }
  }
  return merged.map((cell) => `${cell.verb} ${cell.data.join(", ")}`);
}

// Records may take at most roughly a third of the row (§12.19): overflow drops whole
// facts oldest first — terminal state wins, a mangled sha is worse than none, and the
// full output stays one Ctrl+T away.
const RECORD_SUFFIX_SHARE = 1 / 3;

// The record verb is bold — the trace row's white (§12.11): `committed`/`pushed`/
// `merged` pop from the dim wall exactly like a bash head command, which is what makes
// the cell visible at the right edge; data and separators stay at the supporting grey.
// Neutral bold even on a failed row: the fact states porcelain that *succeeded* —
// status stays on the bullet and the invocation's discriminators.
function inkRecordCell(cell: string): string {
  const space = cell.indexOf(" ");
  const verb = space >= 0 ? cell.slice(0, space) : cell;
  const rest = space >= 0 ? cell.slice(space) : "";
  return `${ink(currentTheme(), "text", `${BOLD}${verb}${BOLD_OFF}`)}${rest ? dim(rest) : ""}`;
}

function recordSuffix(comp: any, available: number): string {
  const cells = recordCells(comp);
  if (!cells.length) return "";
  const cap = Math.floor(available * RECORD_SUFFIX_SHARE);
  while (cells.length && cells.join(SEP).length > cap) cells.shift();
  return cells.map(inkRecordCell).join(dim(SEP));
}

function toolFactSuffix(comp: any, available = Number.POSITIVE_INFINITY): string {
  const theme = currentTheme();
  const parts: string[] = [];
  const records = recordSuffix(comp, available);
  if (records) parts.push(records);
  const diff = mutationDiffStats(comp);
  const chars = resultCharSuffix(comp);
  if (diff) {
    // The diff cell right-aligns within the block's sign columns, and the size cell
    // pads left to the block's widest, so each diff column's right edge and the `·`
    // hold one x down the block (§12.22/§12.27).
    const cols = blockDiffColumns(comp);
    parts.push(formatMutationDiffStats(diff, theme, cols));
    if (chars) parts.push(" ".repeat(Math.max(0, cols.size - visibleWidth(chars))) + chars);
  } else if (chars) {
    parts.push(chars);
  }
  return parts.join(dim(SEP));
}

// tildify / middleTruncate / rightAlignSuffix live in _lib/style.ts — traceline's rules,
// promoted to family rules (design language §5).

function displayPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lineRange(args: any): string {
  const offset = Number.isFinite(args?.offset) ? Math.max(1, Math.floor(args.offset)) : undefined;
  const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
  if (offset !== undefined && limit !== undefined) return `:${offset}-${offset + limit - 1}`;
  if (offset !== undefined) return `:${offset}`;
  if (limit !== undefined) return `:1-${limit}`;
  return "";
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value ?? "");
  }
}

function firstVisibleLine(lines: string[]): string | undefined {
  return lines.find((line) => stripAnsi(line).trim().length > 0);
}

// Bash commands keep their real newlines (heredocs, inline python, chained pipelines),
// so first-line-only collapses them to an uninformative prefix like `$ python3 -c "`
// (issue #10). Flatten every visible line into the one trace line, with a ↵ where each
// break was — middle truncation then keeps the head *and* the operative tail. The marks
// stay plain here; inkBashBody dims them with the rest of the shell apparatus.
function flattenInvocationLines(lines: string[]): string | undefined {
  const visible = lines
    .filter((line) => stripAnsi(line).trim().length > 0)
    .map((line) => trimLeadingVisibleWhitespace(line.trimEnd()));
  if (visible.length === 0) return undefined;
  return visible.join(` ${LINE_BREAK_MARK} `);
}

function filterSgrParams(
  text: string,
  shouldDrop: (n: number, params: string[], index: number) => number | undefined,
): string {
  return text.replace(/\x1b\[([0-9;]*)m/g, (_seq, rawParams: string) => {
    const params = rawParams === "" ? ["0"] : rawParams.split(";");
    const kept: string[] = [];
    for (let i = 0; i < params.length; i++) {
      const n = Number(params[i]);
      const skipTo = shouldDrop(n, params, i);
      if (skipTo !== undefined) {
        i = skipTo;
        continue;
      }
      kept.push(params[i]);
    }
    return kept.length ? `\x1b[${kept.join(";")}m` : "";
  });
}

function stripSgrBackgrounds(text: string): string {
  return filterSgrParams(text, (n, params, i) => {
    if (n === 48) {
      const mode = Number(params[i + 1]);
      if (mode === 2) return i + 4; // 48;2;r;g;b
      if (mode === 5) return i + 2; // 48;5;n
      return i;
    }
    if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) return i;
    return undefined;
  });
}

function stripSgrForegrounds(text: string): string {
  return filterSgrParams(text, (n, params, i) => {
    if (n === 38) {
      const mode = Number(params[i + 1]);
      if (mode === 2) return i + 4; // 38;2;r;g;b
      if (mode === 5) return i + 2; // 38;5;n
      return i;
    }
    if (n === 39 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97)) return i;
    return undefined;
  });
}

// ansiEndIndex / rawIndexAtVisibleIndex / rawIndexBeforeVisibleIndex live in _lib/ansi.ts.

// No plain ink in native rows (design language §12.12): every span a native renderer
// leaves unstyled would render at the terminal default — prose ink inside a trace row,
// the §12.11 problem alive on grep/web_search/fetch/mcp rows. Demote such spans to
// L3-dim; spans with a deliberate foreground, and bold/faint-only spans (§12.11's
// white), pass through untouched. OSC sequences (hyperlinks, zone marks) are copied
// verbatim and never counted as text.
const SGR_OR_OSC = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function dimUnstyledSpans(line: string): string {
  let out = "";
  let last = 0;
  let fg = false;
  let weight = false;
  const emit = (text: string) => {
    if (!text) return;
    out += fg || weight || !/\S/.test(text) ? text : dim(text);
  };
  SGR_OR_OSC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_OR_OSC.exec(line))) {
    emit(line.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
    const rawParams = match[1];
    if (rawParams === undefined) continue; // OSC: no SGR state change
    const params = rawParams === "" ? ["0"] : rawParams.split(";");
    for (let i = 0; i < params.length; i++) {
      const n = Number(params[i]);
      if (n === 0) {
        fg = false;
        weight = false;
      } else if (n === 1 || n === 2) weight = true;
      else if (n === 22) weight = false;
      else if (n === 39) fg = false;
      else if (n === 38) {
        fg = true;
        i += Number(params[i + 1]) === 2 ? 4 : 2; // 38;2;r;g;b / 38;5;n
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) fg = true;
    }
  }
  emit(line.slice(last));
  return out;
}

function trimLeadingVisibleWhitespace(line: string): string {
  const visible = stripAnsi(line);
  const leading = visible.match(/^\s*/)?.[0].length ?? 0;
  if (leading === 0) return line;
  return line.slice(rawIndexAtVisibleIndex(line, leading));
}

function stripTrailingExpandHint(line: string): string {
  // Native compact read/resource calls include a key hint. One-line mode is deliberately
  // invocation-only, so keep pi's styling but drop that non-invocation suffix.
  const visible = stripAnsi(line);
  const hint = visible.match(/ \([^)]*to expand\)\s*$/i)?.[0];
  if (!hint) return line;
  const rawStart = rawIndexAtVisibleIndex(line, visible.length - hint.length);
  return `${line.slice(0, rawStart)}${RESET}`;
}

// Native bash rows append " (timeout Ns)". It is near-constant boilerplate — the same
// dim parenthetical on every row — so in one-line mode it only spends width and adds
// noise; the full invocation (timeout included) is one Ctrl+T / click away. Bash rows
// are rebuilt from plain text (see bashInvocationText), so this works on plain text.
function stripTimeoutSuffix(text: string): string {
  return text.replace(/ \(timeout [^)]*\)\s*$/i, "");
}

// --- bash rows: plain-text rebuild + family ink (§2/§12.9/§12.20/§12.25/§12.26) ------
// Bash rows speak the exact grammar of path rows: the bold `$` anchors at L0, and the
// head words that survive crown selection (below) render L0-bold the way a basename
// does (`$ rm`, `$ npm`, `$ python3` scan like `read file.ts`; §12.11), while
// everything else — arguments, connectors, redirects, heredoc markers, demoted glue
// commands, and the ↵/⋯ flatten/elision marks — sits at the one L3-dim supporting
// grey shared with directories, plumbing, and size suffixes. Pi's native bash styling
// is deliberately dropped: the invocation *text* still comes from pi's renderer, the
// ink is the family's.

// The rendered bash invocation as plain text: every visible line flattened into one,
// leading bullet and timeout boilerplate dropped. All later transforms (tildify, cd
// elision) stay in plain text; inkBashRow applies the family ink last.
function bashInvocationText(comp: any): string | undefined {
  const call = comp?.callRendererComponent;
  if (!call || typeof call.render !== "function") return undefined;
  const rendered = withLayoutSuppressed(() => call.render(ONE_LINE_CAPTURE_WIDTH));
  const lines = Array.isArray(rendered) ? rendered : [];
  const flattened = flattenInvocationLines(lines.map((line: unknown) => stripAnsi(String(line))));
  if (!flattened) return undefined;
  return stripTimeoutSuffix(flattened.replace(/^•\s*/, ""));
}

// Env-var assignments (`FOO=1 npm test`) are not the command; the head scans past them.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Sequencing operators start a new command whose head word is a discriminator
// (§12.20). Pipes and redirects continue a command — `| head -240` is a filter, and
// §12.2's rejection of brightening filters stands — so `|` consumes a pending head
// slot instead of re-arming it. The attached form of the semicolon (`sleep 60; ps`)
// sequences too (§12.25); it is detected on the token, quote-aware, in the walk below.
const BASH_SEQUENCER = /^(?:&&|\|\||;)$/;

// A heredoc marker arms body-inertness (§12.20): from the `↵` that follows `<<TAG`
// until the terminator line, tokens are data — no heads, no re-arms, and no quote
// tracking, so an unbalanced apostrophe in heredoc prose cannot silence the commands
// after the terminator (§12.25). A bare `<<`/`<<-` takes the next token as its tag;
// `<<<` is a here-string, not a heredoc, and matches neither form.
const BASH_HEREDOC_TOKEN = /^<<-?(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))?$/;

// The crown vocabularies (§12.26, measured over a 51k-invocation corpus — see
// scripts/dev/bash-corpus/). Preambles situate (`cd X && …`, `set -e; …`); plumbing
// glues (`|| true`, `&& echo done`); neither is why the row exists, so neither wears
// a crown when a real command in the row does. Closers are the block keywords a
// sequencer exposes (`; do`, `↵ fi`); they pass the crown to the head that follows.
const BASH_PREAMBLE_HEADS = new Set(["cd", "set"]);
const BASH_PLUMBING_HEADS = new Set(["echo", "true", "false", "printf", "exit"]);
const BASH_CLOSERS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "in"]);

type BashHeadClass = "real" | "plumbing" | "preamble";
type BashHead = { start: number; end: number; cls: BashHeadClass };

// One walk over the flattened body collects every command's head candidate (§12.20's
// grammar, amended §12.25): tokens scan left to right with quote state carried across
// them (the gaps are whitespace and hold none), sequencers re-arm the pending head
// slot only outside quotes, a token-final unquoted `;` re-arms exactly like the
// space-delimited form, and heredoc bodies are skipped whole. Within an armed slot:
// env assignments are scanned past (§12.20), block closers pass the crown through,
// and a token with no word character (§12.23) or a leading `-` (a flattened
// continuation line's flag, §12.25) renders headless and consumes the slot so a
// pipe filter cannot inherit it.
function bashHeadCandidates(body: string): BashHead[] {
  const heads: BashHead[] = [];
  let quote: "'" | '"' | undefined;
  let headPending = true;
  let heredocTag: string | undefined; // armed by `<<TAG`; active from the next ↵
  let heredocTagFromNext = false; // armed by a bare `<<`; the next token names the tag
  let heredocActive = false;
  let atLineStart = false; // inside a heredoc: was the previous token a ↵?
  const tokens = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(body))) {
    const text = match[0];
    if (heredocActive) {
      if (text === LINE_BREAK_MARK) {
        atLineStart = true;
        continue;
      }
      if (atLineStart && text === heredocTag) {
        heredocActive = false;
        heredocTag = undefined;
      }
      atLineStart = false;
      continue;
    }
    const startsInQuote = quote !== undefined;
    // Advance the quote scanner across this token. A backslash escapes the next
    // character except inside single quotes; a `;` counts as a sequencer only when
    // it is the token's last character and sits outside any quote (`\;` is find's).
    let endsWithUnquotedSemi = false;
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (quote === "'") {
        if (ch === "'") quote = undefined;
      } else if (quote === '"') {
        if (ch === "\\") k++;
        else if (ch === '"') quote = undefined;
      } else if (ch === "'") quote = "'";
      else if (ch === '"') quote = '"';
      else if (ch === "\\") k++;
      else if (ch === ";" && k === text.length - 1) endsWithUnquotedSemi = true;
    }
    if (!startsInQuote) {
      if (text === LINE_BREAK_MARK) {
        if (heredocTag !== undefined) {
          heredocActive = true;
          headPending = false;
        } else headPending = true;
        atLineStart = true;
        continue;
      }
      if (BASH_SEQUENCER.test(text)) {
        headPending = true;
        continue;
      }
      if (text === "|") {
        headPending = false;
        continue;
      }
      if (text === PREAMBLE_MARK) continue; // the ⋯ elision mark neither crowns nor consumes
      if (heredocTagFromNext) {
        heredocTagFromNext = false;
        heredocTag = text.replace(/^['"]|['"]$/g, "");
        continue;
      }
      const heredoc = BASH_HEREDOC_TOKEN.exec(text);
      if (heredoc) {
        const tag = heredoc[1] ?? heredoc[2] ?? heredoc[3];
        if (tag !== undefined) heredocTag = tag;
        else heredocTagFromNext = true;
        continue;
      }
      if (headPending && !ENV_ASSIGNMENT.test(text)) {
        // Parens are apparatus (§12.23's spirit): `(cd …` and `… || true)` classify
        // and crown on the inner word, so a subshell close cannot smuggle glue past
        // the §12.26 vocabularies and a crown never bolds punctuation.
        const trimmed = endsWithUnquotedSemi ? text.slice(0, -1) : text;
        const open = /^\(+/.exec(trimmed)?.[0].length ?? 0;
        const close = /\)+$/.exec(trimmed)?.[0].length ?? 0;
        const word = trimmed.slice(open, trimmed.length - close);
        const wordStart = match.index + open;
        if (!/[A-Za-z0-9]/.test(word) || word.startsWith("-")) {
          headPending = false; // §12.23/§12.25: apparatus and flags consume the slot
        } else if (!BASH_CLOSERS.has(word)) {
          const cls: BashHeadClass = BASH_PREAMBLE_HEADS.has(word)
            ? "preamble"
            : BASH_PLUMBING_HEADS.has(word)
              ? "plumbing"
              : "real";
          heads.push({ start: wordStart, end: wordStart + word.length, cls });
          headPending = false;
        }
        // a closer falls through with the slot still armed: `; do gh …` crowns gh
      }
    }
    atLineStart = false;
    if (endsWithUnquotedSemi) headPending = true;
  }
  return heads;
}

// Crown selection is row-global (§12.26): every real command head is crowned, and
// preamble (`cd`, `set`) and plumbing (`echo`, `true`, …) heads render headless
// beside them. A row with no real head keeps its first operative head — plumbing
// before preamble — so no row goes dark: `$ cd /tmp` and `$ echo hi > f` still
// carry one crown each.
function bashCrownedHeads(body: string): BashHead[] {
  const heads = bashHeadCandidates(body);
  const real = heads.filter((head) => head.cls === "real");
  if (real.length > 0) return real;
  const fallback = heads.find((head) => head.cls === "plumbing") ?? heads[0];
  return fallback ? [fallback] : [];
}

// Emission splices the crowns into dim runs: everything between crowned head words —
// arguments, operators, marks, quoted scripts, demoted glue — dims in maximal spans
// (middleTruncate replays the active ink after a cut, §12.10, so a long dim run
// survives truncation), and each crowned word takes the discriminator ink (§12.11;
// §12.14's error tint on failed rows). The visible text is untouched.
function inkBashBody(body: string, comp?: any): string {
  let out = "";
  let cursor = 0;
  for (const crown of bashCrownedHeads(body)) {
    if (crown.start > cursor) out += dim(body.slice(cursor, crown.start));
    out += discriminatorInk(comp, body.slice(crown.start, crown.end));
    cursor = crown.end;
  }
  if (cursor < body.length) out += dim(body.slice(cursor));
  return out;
}

function inkBashRow(comp: any, text: string): string {
  if (!text.startsWith("$ ")) return dim(text);
  return `${verbInk(comp, "$")} ${inkBashBody(text.slice(2), comp)}`;
}

function commandPrefixLength(comp: any, line: string): number {
  const visible = stripAnsi(line).trimStart();
  const name = toolLabel(comp?.toolName);
  if (visible.startsWith(name)) return name.length;
  return visible.match(/^\S+/)?.[0].length ?? 0;
}

function stripLeadingVisibleBullet(line: string): string {
  const trimmed = trimLeadingVisibleWhitespace(line);
  const visible = stripAnsi(trimmed);
  const bullet = visible.match(/^•\s*/)?.[0];
  if (!bullet) return trimmed;
  return trimmed.slice(rawIndexAtVisibleIndex(trimmed, bullet.length));
}

function colourCommandPrefix(comp: any, line: string): string {
  const trimmed = stripLeadingVisibleBullet(line);
  const prefixLen = commandPrefixLength(comp, trimmed);
  if (prefixLen <= 0) return trimmed;
  const rawEnd = rawIndexBeforeVisibleIndex(trimmed, prefixLen);
  const prefix = stripSgrForegrounds(trimmed.slice(0, rawEnd));
  const rest = trimmed.slice(rawEnd);
  return `${ink(currentTheme(), verbTone(comp), `${BOLD}${prefix}${BOLD_OFF}`)}${rest}`;
}

// Prefer pi's own renderCall output for one-line mode (non-bash tools). This borrows
// the native visual grammar (paths/backticks, warning line ranges, custom-tool
// renderers) and only suppresses result/output lines by taking the first visible call
// line. The verb is re-inked neutral bold (error rows error) per the family hierarchy.
function nativeInvocationLine(comp: any): string | undefined {
  const call = comp?.callRendererComponent;
  if (!call || typeof call.render !== "function") return undefined;
  const rendered = withLayoutSuppressed(() => call.render(ONE_LINE_CAPTURE_WIDTH));
  const lines = Array.isArray(rendered) ? rendered : [];
  const line = firstVisibleLine(lines);
  // Demote *after* the verb re-ink: colourCommandPrefix strips foregrounds from the
  // prefix region, so a dim span opened before the verb would lose its opener and
  // strand the rest of the line back at the terminal default.
  return line
    ? dimUnstyledSpans(colourCommandPrefix(comp, stripSgrBackgrounds(stripTrailingExpandHint(line))))
    : undefined;
}

// Rare fallback for tools without a renderCall component. Keep it intentionally plain;
// built-in and well-behaved custom tools should use nativeInvocationLine().
function fallbackInvocationLine(comp: any): string {
  const verb = toolLabel(comp?.toolName);
  const args = comp?.args ?? {};
  const path = displayPath(args.path);
  const body =
    verb === "read"
      ? `${verb} ${path ?? ""}${lineRange(args)}`
      : path
        ? `${verb} ${path}`
        : `${verb} ${compactJson(args)}`;
  return body.replace(/\s+/g, " ").trim() || verb;
}

function inkedFallbackLine(comp: any): string {
  const body = tildify(fallbackInvocationLine(comp));
  const verb = toolLabel(comp?.toolName);
  if (body === verb) return verbInk(comp, verb);
  if (body.startsWith(`${verb} `)) {
    // Argument text at the one supporting grey (§12.9), matching bash argument ink.
    return `${verbInk(comp, verb)} ${dim(body.slice(verb.length + 1))}`;
  }
  return dim(body);
}

// Emphasis for plain file reads, edits, and writes (design language §12): dim the
// directory so the basename (which file) stands out, and keep the read :line-range in
// pi's warning/yellow treatment so scoped reads pop. Applied only when the native row
// is a bare `<verb> <path>[:range]`; rows with extra native decoration (resource /
// [skill] labels, inline diff hints) keep pi's own rendering.
const PATH_VERBS = new Set(["read", "edit", "write"]);

function toolPathArg(c: any): string | undefined {
  if (!PATH_VERBS.has(toolLabel(c?.toolName))) return undefined;
  const path = c?.args?.path ?? c?.args?.file_path;
  return typeof path === "string" && path.length > 0 ? cwdRelativePath(c, path) : undefined;
}

// cwd collapses to `./` (design language §12.18): a path under the row's cwd renders
// as the shell's own notation for "here" — two columns instead of thirty. Paths
// outside cwd keep their tildified absolute form; the asymmetry is the information.
function cwdRelativePath(comp: any, rawPath: string): string {
  const tilde = tildify(rawPath);
  const cwd = typeof comp?.cwd === "string" && comp.cwd.length > 0 ? comp.cwd : undefined;
  if (!cwd) return tilde;
  const cwdPrefix = `${tildify(cwd).replace(/\/+$/, "")}/`;
  return tilde.startsWith(cwdPrefix) ? `./${tilde.slice(cwdPrefix.length)}` : tilde;
}

// Shared leading directory segments across a set of tildified paths ("~" is a
// segment; the absolute-root "" is not). For a single path this is its whole
// directory — which is what keeps lone rows at basename-only emphasis.
function commonDirSegments(paths: string[]): string[] {
  const split = paths.map((p) => p.slice(0, p.lastIndexOf("/") + 1).split("/").slice(0, -1));
  let common = split[0] ?? [];
  for (const segs of split.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  return common;
}

// Dim the boring prefix, not the directory (design language §12.16): the dim zone is
// the longest of the block's common directory prefix (when at least two meaningful
// segments deep — a shared bare `/` or `~/` carries no information) and the row's
// cwd prefix (session-ambient context is boring by default). Everything past it —
// divergent directories included — is the discriminator. Falls back to the whole
// directory, i.e. the classic basename-only emphasis.
function boringPrefix(comp: any, tildePath: string): string {
  const dir = tildePath.slice(0, tildePath.lastIndexOf("/") + 1);
  const candidates: string[] = [];
  const blockPaths = blockToolRows(comp)
    .map(toolPathArg)
    .filter((p): p is string => p !== undefined);
  const common = commonDirSegments(blockPaths.length ? blockPaths : [tildePath]);
  // `./` counts like `~` (§12.18): alone it is a trivial root marker, but `./src/`
  // is a meaningful shared prefix. Either way it is always boring on its own.
  if (common.filter((s) => s !== "").length >= 2) {
    const prefix = `${common.join("/")}/`;
    if (tildePath.startsWith(prefix)) candidates.push(prefix);
  }
  if (tildePath.startsWith("./")) candidates.push("./");
  const boring = candidates.sort((a, b) => b.length - a.length)[0];
  return boring !== undefined && boring.length <= dir.length ? boring : dir;
}

function pathEmphasisLine(comp: any, nativeColored: string): string | undefined {
  const verb = toolLabel(comp?.toolName);
  if (!PATH_VERBS.has(verb)) return undefined;
  const path = comp?.args?.path ?? comp?.args?.file_path;
  if (typeof path !== "string" || path.length === 0) return undefined;
  const tildePath = tildify(path);
  const lastSlash = tildePath.lastIndexOf("/");
  if (lastSlash < 0) return undefined;
  const visible = stripAnsi(nativeColored).trim();
  const matches =
    verb === "read"
      ? visible.startsWith(`${verb} ${tildePath}`) || visible.startsWith(`${verb} ${path}`)
      : visible === `${verb} ${tildePath}` || visible === `${verb} ${path}`;
  if (!matches) return undefined;
  const theme = currentTheme();
  const shown = cwdRelativePath(comp, path);
  const boring = boringPrefix(comp, shown);
  const tail = shown.slice(boring.length);
  const range = verb === "read" ? lineRange(comp?.args) : "";
  return `${verbInk(comp, verb)} ${dim(boring)}${discriminatorInk(comp, tail)}${ink(theme, "warning", range)}`;
}

// Optional shaded tool surface, borrowed live from the row itself. This used to be the
// default, but the unbanded edit-tool look is calmer and avoids inconsistent highlighting
// for self-framing tools. Keep the path behind `toolBackgrounds` / `PI_TRACELINE_TOOL_BACKGROUNDS`
// so it is one config flip away if we want the old full-width native bands back.
function rowBackground(comp: any): ((text: string) => string) | undefined {
  if (!toolBackgroundsEnabled()) return undefined;
  try {
    if (typeof comp?.getRenderShell === "function" && comp.getRenderShell() === "self") return undefined;
    const bgFn = comp?.contentBox?.bgFn;
    return typeof bgFn === "function" ? bgFn : undefined;
  } catch {
    return undefined;
  }
}

// Full-width band for the opt-in native tool surface: pad to width, then re-assert the
// background after every full SGR reset (traceline's own ink uses \x1b[0m liberally) so
// the surface never punches holes.
function shadeRow(line: string, width: number, bgFn: (text: string) => string): string {
  const [open = "", close = ""] = bgFn("\u0000").split("\u0000");
  if (!open) return line;
  const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
  return `${open}${padded.split(RESET).join(`${RESET}${open}`)}${close}`;
}

// The invocation body with family ink applied: bash rows rebuild from plain text, path
// rows get the dim-directory emphasis, everything else keeps pi's native line with a
// re-inked verb; tools without a renderer fall back to a plain verb+args line.
function invocationInk(comp: any): string {
  if (toolLabel(comp?.toolName) === "bash") {
    const plain = bashInvocationText(comp);
    if (plain === undefined) return inkedFallbackLine(comp);
    const tilded = tildify(plain);
    return inkBashRow(comp, repeatsPreviousCdPreamble(comp) ? elideCdPreamble(tilded) : tilded);
  }
  const native = nativeInvocationLine(comp);
  const base = (native && pathEmphasisLine(comp, native)) ?? native;
  return base ? tildify(base) : inkedFallbackLine(comp);
}

function oneLine(comp: any, width: number): string {
  if (toolLabel(comp?.toolName) === "write" && !comp?.result) {
    try {
      captureWriteSnapshot(comp);
    } catch {
      /* keep one-line rendering best-effort */
    }
  }
  const lineWidth = Math.max(1, width);
  const available = Math.max(1, lineWidth - TOOL_PREFIX_VISIBLE_WIDTH - TOOL_RIGHT_MARGIN);
  const fitted = rightAlignSuffix(
    invocationInk(comp),
    toolFactSuffix(comp, available),
    available,
    currentTheme(),
    blockSuffixReserve(comp, available),
  );
  const row = truncateToWidth(`${hiddenToolPrefix(comp)}${fitted}`, lineWidth, ELLIPSIS);
  const bgFn = rowBackground(comp);
  return bgFn ? shadeRow(row, Math.max(1, lineWidth - TOOL_RIGHT_MARGIN), bgFn) : row;
}

// --- repetition folding (issue #14, design language §9/traceline 3+5) -------------------

// pi's bash tool is stateless per call, so agents working outside the session cwd re-`cd`
// on every call — measured at 90% of bash rows in a live session. When a row's
// `cd <dir> && ` preamble repeats the previous bash row's, the repeated head carries no
// information and its ~half-row width starves middle truncation of the part that
// *differs*; render it as a dim `⋯` instead.
const CD_PREAMBLE = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s/;

function cdPreambleDir(comp: any): string | undefined {
  if (toolLabel(comp?.toolName) !== "bash") return undefined;
  const command = comp?.args?.command;
  if (typeof command !== "string") return undefined;
  return CD_PREAMBLE.exec(command)?.[1];
}

// The previous bash row within the same visual group: reads and other tools interleave
// freely, but visible prose opens a new paragraph — a `⋯` must never point across one.
function previousBashRow(comp: any): any | undefined {
  const found = componentLocation(comp);
  if (!found) return undefined;
  for (let j = found.index - 1; j >= 0; j--) {
    const prev = found.sibs[j];
    if (isToolRow(prev)) {
      if (toolLabel(prev?.toolName) === "bash") return prev;
      continue;
    }
    if (isEmptyConnector(prev) || isCollapsedThinkingRow(prev)) continue;
    return undefined;
  }
  return undefined;
}

function repeatsPreviousCdPreamble(comp: any): boolean {
  const dir = cdPreambleDir(comp);
  if (dir === undefined) return false;
  return cdPreambleDir(previousBashRow(comp)) === dir;
}

// Operates on the plain-text invocation (see bashInvocationText); inkBashBody later
// dims the ⋯ with the rest of the shell apparatus.
function elideCdPreamble(line: string): string {
  if (!line.startsWith("$ ")) return line;
  // Find the separator with the same quote-aware parse used to detect the repeat: a
  // plain indexOf(" && ") would cut inside a quoted directory (`cd "/tmp/a && b" && …`)
  // and corrupt the command. The match tail is `\s*&&\s`, so its last `&&` *is* the
  // separator, after any quoted segment.
  const preamble = CD_PREAMBLE.exec(line.slice(2));
  if (!preamble) return line;
  const ampIndex = 2 + preamble[0].lastIndexOf("&&");
  return `$ ${PREAMBLE_MARK} ${line.slice(ampIndex)}`;
}

// Consecutive reads paging through one file (read → truncation notice → read with offset)
// differ only in the range; fold the run into one row —
// `read path:1-200,201-400 · 2 calls` with the combined result size — carried by the
// run's first row while the later rows render nothing. Runs are broken by anything
// visible between the reads (prose, a collapsed Thinking… line, another tool), so the
// fold never reorders what the transcript shows; clicking the folded row open restores
// the individual rows.
function readPath(comp: any): string | undefined {
  if (toolLabel(comp?.toolName) !== "read") return undefined;
  const path = comp?.args?.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

// A read row that may participate in a fold: error rows never fold — a failed page must
// keep its own red row, not vanish into a folded one whose tone reflects only the last
// call. An error therefore also breaks the run on both sides.
function foldableReadPath(comp: any): string | undefined {
  const path = readPath(comp);
  if (path === undefined) return undefined;
  return toolStatus(comp) === "error" ? undefined : path;
}

function readRun(comp: any): { rows: any[]; index: number } | undefined {
  const path = foldableReadPath(comp);
  if (path === undefined) return undefined;
  const found = componentLocation(comp);
  if (!found) return undefined;
  const { sibs, index } = found;
  const rows: any[] = [comp];
  let selfIndex = 0;
  for (let j = index - 1; j >= 0; j--) {
    const prev = sibs[j];
    if (isEmptyConnector(prev)) continue;
    if (foldableReadPath(prev) !== path) break;
    rows.unshift(prev);
    selfIndex++;
  }
  for (let j = index + 1; j < sibs.length; j++) {
    const next = sibs[j];
    if (isEmptyConnector(next)) continue;
    if (foldableReadPath(next) !== path) break;
    rows.push(next);
  }
  return rows.length > 1 ? { rows, index: selfIndex } : undefined;
}

function foldedReadSuffix(rows: any[]): string {
  const last = rows[rows.length - 1];
  let total: number | undefined;
  for (const row of rows) {
    const chars = resultTextCharCount(row);
    if (chars !== undefined) total = (total ?? 0) + chars;
  }
  const calls = `${rows.length} calls`;
  const sizeCell = charSuffix(total, blockSizeColumnLive(last));
  return total === undefined || !sizeCell ? dim(calls) : `${dim(`${calls}${SEP}`)}${sizeCell}`;
}

function foldedReadLine(rows: any[], width: number): string {
  const lineWidth = Math.max(1, width);
  const available = Math.max(1, lineWidth - TOOL_PREFIX_VISIBLE_WIDTH - TOOL_RIGHT_MARGIN);
  const theme = currentTheme();
  const last = rows[rows.length - 1];
  const tone = statusTone(last);
  const path = cwdRelativePath(last, String(rows[0]?.args?.path ?? ""));
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? boringPrefix(last, path) : "";
  const base = path.slice(dir.length);
  const ranges = rows
    .map((row) => lineRange(row?.args).slice(1))
    .filter(Boolean)
    .join(",");
  const body = `${verbInk(last, "read")} ${dim(dir)}${discriminatorInk(last, base)}${ink(theme, "warning", ranges ? `:${ranges}` : "")}`;
  // Call count rides the right-aligned suffix (fact order: what · how many · how big),
  // so middle truncation protects the discriminating basename+ranges tail of the body.
  const suffix = foldedReadSuffix(rows);
  const fitted = rightAlignSuffix(body, suffix, available, theme, blockSuffixReserve(last, available));
  const row = truncateToWidth(`${toolPrefix(tone)}${fitted}`, lineWidth, ELLIPSIS);
  const bgFn = rowBackground(last);
  return bgFn ? shadeRow(row, Math.max(1, lineWidth - TOOL_RIGHT_MARGIN), bgFn) : row;
}

// An assistant turn that renders nothing (a tool-call-only turn with no visible
// text/thinking) — these sit *between* sequential tool rows and must be skipped so a
// run of tool calls groups tightly.
function isEmptyConnector(c: any): boolean {
  if (!isAssistantRow(c)) return false;
  const content = c.lastMessage?.content;
  if (!Array.isArray(content)) return true;
  return !content.some(
    (b: any) =>
      (b?.type === "text" && b.text?.trim()) || (b?.type === "thinking" && b.thinking?.trim()),
  );
}

function componentLocation(comp: any): { sibs: any[]; index: number } | undefined {
  let sibs = chatChildren();
  let index = Array.isArray(sibs) ? sibs.indexOf(comp) : -1;
  if (index === -1) {
    g.__tracelineChat = undefined; // stale container ref — re-find once
    sibs = chatChildren();
    index = Array.isArray(sibs) ? sibs!.indexOf(comp) : -1;
  }
  return Array.isArray(sibs) && index >= 0 ? { sibs, index } : undefined;
}

// A reasoning-only turn while thinking is hidden: pi collapses it to a single dim
// thinking-label line. The tool row that follows is that thought's action, so the two
// should read as one thought→action couplet rather than separate paragraphs.
function isCollapsedThinkingRow(c: any): boolean {
  if (!isAssistantRow(c) || c.hideThinkingBlock !== true) return false;
  const content = c.lastMessage?.content;
  if (!Array.isArray(content)) return false;
  let hasThinking = false;
  for (const b of content) {
    if (b?.type === "text" && b.text?.trim()) return false; // visible prose → real paragraph
    if (b?.type === "thinking" && b.thinking?.trim()) hasThinking = true;
  }
  return hasThinking;
}

// One blank line before a tool *group*, none within it: walk back past invisible
// connector turns; tight if the nearest visible sibling is another collapsed tool row
// or the collapsed thinking-label line that motivated this call.
function leadingBlank(comp: any): boolean {
  const found = componentLocation(comp);
  if (!found || found.index <= 0) return true;
  const { sibs, index } = found;
  for (let j = index - 1; j >= 0; j--) {
    const prev = sibs[j];
    if (isToolRow(prev)) return false; // adjacent (through connectors) to another tool
    if (isEmptyConnector(prev)) continue; // skip invisible tool-call-only turns
    if (isCollapsedThinkingRow(prev)) return false; // tight under its Thinking... line
    return true; // hit visible content → blank before the group
  }
  return true;
}

// One row's worth of one-line output: folded-run handling plus the group-spacing rule.
// Shared by the prototype patch and the test suites.
function renderTraceRow(comp: any, width: number): string[] {
  const run = readRun(comp);
  if (run && !run.rows.some((row) => toolIsIndividuallyExpanded(row))) {
    if (run.index > 0) return []; // a later page: the run's first row carries the fold
    const line = foldedReadLine(run.rows, width);
    return leadingBlank(comp) ? ["", line] : [line];
  }
  const line = oneLine(comp, width);
  return leadingBlank(comp) ? ["", line] : [line];
}

// --- collapsed thinking previews (issue #14, pi-native rendering) ----------------------

// pi renders the collapsed thinking label once per thinking *block*, not per message. In
// native hidden-reasoning mode those labels are identical `Thinking...` rows, so
// traceline uses the same assistant-row seam to make the collapsed row informative:
// `Thinking: <first non-empty reasoning line>`. Adjacent label runs still coalesce into
// one line, and any OSC 133 zone marks on dropped lines (pi marks the message's first and
// last line) are transplanted onto the last kept line.
function oscSequences(line: string): string {
  return (line.match(OSC_SEQUENCE) ?? []).join("");
}

function nativeHiddenThinkingLabel(comp: any): string {
  return typeof comp?.hiddenThinkingLabel === "string" && comp.hiddenThinkingLabel.length > 0
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

type ThinkingPreview = {
  line: string;
  lineCount: number;
};

function sanitizeThinkingLine(rawLine: string): string {
  return stripAnsi(rawLine)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownToPlainInline(markdown: string): string {
  try {
    const rendered = new Markdown(markdown, 0, 0, plainMarkdownTheme).render(ONE_LINE_CAPTURE_WIDTH);
    const first = rendered.find((line) => stripAnsi(line).trim().length > 0);
    if (first) return stripAnsi(first).replace(/\s+/g, " ").trim();
  } catch {
    /* fall through to the raw sanitized line */
  }
  return sanitizeThinkingLine(markdown);
}

function thinkingPreviewForTrace(text: string): ThinkingPreview | undefined {
  const lines = text.split(/\r?\n/).map(sanitizeThinkingLine).filter(Boolean);
  const first = lines[0];
  if (!first) return undefined;
  const plain = markdownToPlainInline(first);
  return plain ? { line: plain, lineCount: lines.length } : undefined;
}

function formatThinkingPreview(preview: ThinkingPreview): string {
  const suffix = preview.lineCount > 1 ? ` ... (${preview.lineCount} lines)` : "";
  return `${preview.line}${suffix}`;
}

function thinkingPreviewLines(comp: any): string[] {
  const content = comp?.lastMessage?.content;
  if (!Array.isArray(content)) return [];
  const previews: string[] = [];
  for (const block of content) {
    if (block?.type !== "thinking" || typeof block.thinking !== "string") continue;
    const preview = thinkingPreviewForTrace(block.thinking);
    if (preview) previews.push(formatThinkingPreview(preview));
  }
  return previews;
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

function dedupeThinkingLabels(comp: any, lines: string[], width?: number): string[] {
  const label = nativeHiddenThinkingLabel(comp);
  const previews = thinkingPreviewLines(comp);
  const out: string[] = [];
  let previewIndex = 0;
  let lastLabelAt = -1; // index in `out` of the last kept label, with only blanks after it
  let salvaged = "";
  for (const line of lines) {
    const visible = stripAnsi(line).trim();
    if (visible === label) {
      const preview = previews[Math.min(previewIndex, Math.max(0, previews.length - 1))];
      previewIndex++;
      const renderedLine = preview ? replaceVisibleThinkingLabel(line, `Thinking: ${preview}`, width) : line;
      if (lastLabelAt >= 0) {
        while (out.length > lastLabelAt + 1) salvaged += oscSequences(out.pop()!);
        salvaged += oscSequences(renderedLine);
        continue;
      }
      lastLabelAt = out.length;
      out.push(renderedLine);
      continue;
    }
    if (visible.length > 0) lastLabelAt = -1;
    out.push(line);
  }
  if (salvaged && out.length > 0) out[out.length - 1] = `${salvaged}${out[out.length - 1]}`;
  return out;
}

function patchAssistantRowPrototype(proto: any): void {
  if (!proto || typeof proto.render !== "function") return;
  if (proto.__tracelineAssistantPatchVersion === TRACELINE_ASSISTANT_PATCH_VERSION) return;
  const original = proto.__tracelineOriginalAssistantRender ?? proto.render;
  proto.__tracelineOriginalAssistantRender = original;
  proto.render = function (width: number) {
    const lines = original.call(this, width);
    try {
      if (this.hideThinkingBlock === true && Array.isArray(lines)) {
        return dedupeThinkingLabels(this, lines, width);
      }
    } catch {
      /* never let pi-traceline break a render */
    }
    return lines;
  };
  proto.__tracelineAssistantPatchVersion = TRACELINE_ASSISTANT_PATCH_VERSION;
  g.__tracelineAssistantPatchVersion = TRACELINE_ASSISTANT_PATCH_VERSION;
}

// --- prototype patch (shared by every current + future tool row, applied once) --------

function currentPatchInstalled(): boolean {
  return g.__tracelinePatched === true && g.__tracelinePatchVersion === TRACELINE_PATCH_VERSION;
}

function patchWriteSnapshotHooks(proto: any): void {
  if (!proto || proto.__tracelineWriteSnapshotPatchVersion === TRACELINE_PATCH_VERSION) return;

  const originalSetArgsComplete = proto.__tracelineOriginalSetArgsComplete ?? proto.setArgsComplete;
  if (typeof originalSetArgsComplete === "function") {
    proto.__tracelineOriginalSetArgsComplete = originalSetArgsComplete;
    proto.setArgsComplete = function (...args: any[]) {
      try {
        captureWriteSnapshot(this);
      } catch {
        /* never let write diff snapshots break tool execution */
      }
      return originalSetArgsComplete.apply(this, args);
    };
  }

  const originalMarkExecutionStarted = proto.__tracelineOriginalMarkExecutionStarted ?? proto.markExecutionStarted;
  if (typeof originalMarkExecutionStarted === "function") {
    proto.__tracelineOriginalMarkExecutionStarted = originalMarkExecutionStarted;
    proto.markExecutionStarted = function (...args: any[]) {
      try {
        captureWriteSnapshot(this);
      } catch {
        /* never let write diff snapshots break tool execution */
      }
      return originalMarkExecutionStarted.apply(this, args);
    };
  }

  proto.__tracelineWriteSnapshotPatchVersion = TRACELINE_PATCH_VERSION;
}

function patchToolRowPrototype(proto: any): void {
  if (currentPatchInstalled() || !proto || typeof proto.render !== "function") return;
  patchWriteSnapshotHooks(proto);
  const original = proto.__tracelineOriginalRender ?? proto.render;
  proto.__tracelineOriginalRender = original;
  proto.render = function (width: number) {
    let mode: ToolDisplayMode = "native";
    try {
      mode = displayMode();
    } catch {
      mode = "native";
    }
    if (mode === "native") return original.call(this, width);
    if (toolIsIndividuallyExpanded(this)) {
      try {
        if (this.expanded !== true && typeof this.setExpanded === "function") this.setExpanded(true);
      } catch {
        /* ignore expansion sync failures */
      }
      return original.call(this, width);
    }
    try {
      return renderTraceRow(this, width);
    } catch {
      return original.call(this, width); // never let pi-traceline break a render
    }
  };
  g.__tracelinePatched = true;
  g.__tracelinePatchVersion = TRACELINE_PATCH_VERSION;
}

function assistantPatchInstalled(): boolean {
  return g.__tracelineAssistantPatchVersion === TRACELINE_ASSISTANT_PATCH_VERSION;
}

function tryPatch(): void {
  if ((currentPatchInstalled() && assistantPatchInstalled()) || !g.__tracelineTui) return;
  try {
    const sibs = chatChildren();
    if (!Array.isArray(sibs)) return;
    if (!currentPatchInstalled()) {
      const row = sibs.find(isToolRow);
      if (row) patchToolRowPrototype(Object.getPrototypeOf(row));
    }
    if (!assistantPatchInstalled()) {
      const assistant = sibs.find(isAssistantRow);
      if (assistant) patchAssistantRowPrototype(Object.getPrototypeOf(assistant));
    }
  } catch {
    /* never let pi-traceline break a render */
  }
}

// Test-only surface. Pi loads extensions via `jiti.import(path, { default: true })`,
// so named exports are runtime-inert; this object exists for the repo test suites
// (see docs/testing.md) and is not a stable public API.
export const internals = {
  // duck-typed pi-internal detection (contract-tested against the installed pi)
  isToolRow,
  isAssistantRow,
  // ANSI-aware text machinery
  stripAnsi,
  stripSgrBackgrounds,
  stripSgrForegrounds,
  dimUnstyledSpans,
  rawIndexAtVisibleIndex,
  rawIndexBeforeVisibleIndex,
  middleTruncate,
  rightAlignSuffix,
  tildify,
  stripTimeoutSuffix,
  bashInvocationText,
  bashCrownedHeads,
  inkBashBody,
  inkBashRow,
  flattenInvocationLines,
  rowBackground,
  shadeRow,
  // row grammar
  formatCharCount,
  charSuffix,
  diffStatsFromText,
  diffStatsFromContents,
  captureWriteSnapshot,
  writeDiffStats,
  mutationDiffStats,
  formatMutationDiffStats,
  toolFactSuffix,
  recordFacts,
  recordCells,
  recordSuffix,
  configureSizeThresholds,
  configureToolBackgrounds,
  toolBackgroundsEnabled,
  lineRange,
  toolStatus,
  blockSizeColumnLive,
  blockSuffixReserve,
  blockToolRows,
  boringPrefix,
  cwdRelativePath,
  fallbackInvocationLine,
  oneLine,
  leadingBlank,
  renderTraceRow,
  // repetition folding + thinking-label preview/dedupe (issue #14)
  cdPreambleDir,
  repeatsPreviousCdPreamble,
  elideCdPreamble,
  readRun,
  foldedReadLine,
  thinkingPreviewLines,
  dedupeThinkingLabels,
  patchAssistantRowPrototype,
  // Ctrl+T status-line suppression
  isThinkingToggleStatusRow,
  isSpacerRow,
  suppressThinkingToggleStatus,
  // mouse / click state machine
  parseSgrMouse,
  isLeftMousePress,
  shouldEnableClicks,
  setClickHandling,
  armClickOnce,
};

export default function piTraceline(pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+shift+o", {
    description: "Arm one pi-traceline row click",
    handler: async (ctx) => {
      armClickOnce();
      ctx.ui.notify("pi-traceline click armed for 8s", "info");
    },
  });

  // One command for the whole click feature: no args = arm one click for 8s,
  // `<seconds>` = arm one click with a custom TTL, `on`/`off` = persistent mode
  // (uses terminal mouse reporting, which may capture wheel/trackpad scroll).
  pi.registerCommand("traceline-click", {
    description: "Click-to-expand tool rows: no args/<seconds> arms one click; on/off toggles persistent mode",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "on") {
        setClickHandling(true);
        ctx.ui.notify("pi-traceline persistent clicks enabled; terminal scroll may be captured", "info");
        return;
      }
      if (value === "off") {
        setClickHandling(false);
        ctx.ui.notify("pi-traceline clicks disabled; terminal scroll restored", "info");
        return;
      }
      const seconds = Number.parseFloat(value);
      const ttlMs = Number.isFinite(seconds) && seconds > 0 ? Math.max(500, seconds * 1000) : 8_000;
      armClickOnce(ttlMs);
      ctx.ui.notify(`pi-traceline click armed for ${Math.round(ttlMs / 1000)}s`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Capture the real TUI (passed synchronously to the widget factory), then patch only
    // extension-visible seams: render for hit-map capture, requestRender for delayed
    // tool-row patching, and raw terminal input for SGR mouse click events.
    g.__tracelineGetTheme = () => {
      try {
        return (ctx.ui as any).theme;
      } catch {
        return undefined;
      }
    };
    const config = Object.assign(
      {},
      ...configPaths("pi-traceline", process.cwd()).map(
        (path) => readJsonConfig<Record<string, unknown>>(path) ?? {},
      ),
    );
    configureSizeThresholds(config);
    configureToolBackgrounds(config);
    captureTui(ctx.ui, "__pi_traceline_capture", (tui) => {
      const t = tui as any;
      g.__tracelineTui = t;
      patchContainerPrototype(t);
      wrapTuiRender(t);
      if (t.__tracelineRRWrapVersion !== TRACELINE_PATCH_VERSION) {
        const orig = t.__tracelineOriginalRequestRender ?? t.requestRender.bind(t);
        t.__tracelineOriginalRequestRender = orig;
        t.requestRender = (force?: boolean) => {
          tryPatch();
          try {
            suppressThinkingToggleStatus();
          } catch {
            /* never let pi-traceline break a render */
          }
          return orig(force);
        };
        t.__tracelineRRWrapVersion = TRACELINE_PATCH_VERSION;
      }
      tryPatch();
    });
    enableMouseReporting();

    // Make reload/session-start idempotent: do not stack raw-input listeners.
    // Ctrl+T itself remains Pi-native: Pi toggles reasoning visibility; this extension
    // only changes how tool rows render while reasoning is hidden. Mouse events are
    // consumed so terminal escape bytes never leak into the editor.
    g.__tracelineInputUnsubscribe?.();
    g.__tracelineInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      const mouseResult = handleMouseInput(data);
      if (mouseResult) return mouseResult;
      if (!matchesKey(data, "ctrl+t")) return undefined;
      if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
      return undefined;
    });
  });

  pi.on("session_shutdown", async () => {
    g.__tracelineInputUnsubscribe?.();
    g.__tracelineInputUnsubscribe = undefined;
    setClickHandling(false);
  });
}
