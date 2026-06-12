import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * One-line rendering reuses pi's native tool call renderer, so visual defaults
 * (bold command name, accent paths/backticks, warning line ranges, etc.) drift with pi.
 * Each row sits on pi's own status-tinted tool background (the same shaded surface the
 * expanded block uses, borrowed live from the row's contentBox), so collapsed and
 * expanded read as the same object at different zoom — and consecutive rows tile into
 * one shaded slab per tool group. Multiline bash commands are flattened into the one
 * trace line with a dim ↵ marking each original break, so heredocs and inline scripts
 * keep their operative tail instead of collapsing to `$ python3 -c "`.
 * The ink follows the family hierarchy (docs/design-language.md): shell plumbing (`&&`,
 * `|`, `2>/dev/null`, heredoc markers) is dimmed so command segments pop, and the
 * boilerplate `(timeout Ns)` suffix is dropped — the full invocation is one Ctrl+T away.
 * Home-dir prefixes are tildified, and over-long invocations are *middle*-truncated with
 * a dimmed `…` so the tail survives — the basename + `:line-range` for a path, or the
 * operative end of a command — because that is where the discriminating information lives;
 * the cut snaps to a nearby `/` or space. Plain file reads additionally dim the directory
 * so the basename stands out. Once a result exists, a right-aligned `1.2k ch` result-size
 * suffix is reserved at the end — dim while healthy, warning-/error-tinted when an output
 * balloons past the size thresholds, so "what flooded the context" pops out of the column.
 * All ink is theme-derived (style.ts ink()), with raw-ANSI fallbacks before a theme exists.
 *
 * Repetition the model emits is folded rather than re-printed (issue #14): a bash row
 * whose `cd <dir> && ` preamble repeats the previous bash row's renders it as a dim `⋯`,
 * giving the width back to the part of the command that differs; consecutive reads paging
 * through one file collapse into a single `read path:1-200,201-400 · 2 calls` row; and an
 * assistant message whose adjacent thinking blocks would print two collapsed `Thinking...`
 * labels gets them coalesced into one.
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
const TOOL_GUTTER = "  ";
const TOOL_BULLET = GLYPH.tool;
const TOOL_AFTER_BULLET = " ";
const TOOL_PREFIX_VISIBLE_WIDTH = TOOL_GUTTER.length + 1 + TOOL_AFTER_BULLET.length;
const ONE_LINE_CAPTURE_WIDTH = 10_000;
const LINE_BREAK_MARK = "\u21b5"; // ↵ — marks a real newline in a flattened invocation
const PREAMBLE_MARK = "\u22ef"; // ⋯ — stands in for a preamble identical to the row above
const TRACELINE_PATCH_VERSION = 12;
const TRACELINE_CONTAINER_PATCH_VERSION = 1;
const TRACELINE_ASSISTANT_PATCH_VERSION = 1;

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

function toolPrefix(tone: Tone): string {
  return `${TOOL_GUTTER}${ink(currentTheme(), tone, TOOL_BULLET)}${TOOL_AFTER_BULLET}`;
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

function configureSizeThresholds(config: { sizeWarningChars?: unknown; sizeErrorChars?: unknown } | undefined): void {
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

function charSuffix(chars: number | undefined): string {
  if (chars === undefined) return "";
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
  return charSuffix(resultTextCharCount(comp));
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
// (issue #10). Flatten every visible line into the one trace line, with a dim ↵ where
// each break was — middle truncation then keeps the head *and* the operative tail.
function flattenInvocationLines(lines: string[]): string | undefined {
  const visible = lines
    .filter((line) => stripAnsi(line).trim().length > 0)
    .map((line) => trimLeadingVisibleWhitespace(line.trimEnd()));
  if (visible.length === 0) return undefined;
  return visible.join(` ${dim(LINE_BREAK_MARK)} `);
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
// noise; the full invocation (timeout included) is one Ctrl+T / click away.
function stripTimeoutSuffix(line: string): string {
  const visible = stripAnsi(line);
  const hint = visible.match(/ \(timeout [^)]*\)\s*$/i)?.[0];
  if (!hint) return line;
  const rawStart = rawIndexAtVisibleIndex(line, visible.length - hint.length);
  return `${line.slice(0, rawStart)}${RESET}`;
}

// Ink hierarchy for command rows: dim the shell plumbing (connectors, null redirects,
// heredoc markers) so the command segments carry the brightness. Matches only
// space-delimited operator tokens, which keeps it out of SGR params and most quoted
// strings; a dimmed operator inside a quoted string would be a cosmetic-only miss.
const SHELL_PLUMBING =
  / (&&|\|\||\||;|2>&1|[&12]?>>?\s?\/dev\/null|<<-?\s?'?[A-Za-z_][A-Za-z0-9_]*'?)(?= |$)/g;

function dimShellPlumbing(line: string): string {
  return line.replace(SHELL_PLUMBING, (_m, op: string) => ` ${dim(op)}`);
}

function commandPrefixLength(comp: any, line: string): number {
  const visible = stripAnsi(line).trimStart();
  const name = toolLabel(comp?.toolName);
  if (name === "bash" && visible.startsWith("$ ")) {
    return 1; // colour only the shell prompt; the command itself is argument text
  }
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
  return `${ink(currentTheme(), statusTone(comp), `${BOLD}${prefix}${BOLD_OFF}`)}${rest}`;
}

// Prefer pi's own renderCall output for one-line mode. This borrows the native visual
// grammar (paths/backticks, warning line ranges, custom-tool renderers) and only
// suppresses result/output lines by taking the first visible call line. The invocation
// prefix itself is recoloured by execution status for scanability.
function nativeInvocationLine(comp: any): string | undefined {
  const call = comp?.callRendererComponent;
  if (!call || typeof call.render !== "function") return undefined;
  const rendered = withLayoutSuppressed(() => call.render(ONE_LINE_CAPTURE_WIDTH));
  const lines = Array.isArray(rendered) ? rendered : [];
  // Bash: every rendered line is invocation (the command's own newlines), so flatten.
  // Other tools keep first-line-only — that is what suppresses their preview/body lines.
  const line = toolLabel(comp?.toolName) === "bash" ? flattenInvocationLines(lines) : firstVisibleLine(lines);
  return line
    ? colourCommandPrefix(comp, stripSgrBackgrounds(stripTimeoutSuffix(stripTrailingExpandHint(line))))
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

// Emphasis for plain file reads: dim the directory so the basename (which file) and the
// :line-range (how much of it) stand out. Applied only when the native row is a bare
// `read <path>[:range]`; rows with a secondary label (resource / [skill]) keep native.
function pathEmphasisLine(comp: any, nativeColored: string): string | undefined {
  if (toolLabel(comp?.toolName) !== "read") return undefined;
  const path = comp?.args?.path;
  if (typeof path !== "string" || path.length === 0) return undefined;
  const tildePath = tildify(path);
  const lastSlash = tildePath.lastIndexOf("/");
  if (lastSlash < 0) return undefined;
  if (!stripAnsi(nativeColored).trim().startsWith(`read ${tildePath}`)) return undefined;
  const dir = tildePath.slice(0, lastSlash + 1);
  const base = tildePath.slice(lastSlash + 1);
  const range = lineRange(comp?.args);
  return `${ink(currentTheme(), statusTone(comp), `${BOLD}read${BOLD_OFF}`)} ${dim(dir)}${base}${dim(range)}`;
}

// The shaded tool surface, borrowed live from the row itself. pi keeps contentBox.bgFn
// status-synced (toolPendingBg / toolSuccessBg / toolErrorBg from the active theme), so
// the collapsed row inherits the exact background the expanded block would have — theme,
// light/dark, and colour-mode handling all come for free, and the band retints when the
// result lands. Self-framing tools have no native shade, so they get none here either.
function rowBackground(comp: any): ((text: string) => string) | undefined {
  try {
    if (typeof comp?.getRenderShell === "function" && comp.getRenderShell() === "self") return undefined;
    const bgFn = comp?.contentBox?.bgFn;
    return typeof bgFn === "function" ? bgFn : undefined;
  } catch {
    return undefined;
  }
}

// Full-width band: pad to width, then re-assert the background after every full SGR
// reset (traceline's own ink uses \x1b[0m liberally) so the surface never punches holes.
function shadeRow(line: string, width: number, bgFn: (text: string) => string): string {
  const [open = "", close = ""] = bgFn("\u0000").split("\u0000");
  if (!open) return line;
  const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
  return `${open}${padded.split(RESET).join(`${RESET}${open}`)}${close}`;
}

function oneLine(comp: any, width: number): string {
  const lineWidth = Math.max(1, width);
  const available = Math.max(1, lineWidth - TOOL_PREFIX_VISIBLE_WIDTH);
  const native = nativeInvocationLine(comp);
  const base =
    (native && pathEmphasisLine(comp, native)) ??
    native ??
    ink(currentTheme(), statusTone(comp), fallbackInvocationLine(comp));
  const tilded = tildify(base);
  let invocation = tilded;
  if (toolLabel(comp?.toolName) === "bash") {
    if (repeatsPreviousCdPreamble(comp)) invocation = elideCdPreamble(invocation);
    invocation = dimShellPlumbing(invocation);
  }
  const fitted = rightAlignSuffix(invocation, resultCharSuffix(comp), available, currentTheme());
  const row = truncateToWidth(`${hiddenToolPrefix(comp)}${fitted}`, lineWidth, ELLIPSIS);
  const bgFn = rowBackground(comp);
  return bgFn ? shadeRow(row, lineWidth, bgFn) : row;
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

function elideCdPreamble(line: string): string {
  const visible = stripAnsi(line);
  if (!visible.startsWith("$ ")) return line;
  // Find the separator with the same quote-aware parse used to detect the repeat: a
  // plain indexOf(" && ") would cut inside a quoted directory (`cd "/tmp/a && b" && …`)
  // and corrupt the command. The match tail is `\s*&&\s`, so its last `&&` *is* the
  // separator, after any quoted segment.
  const preamble = CD_PREAMBLE.exec(visible.slice(2));
  if (!preamble) return line;
  const ampIndex = 2 + preamble[0].lastIndexOf("&&");
  const head = line.slice(0, rawIndexAtVisibleIndex(line, 2)); // `$ ` with its styling
  const rest = line.slice(rawIndexAtVisibleIndex(line, ampIndex)); // from `&& …`
  return `${head}${dim(PREAMBLE_MARK)} ${rest}`;
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

function foldedReadLine(rows: any[], width: number): string {
  const lineWidth = Math.max(1, width);
  const available = Math.max(1, lineWidth - TOOL_PREFIX_VISIBLE_WIDTH);
  const theme = currentTheme();
  const last = rows[rows.length - 1];
  const tone = statusTone(last);
  const path = tildify(String(rows[0]?.args?.path ?? ""));
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const ranges = rows
    .map((row) => lineRange(row?.args).slice(1))
    .filter(Boolean)
    .join(",");
  const body = `${ink(theme, tone, `${BOLD}read${BOLD_OFF}`)} ${dim(dir)}${base}${dim(ranges ? `:${ranges}` : "")}`;
  let total: number | undefined;
  for (const row of rows) {
    const chars = resultTextCharCount(row);
    if (chars !== undefined) total = (total ?? 0) + chars;
  }
  // Call count rides the right-aligned suffix (fact order: what · how many · how big),
  // so middle truncation protects the discriminating basename+ranges tail of the body.
  const calls = `${rows.length} calls`;
  const suffix = total === undefined ? dim(calls) : `${dim(`${calls}${SEP}`)}${charSuffix(total)}`;
  const fitted = rightAlignSuffix(body, suffix, available, theme);
  const row = truncateToWidth(`${toolPrefix(tone)}${fitted}`, lineWidth, ELLIPSIS);
  const bgFn = rowBackground(last);
  return bgFn ? shadeRow(row, lineWidth, bgFn) : row;
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
// "Thinking..." line. The tool row that follows is that thought's action, so the two
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
// or the collapsed "Thinking..." line that motivated this call.
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

// --- doubled Thinking… labels (issue #14, pi-native rendering) --------------------------

// pi renders the collapsed thinking label once per thinking *block*, not per message, so
// a message with adjacent thinking blocks prints consecutive identical `Thinking...`
// lines that carry no more information than one. Coalesce them at render time. Dropped
// lines can carry OSC 133 zone marks (pi marks the message's first and last line), so
// any control sequences on dropped lines are transplanted onto the last kept line.
function oscSequences(line: string): string {
  return (line.match(OSC_SEQUENCE) ?? []).join("");
}

function dedupeThinkingLabels(comp: any, lines: string[]): string[] {
  const label =
    typeof comp?.hiddenThinkingLabel === "string" && comp.hiddenThinkingLabel.length > 0
      ? comp.hiddenThinkingLabel
      : "Thinking...";
  const out: string[] = [];
  let lastLabelAt = -1; // index in `out` of the last kept label, with only blanks after it
  let salvaged = "";
  for (const line of lines) {
    const visible = stripAnsi(line).trim();
    if (visible === label) {
      if (lastLabelAt >= 0) {
        while (out.length > lastLabelAt + 1) salvaged += oscSequences(out.pop()!);
        salvaged += oscSequences(line);
        continue;
      }
      lastLabelAt = out.length;
      out.push(line);
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
        return dedupeThinkingLabels(this, lines);
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

function patchToolRowPrototype(proto: any): void {
  if (currentPatchInstalled() || !proto || typeof proto.render !== "function") return;
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
  rawIndexAtVisibleIndex,
  rawIndexBeforeVisibleIndex,
  middleTruncate,
  rightAlignSuffix,
  tildify,
  stripTimeoutSuffix,
  dimShellPlumbing,
  flattenInvocationLines,
  rowBackground,
  shadeRow,
  // row grammar
  formatCharCount,
  charSuffix,
  configureSizeThresholds,
  lineRange,
  toolStatus,
  fallbackInvocationLine,
  oneLine,
  leadingBlank,
  renderTraceRow,
  // repetition folding + thinking-label dedupe (issue #14)
  cdPreambleDir,
  repeatsPreviousCdPreamble,
  elideCdPreamble,
  readRun,
  foldedReadLine,
  dedupeThinkingLabels,
  patchAssistantRowPrototype,
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
    configureSizeThresholds(
      Object.assign(
        {},
        ...configPaths("pi-traceline", process.cwd()).map(
          (path) => readJsonConfig<Record<string, unknown>>(path) ?? {},
        ),
      ),
    );
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
