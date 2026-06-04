import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * If the invocation does not fit the terminal width, it is truncated with `...`; once a
 * result exists, a right-aligned `(chars x.xk)` result-size suffix is reserved at the end.
 * Spacing: one blank line before a tool group (restoring the spacer pi drops), none
 * between consecutive tools.
 *
 * Nothing in pi's node_modules is modified, so this survives `pi update`.
 */

type ToolDisplayMode = "native" | "oneLine";

type TracelineGlobal = typeof globalThis & {
  __tracelinePatched?: boolean;
  __tracelinePatchVersion?: number;
  __tracelineTui?: any;
  __tracelineChat?: any;
  __tracelineInputUnsubscribe?: () => void;
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
const ONE_LINE_ELLIPSIS = "...";
const TRACELINE_PATCH_VERSION = 6;

// --- chat container (holds assistant + tool rows as siblings) -------------------------

function isToolRow(c: any): boolean {
  if (!c) return false;
  if (c.constructor?.name === "ToolExecutionComponent") return true;
  return typeof c.render === "function" && typeof c.setExpanded === "function" && "toolName" in c;
}

function isAssistantRow(c: any): boolean {
  return (
    !!c && typeof c.setHideThinkingBlock === "function" && typeof c.hideThinkingBlock === "boolean"
  );
}

// The container whose direct children include the tool rows (pi's chatContainer).
function findChat(node: any, seen = new Set<any>()): any {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  const kids = node.children;
  if (Array.isArray(kids)) {
    if (kids.some(isToolRow)) return node;
    for (const k of kids) {
      const f = findChat(k, seen);
      if (f) return f;
    }
  }
  return undefined;
}

function chatChildren(): any[] | undefined {
  let chat = g.__tracelineChat;
  if (!chat || !Array.isArray(chat.children)) {
    chat = g.__tracelineTui ? findChat(g.__tracelineTui) : undefined;
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
  const chars = Math.max(0, Math.floor(value));
  const roundedTenths = Math.round(chars / 100) / 10;
  return `${roundedTenths.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}k`;
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
  return chars === undefined ? "" : `${MUTED_GREY}(chars ${formatCharCount(chars)})${RESET}`;
}

function fitOneLineAndSuffix(invocation: string, suffix: string, width: number): string {
  const maxWidth = Math.max(1, width);
  const invocationText = invocation.trimEnd();
  if (!suffix) return truncateToWidth(invocationText, maxWidth, ONE_LINE_ELLIPSIS);

  const suffixWidth = visibleWidth(suffix);
  if (suffixWidth >= maxWidth) return truncateToWidth(suffix, maxWidth, ONE_LINE_ELLIPSIS);

  const invocationWidth = Math.max(0, maxWidth - suffixWidth - 1);
  const fittedInvocation = invocationWidth > 0 ? truncateToWidth(invocationText, invocationWidth, ONE_LINE_ELLIPSIS) : "";
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

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function firstVisibleLine(lines: string[]): string | undefined {
  return lines.find((line) => stripAnsi(line).trim().length > 0);
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
  const line = firstVisibleLine(call.render(ONE_LINE_CAPTURE_WIDTH));
  return line ? colourCommandPrefix(comp, stripSgrBackgrounds(stripTrailingExpandHint(line))) : undefined;
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

function oneLine(comp: any, width: number): string {
  const lineWidth = Math.max(1, width);
  const available = Math.max(1, lineWidth - TOOL_PREFIX_VISIBLE_WIDTH);
  const invocation = nativeInvocationLine(comp) ?? `${statusColor(comp)}${fallbackInvocationLine(comp)}${RESET}`;
  const fitted = fitOneLineAndSuffix(invocation, resultCharSuffix(comp), available);
  return truncateToWidth(`${hiddenToolPrefix(comp)}${fitted}`, lineWidth, ONE_LINE_ELLIPSIS);
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

// One blank line before a tool *group*, none within it: walk back past invisible
// connector turns; tight if the nearest visible sibling is another collapsed tool row.
function leadingBlank(comp: any): boolean {
  const found = componentLocation(comp);
  if (!found || found.index <= 0) return true;
  const { sibs, index } = found;
  for (let j = index - 1; j >= 0; j--) {
    const prev = sibs[j];
    if (isToolRow(prev)) return false; // adjacent (through connectors) to another tool
    if (isEmptyConnector(prev)) continue; // skip invisible tool-call-only turns
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

export default function piTraceline(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Capture the real TUI (passed synchronously to the widget factory) and wrap
    // requestRender so we patch the shared tool-row prototype the moment a tool row
    // exists. Then remove the throwaway widget so there is no visible artifact.
    ctx.ui.setWidget("__pi_traceline_capture", (t: any) => {
      g.__tracelineTui = t;
      if (!t.__tracelineRRWrapped) {
        const orig = t.requestRender.bind(t);
        t.requestRender = (force?: boolean) => {
          tryPatch();
          return orig(force);
        };
        t.__tracelineRRWrapped = true;
      }
      return { render: () => [] as string[], invalidate: () => {} };
    });
    ctx.ui.setWidget("__pi_traceline_capture", undefined);

    // Make reload/session-start idempotent: do not stack raw-input listeners.
    // Ctrl+T itself remains Pi-native: Pi toggles reasoning visibility; this extension
    // only changes how tool rows render while reasoning is hidden.
    g.__tracelineInputUnsubscribe?.();
    g.__tracelineInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "ctrl+t")) return undefined;
      if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
      return undefined;
    });
  });

  pi.on("session_shutdown", async () => {
    g.__tracelineInputUnsubscribe?.();
    g.__tracelineInputUnsubscribe = undefined;
  });
}
