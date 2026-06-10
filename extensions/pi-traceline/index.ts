import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OSC_SEQUENCE, stripAnsi } from "../_lib/ansi.ts";
import { captureTui } from "../_lib/capture.ts";
import { findChatContainer, isAssistantRow, isToolRow } from "../_lib/chat.ts";
import { compactCount } from "../_lib/fmt.ts";

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
 * The ink follows an information hierarchy: shell plumbing (`&&`, `|`, `2>/dev/null`,
 * heredoc markers) is dimmed so command segments pop, and the boilerplate `(timeout Ns)`
 * suffix is dropped — the full invocation is one Ctrl+T away. Home-dir prefixes are
 * tildified, and over-long invocations are *middle*-truncated with a
 * dimmed `…` so the tail survives — the basename + `:line-range` for a path, or the
 * operative end of a command — because that is where the discriminating information lives;
 * the cut snaps to a nearby `/` or space. Plain file reads additionally dim the directory
 * so the basename stands out. Once a result exists, a right-aligned dimmed `1.2k ch`
 * result-size suffix is reserved at the end. Spacing: one blank line before a tool group
 * (restoring the spacer pi drops), none between consecutive tools. One-shot click mode
 * toggles a clicked row only, without changing Pi's global tool expansion state.
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
};
const g = globalThis as TracelineGlobal;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const MUTED_GREY = "\x1b[38;2;128;128;128m";
const TOOL_GUTTER = "  ";
const TOOL_BULLET = "›";
const TOOL_AFTER_BULLET = " ";
const TOOL_PREFIX_VISIBLE_WIDTH = TOOL_GUTTER.length + 1 + TOOL_AFTER_BULLET.length;
const ONE_LINE_CAPTURE_WIDTH = 10_000;
const ONE_LINE_ELLIPSIS = "\u2026";
const LINE_BREAK_MARK = "\u21b5"; // ↵ — marks a real newline in a flattened invocation
const TRACELINE_PATCH_VERSION = 11;
const TRACELINE_CONTAINER_PATCH_VERSION = 1;
const MIN_HEAD_COLS = 6;
const TAIL_RATIO = 0.55;
const SNAP_WINDOW = 8;
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

function statusColor(comp: any): string {
  const status = toolStatus(comp);
  if (status === "error") return RED;
  if (status === "success") return GREEN;
  return BLUE;
}

function hiddenToolPrefixColor(color: string): string {
  return `${TOOL_GUTTER}${color}${TOOL_BULLET}${RESET}${TOOL_AFTER_BULLET}`;
}

function hiddenToolPrefix(comp: any): string {
  return hiddenToolPrefixColor(statusColor(comp));
}

function formatCharCount(value: number): string {
  return compactCount(Math.max(0, Math.floor(value)));
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
  const chars = resultTextCharCount(comp);
  return chars === undefined ? "" : `${MUTED_GREY}${formatCharCount(chars)} ch${RESET}`;
}

// Replace an absolute home-directory prefix with ~ so boilerplate path heads stop eating
// width (e.g. bash `cd /Users/me/... && ...` -> `cd ~/... && ...`). OSC sequences are
// skipped: a read row's OSC 8 hyperlink carries a file:// URL containing the home path,
// and tildifying *that* would corrupt the click target. The pattern is built once —
// tildify runs for every visible row on every frame.
const TILDIFY_PATTERN = (() => {
  const home = homedir();
  if (!home) return undefined;
  return new RegExp(`${OSC_SEQUENCE.source}|${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
})();

function tildify(text: string): string {
  if (!TILDIFY_PATTERN) return text;
  return text.replace(TILDIFY_PATTERN, (match) => (match.startsWith("\x1b") ? match : "~"));
}

function isVisibleBoundary(ch: string): boolean {
  return ch === "/" || ch === " ";
}

// ANSI-aware middle truncation that protects the *tail* of the line — the basename +
// :line-range for a path, or the operative end of a command — because that is where the
// information distinguishing one row from the next lives. The cut snaps to a nearby "/"
// or space boundary, and the ellipsis is dimmed so it reads as a UI marker rather than as
// part of the path/command. Falls back to tail truncation only when the width is too
// small to keep both ends.
function middleTruncate(line: string, width: number): string {
  const maxWidth = Math.max(1, width);
  if (visibleWidth(line) <= maxWidth) return line;

  const vis = stripAnsi(line);
  const visLen = vis.length;
  const ellipsisWidth = visibleWidth(ONE_LINE_ELLIPSIS);
  const budget = Math.max(1, maxWidth - ellipsisWidth); // reserve columns for the ellipsis

  const maxTail = Math.min(budget - MIN_HEAD_COLS, Math.max(12, Math.floor(budget * TAIL_RATIO)));
  if (maxTail < 1) return truncateToWidth(line, maxWidth, ONE_LINE_ELLIPSIS);

  // Longest tail that fits `maxTail` and starts at a separator, so it reads as `.../seg`.
  let tailStart = -1;
  for (let i = Math.max(0, visLen - maxTail); i < visLen; i++) {
    if (isVisibleBoundary(vis[i])) {
      tailStart = i;
      break;
    }
  }
  if (tailStart < 0) tailStart = visLen - maxTail; // no boundary in range: keep the end

  const dimEllipsis = `${MUTED_GREY}${ONE_LINE_ELLIPSIS}${RESET}`;
  const tailRaw = line.slice(rawIndexAtVisibleIndex(line, tailStart));

  let headEnd = budget - (visLen - tailStart);
  if (headEnd <= 0) return `${dimEllipsis}${tailRaw}`;

  // Snap the head back to a nearby boundary so the ellipsis lands on a clean edge: keep a
  // trailing "/" on the head side, drop a trailing space. Search from the last kept char
  // inward so keeping the "/" can never push the head past its budget.
  for (let i = headEnd - 1; i >= Math.max(0, headEnd - SNAP_WINDOW); i--) {
    if (isVisibleBoundary(vis[i])) {
      headEnd = vis[i] === "/" ? i + 1 : i;
      break;
    }
  }
  headEnd = Math.min(headEnd, tailStart);
  if (headEnd <= 0) return `${dimEllipsis}${tailRaw}`;

  const headRaw = line.slice(0, rawIndexAtVisibleIndex(line, headEnd));
  return `${headRaw}${RESET}${dimEllipsis}${tailRaw}`;
}

function fitOneLineAndSuffix(invocation: string, suffix: string, width: number): string {
  const maxWidth = Math.max(1, width);
  const invocationText = invocation.trimEnd();
  if (!suffix) return middleTruncate(invocationText, maxWidth);

  const suffixWidth = visibleWidth(suffix);
  if (suffixWidth >= maxWidth) return truncateToWidth(suffix, maxWidth, ONE_LINE_ELLIPSIS);

  const invocationWidth = Math.max(0, maxWidth - suffixWidth - 1);
  const fittedInvocation = invocationWidth > 0 ? middleTruncate(invocationText, invocationWidth) : "";
  const gapWidth = Math.max(1, maxWidth - visibleWidth(fittedInvocation) - suffixWidth);
  return `${fittedInvocation}${" ".repeat(gapWidth)}${suffix}`;
}

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
  return visible.join(` ${MUTED_GREY}${LINE_BREAK_MARK}${RESET} `);
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

function ansiEndIndex(line: string, i: number): number | undefined {
  if (line[i] !== "\x1b") return undefined;
  if (line[i + 1] === "[") {
    const end = line.slice(i).search(/[A-Za-z~]/);
    return end >= 0 ? i + end : undefined;
  }
  if (line[i + 1] === "]") {
    const bel = line.indexOf("\x07", i + 2);
    const st = line.indexOf("\x1b\\", i + 2);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    return end >= 0 ? end + (line[end] === "\x1b" ? 1 : 0) : undefined;
  }
  return undefined;
}

function rawIndexAtVisibleIndex(line: string, target: number): number {
  let visible = 0;
  for (let i = 0; i < line.length; i++) {
    const ansiEnd = ansiEndIndex(line, i);
    if (ansiEnd !== undefined) {
      i = ansiEnd;
      continue;
    }
    if (visible === target) return i;
    visible++;
  }
  return line.length;
}

function rawIndexBeforeVisibleIndex(line: string, target: number): number {
  let visible = 0;
  for (let i = 0; i < line.length; i++) {
    if (visible === target) return i;
    const ansiEnd = ansiEndIndex(line, i);
    if (ansiEnd !== undefined) {
      i = ansiEnd;
      continue;
    }
    visible++;
  }
  return line.length;
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
  return line.replace(SHELL_PLUMBING, (_m, op: string) => ` ${MUTED_GREY}${op}${RESET}`);
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
  return `${statusColor(comp)}${BOLD}${prefix}${BOLD_OFF}${RESET}${rest}`;
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
  return `${statusColor(comp)}${BOLD}read${BOLD_OFF}${RESET} ${MUTED_GREY}${dir}${RESET}${base}${MUTED_GREY}${range}${RESET}`;
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
  const base = (native && pathEmphasisLine(comp, native)) ?? native ?? `${statusColor(comp)}${fallbackInvocationLine(comp)}${RESET}`;
  const tilded = tildify(base);
  const invocation = toolLabel(comp?.toolName) === "bash" ? dimShellPlumbing(tilded) : tilded;
  const fitted = fitOneLineAndSuffix(invocation, resultCharSuffix(comp), available);
  const row = truncateToWidth(`${hiddenToolPrefix(comp)}${fitted}`, lineWidth, ONE_LINE_ELLIPSIS);
  const bgFn = rowBackground(comp);
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
      const line = oneLine(this, width);
      return leadingBlank(this) ? ["", line] : [line];
    } catch {
      return original.call(this, width); // never let pi-traceline break a render
    }
  };
  g.__tracelinePatched = true;
  g.__tracelinePatchVersion = TRACELINE_PATCH_VERSION;
}

function tryPatch(): void {
  if (currentPatchInstalled() || !g.__tracelineTui) return;
  try {
    const sibs = chatChildren();
    const row = Array.isArray(sibs) ? sibs.find(isToolRow) : undefined;
    if (row) patchToolRowPrototype(Object.getPrototypeOf(row));
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
  fitOneLineAndSuffix,
  tildify,
  stripTimeoutSuffix,
  dimShellPlumbing,
  flattenInvocationLines,
  rowBackground,
  shadeRow,
  // row grammar
  formatCharCount,
  lineRange,
  toolStatus,
  fallbackInvocationLine,
  oneLine,
  leadingBlank,
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
