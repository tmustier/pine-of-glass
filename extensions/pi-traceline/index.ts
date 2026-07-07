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
import { resolve } from "node:path";
import { OSC_SEQUENCE, rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { positiveNumberValue, isJsonObject } from "../_lib/boundary.ts";
import { captureTui } from "../_lib/capture.ts";
import {
  findChatContainer,
  isAssistantRow,
  isToolRow,
  type AssistantRowDataLike,
  type AssistantRowLike,
  type AssistantRowPrototypeLike,
  type ContainerLike,
  type ToolArgsLike,
  type ToolRowDataLike,
  type ToolRowLike,
  type ToolRowPrototypeLike,
  type TracelineTuiLike,
} from "../_lib/chat.ts";
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
 * collapses or expands), so that status pair is suppressed before it renders (§9.11);
 * every other showStatus message passes through untouched.
 *
 * One-line rendering reuses pi's native tool call renderer for most tools, so visual
 * defaults (accent paths/backticks, warning line ranges, custom renderers) drift with pi;
 * bash rows re-ink their body from the rendered *text* instead, so the wall of commands
 * stays quiet. Rows are intentionally unbanded (the edit-tool look): status stays in
 * the bullet and severity suffixes. Multiline bash commands are flattened
 * into the one trace line with a dim ↵ marking each original break, so heredocs and
 * inline scripts keep their operative tail instead of collapsing to `$ python3 -c "`.
 * The ink follows the family hierarchy (docs/design-language.md §9): every
 * trace row opens with a dim `▏` rail so a run of tool rows fuses into one visible
 * block against assistant prose; verbs are neutral bold with status in the › bullet
 * (failed rows tint the discriminators — verb, bash head, basename — error, §9.2);
 * bash bodies sit at the one L3-dim supporting grey with the informative command
 * heads L0-bold (§9.4: sequencers — space-delimited or attached `;`,
 * quote-aware — and flattened `↵` breaks start new commands; pipes and redirects
 * continue one; heredoc bodies are inert; `cd`/`set` preambles and echo/true-style
 * plumbing only wear a crown when no real command does), and native rows for other
 * tools demote unstyled spans to dim (§9.6); the boilerplate
 * `(timeout Ns)` suffix is dropped — the full invocation is one Ctrl+T away.
 * Home-dir prefixes are tildified, and over-long invocations are *middle*-truncated with
 * a dimmed `…` so the tail survives — the basename plus its inline qualifier
 * (`:line-range` for a read, `+N -M` for an edit/write) for a path, or the
 * operative end of a command — because that is where the discriminating information lives;
 * the cut snaps to a nearby `/` or space. Plain file reads, edits, and writes additionally
 * dim the directory so the basename stands out. Once a result exists, a right-aligned `1.2k ch` result-size
 * suffix is reserved at the end — dim while healthy, warning-/error-tinted when an output
 * balloons past the size thresholds, so "what flooded the context" pops out of the column.
 * Rows render into a 2-column right inset mirroring the left gutter (§9.1), with a
 * ≥2-space gap between body and suffix, so the block nests on both sides and truncated
 * tails stop crowding the facts.
 * Results under 100 ch render no char suffix (§9.7) unless a neighbouring row in the
 * same block clears the floor — the column is block-scoped (§9.7), so a live column
 * shows every cell and stays vertically aligned, while an all-tiny block stays clean. File-mutation rows carry `+N -M` inline
 * on the basename instead (§9.5), the way a read carries its `:line-range`: the near-noise size cell
 * (a confirmation's length, not the file's) is dropped, so a mutation's suffix stays empty and the
 * magnitude rides the file it changed (zero sides dropped: `+2 -0` → `+2`).
 * Bash rows whose output proves they landed shared state graduate to verb-led outcome
 * rows (§9.10): the record leads and the command trails behind its `$` —
 * `pushed main $ git push` — and the size cell is suppressed below warning severity,
 * because the record is the row's story and a confirmation's length is not.
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
 * between consecutive tools.
 *
 * Nothing in pi's node_modules is modified, so this survives `pi update`.
 */

type ToolDisplayMode = "native" | "oneLine";

type TracelineGlobal = typeof globalThis & {
  __tracelinePatchVersion?: number;
  __tracelineTui?: TracelineTuiLike;
  __tracelineChat?: ContainerLike;
  __tracelineInputUnsubscribe?: () => void;
  __tracelineGetTheme?: () => Theme | undefined;
  __tracelineAssistantPatchVersion?: number;
};
const g = globalThis as TracelineGlobal;
type ExtensionUiWithTheme = { theme?: Theme };
function setTracelineChat(chat: ContainerLike | undefined): void { g.__tracelineChat = chat; }
function getTracelineChat(): ContainerLike | undefined { return g.__tracelineChat; }
function setTracelineThemeGetter(getTheme: (() => Theme | undefined) | undefined): void { g.__tracelineGetTheme = getTheme; }

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const TOOL_RAIL = GLYPH.rail;
const TOOL_BULLET = GLYPH.tool;
const TOOL_INDENT = "  "; // trace blocks nest one gutter under the prose margin (§9.1)
const TOOL_AFTER_BULLET = " ";
// indent + ▏ + space + › + space — six visible columns; prose owns the margin.
const TOOL_PREFIX_VISIBLE_WIDTH = TOOL_INDENT.length + 2 + 1 + TOOL_AFTER_BULLET.length;
// The block nests on both sides (§9.1): a 2-column right inset mirrors the left
// gutter, so the suffix column never touches the terminal edge.
const TOOL_RIGHT_MARGIN = 2;
const ONE_LINE_CAPTURE_WIDTH = 10_000;
const LINE_BREAK_MARK = "\u21b5"; // ↵ — marks a real newline in a flattened invocation
const PREAMBLE_MARK = "\u22ef"; // ⋯ — stands in for a preamble identical to the row above
const TRACELINE_PATCH_VERSION = 26;
const TRACELINE_ASSISTANT_PATCH_VERSION = 2;

// --- theme-derived ink (design language §3) --------------------------------------------
// The live Theme handle is captured at session_start; before that (and in unit tests
// without one) ink() falls back to basic raw ANSI. The registered getter guards its
// own property access, so the hottest call in the file stays bare.

function currentTheme(): Theme | undefined {
  return g.__tracelineGetTheme?.();
}

function dim(text: string): string {
  return ink(currentTheme(), "dim", text);
}
// --- chat container (holds assistant + tool rows as siblings) -------------------------
// Structural detection (isToolRow / isAssistantRow / findChatContainer) lives in _lib
// and is shared across the extension family.

function chatChildren(): unknown[] | undefined {
  let chat = g.__tracelineChat;
  if (!chat || !Array.isArray(chat.children)) {
    chat = g.__tracelineTui ? findChatContainer(g.__tracelineTui) : undefined;
    g.__tracelineChat = chat;
  }
  return chat?.children;
}

// --- reasoning-visibility = source of truth for tool collapse -------------------------

// True when pi is currently hiding reasoning. Read from a live assistant row so tool
// visibility can never desync from reasoning. A tool row always follows the assistant
// turn that issued it, so a sibling assistant row exists whenever this runs; the
// theoretical no-row case defaults to native rather than guessing from disk.
function thinkingHidden(): boolean {
  const sibs = chatChildren();
  if (sibs) {
    for (let i = sibs.length - 1; i >= 0; i--) {
      const row = sibs[i];
      if (isAssistantRow(row)) return row.hideThinkingBlock;
    }
  }
  return false;
}

function displayMode(): ToolDisplayMode {
  return thinkingHidden() ? "oneLine" : "native";
}

// --- suppressing pi's Ctrl+T status line (design language §9.11) ---------------------
// pi's toggleThinkingBlockVisibility appends a dim "Thinking blocks: hidden/visible"
// status pair (Spacer + Text) to the chat tail — a holdover from when the toggle's only
// visible effect was each thinking block collapsing to a label. With traceline loaded
// the flip is self-evident (every tool row collapses to a trace line or expands back),
// so the label is redundant noise; drop the pair inside the requestRender that
// announces it, before it ever reaches the screen. Other showStatus messages
// ("Forked to new session", …) are announcements of otherwise-invisible actions and
// pass through untouched.
const THINKING_TOGGLE_STATUS = /^Thinking blocks: (?:hidden|visible)$/;

function isThinkingToggleStatusRow(comp: unknown): boolean {
  if (!comp || typeof comp !== "object") return false;
  const row = comp as { text?: unknown; setText?: unknown };
  return typeof row.text === "string" && typeof row.setText === "function" && THINKING_TOGGLE_STATUS.test(stripAnsi(row.text).trim());
}

// pi's showStatus pairs the Text with a one-line Spacer; drop that too so no stray
// blank line accumulates at the chat tail.
function isSpacerRow(comp: unknown): boolean {
  if (!comp || typeof comp !== "object") return false;
  const row = comp as { lines?: unknown; setLines?: unknown };
  return typeof row.setLines === "function" && typeof row.lines === "number" && !("text" in comp);
}

function suppressThinkingToggleStatus(): void {
  const sibs = chatChildren();
  if (!sibs || sibs.length === 0 || !isThinkingToggleStatusRow(sibs[sibs.length - 1])) return;
  sibs.pop();
  if (sibs.length > 0 && isSpacerRow(sibs[sibs.length - 1])) sibs.pop();
}

// --- one-line rendering ---------------------------------------------------------------

// Raw tool name exactly as pi reports it (read, edit, bash, mcp/tool names, etc.).
function toolLabel(name: unknown): string {
  return typeof name === "string" && name.length > 0 ? name : "tool";
}

type ToolStatus = "success" | "running" | "error";

type DiffStats = { added: number; removed: number };

function toolStatus(comp: ToolRowDataLike | undefined): ToolStatus {
  if (comp?.result?.isError) return "error";
  if (comp?.result && comp?.isPartial !== true) return "success";
  return "running";
}

function statusTone(comp: ToolRowDataLike | undefined): Tone {
  const status = toolStatus(comp);
  if (status === "error") return "error";
  if (status === "success") return "success";
  return "running";
}

// Verb ink (design language §2/§9.2): identity is neutral bold — status lives in the ›
// bullet — so a healthy column of read/edit/$ verbs stays calm while assistant prose
// owns full brightness. Only a real anomaly (a failed call) tints its verb.
function verbTone(comp: ToolRowDataLike | undefined): Tone {
  return toolStatus(comp) === "error" ? "error" : "text";
}

function verbInk(comp: ToolRowDataLike | undefined, verb: string): string {
  return ink(currentTheme(), verbTone(comp), `${BOLD}${verb}${BOLD_OFF}`);
}

// Bold is the trace row's white (design language §9.3) and errors tint the
// discriminators (§9.2): basenames and bash head commands take exactly the verb's
// treatment — bold `text` on healthy rows, bold `error` on failed rows — so plain
// prose-weight white never appears inside a trace row and a failed call is more than
// one red glyph in a dim wall.
function discriminatorInk(comp: ToolRowDataLike | undefined, text: string): string {
  return verbInk(comp, text);
}

// Every trace row indents one gutter, then opens with the dim ▏ rail (design language
// §1/§5/§9.1): the block nests under the narrative line that motivated it, consecutive
// rows fuse into one visible block, and the blank spacer before a group ends the rail.
function toolPrefix(tone: Tone): string {
  return `${TOOL_INDENT}${dim(TOOL_RAIL)} ${ink(currentTheme(), tone, TOOL_BULLET)}${TOOL_AFTER_BULLET}`;
}

function formatCharCount(value: number): string {
  return compactCount(Math.max(0, Math.floor(value)));
}

// Severity thresholds (design language §6): dim while healthy, warning/error when an
// output balloons. Overridable via the family config convention
// (~/.pi/agent/pi-traceline.json / <cwd>/.pi/pi-traceline.json).
let sizeThresholds: SizeThresholds = SIZE_THRESHOLDS;

type TracelineConfig = {
  sizeWarningChars?: number;
  sizeErrorChars?: number;
};

function parseTracelineConfig(value: unknown): TracelineConfig {
  if (!isJsonObject(value)) return {};
  const sizeWarningChars = positiveNumberValue(value.sizeWarningChars);
  const sizeErrorChars = positiveNumberValue(value.sizeErrorChars);
  return {
    ...(sizeWarningChars !== undefined ? { sizeWarningChars: Math.floor(sizeWarningChars) } : {}),
    ...(sizeErrorChars !== undefined ? { sizeErrorChars: Math.floor(sizeErrorChars) } : {}),
  };
}

function configureSizeThresholds(config: TracelineConfig | undefined): void {
  const warning = config?.sizeWarningChars ?? SIZE_THRESHOLDS.warning;
  const error = config?.sizeErrorChars ?? SIZE_THRESHOLDS.error;
  sizeThresholds = { warning, error: Math.max(error, warning) };
}

// A fact suffix must carry a fact (design language §9.7): results smaller than one
// line of text render no char suffix — the bullet already says the call completed.
// The floor is block-scoped (§9.7): when the surrounding block's size column is
// live, even a below-floor cell renders — a blank inside a live column is a
// misalignment, not a calm.
const CHAR_SUFFIX_FLOOR = 100;

function charSuffix(chars: number | undefined, columnLive = false): string {
  if (chars === undefined) return "";
  if (chars < CHAR_SUFFIX_FLOOR && !columnLive) return "";
  return ink(currentTheme(), sizeTone(chars, sizeThresholds), `${formatCharCount(chars)} ch`);
}

function resultTextCharCount(comp: ToolRowDataLike | undefined): number | undefined {
  const content = comp?.result?.content;
  if (!Array.isArray(content)) return undefined;
  return content.reduce((sum: number, block: unknown) => {
    if (!block || typeof block !== "object") return sum;
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type === "text" && typeof textBlock.text === "string") return sum + textBlock.text.length;
    return sum;
  }, 0);
}

function resultCharSuffix(comp: ToolRowDataLike | undefined, facts: BlockFacts): string {
  return charSuffix(resultTextCharCount(comp), facts.sizeColumnLive);
}

const MUTATION_VERBS = new Set(["edit", "write"]);

// An edit/write row that carries a filesystem path renders its diff inline on the
// basename (§9.5), the way a read carries its `:line-range`, not as a right-column
// fact. Such a row opts out of the block's size and diff columns (§9.7): it shows no
// size cell (a mutation's result is a confirmation, near-noise) and its suffix stays
// empty, so the magnitude rides the file it changed.
function inlineMutationRow(comp: ToolRowDataLike | undefined): boolean {
  if (!MUTATION_VERBS.has(toolLabel(comp?.toolName))) return false;
  const path = comp?.args?.path ?? comp?.args?.file_path;
  return typeof path === "string" && path.length > 0;
}

// The row's contiguous visual block — the rail-fused run. Boundaries mirror the
// *rendered* rail: tool rows fuse across invisible empty connectors; visible prose
// breaks the block, and so does a collapsed thinking preview — it renders with a
// blank line above it, which breaks the rail and starts a new block. §9.7
// (block-scoped columns), §9.5 (boring-prefix path emphasis) and §9.8 (shared
// cut columns) all scope their facts to this run.
function blockToolRows(comp: ToolRowLike): ToolRowLike[] {
  const found = componentLocation(comp);
  if (!found) return [comp];
  const breaksBlock = (c: unknown) => !isToolRow(c) && !isEmptyConnector(c);
  let start = found.index;
  for (let j = found.index - 1; j >= 0; j--) {
    if (breaksBlock(found.sibs[j])) break;
    start = j;
  }
  const rows: ToolRowLike[] = [];
  for (let j = start; j < found.sibs.length; j++) {
    const c = found.sibs[j];
    if (breaksBlock(c)) break;
    if (isToolRow(c)) rows.push(c);
  }
  return rows.length ? rows : [comp];
}

// The block-scoped facts every row's suffix shares: whether the size column is live
// and the block's diff/size column widths. One pass, computed once per rendered row
// and threaded through the suffix builders — deriving each fact independently walked
// the block again for every fact of every row, making a single row render O(block²)
// in diff parses.
type BlockFacts = { sizeColumnLive: boolean; diffColumns: DiffColumns };

function blockFacts(rows: ToolRowLike[]): BlockFacts {
  // Columns are block-scoped (design language §9.7): the size column lights up for
  // a whole contiguous trace block when any of its completed rows clears the fact
  // floor. An all-tiny block (a `mkdir`/`rm` cleanup run) keeps a clean right edge.
  // Inline-diff mutations (§9.5) carry no right-column fact, so they neither light the
  // size column nor set its width — their magnitude lives on the basename instead.
  const sizeColumnLive = rows.some((c) => {
    if (inlineMutationRow(c)) return false;
    const chars = resultTextCharCount(c);
    if (chars === undefined) return false;
    // Record rows (§9.10) suppress their size cell below warning severity, so only
    // a ballooning record output lights the column.
    if (recordRow(c)) return chars >= sizeThresholds.warning;
    return chars >= CHAR_SUFFIX_FLOOR;
  });
  let plus = 0;
  let minus = 0;
  let size = 0;
  for (const row of rows) {
    if (inlineMutationRow(row)) continue;
    const stats = mutationDiffStats(row);
    if (stats) {
      if (stats.added > 0) plus = Math.max(plus, 1 + String(stats.added).length);
      if (stats.removed > 0) minus = Math.max(minus, 1 + String(stats.removed).length);
    }
    size = Math.max(
      size,
      visibleWidth(recordRow(row) ? recordCharSuffix(row) : charSuffix(resultTextCharCount(row), sizeColumnLive)),
    );
  }
  return { sizeColumnLive, diffColumns: { plus, minus, size } };
}

function blockFactsOf(comp: ToolRowLike): BlockFacts {
  return blockFacts(blockToolRows(comp));
}

function blockSizeColumnLive(comp: ToolRowLike): boolean {
  return blockFactsOf(comp).sizeColumnLive;
}

// Rows in a block share one body budget (design language §9.8): reserve the block's
// widest rendered fact suffix — folded read runs count as their single `N calls · size`
// cell — plus the two-space gap (§9.1), so every truncated row in the block cuts at
// the same columns and its tail ends flush where the suffix column begins.
function blockSuffixReserve(rows: ToolRowLike[], facts: BlockFacts, available: number): number {
  let widest = 0;
  for (const row of rows) {
    const run = readRun(row);
    const suffix = run ? foldedReadSuffix(run.rows, facts) : toolFactSuffix(row, available, facts);
    widest = Math.max(widest, visibleWidth(suffix));
  }
  return widest > 0 ? widest + 2 : 0;
}

const LCS_CELL_LIMIT = 200_000;

type WriteInput = { path: string; content: string; cwd: string };
type WriteSnapshot = WriteInput & { stats: DiffStats | undefined };

// Expects pre-normalized line endings (diffStatsFromContents normalizes once).
function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
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
    // No reset after the swap: index 0 is never written (both arrays start zeroed)
    // and every other cell is overwritten before the next row reads it.
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

function diffStatsFromContents(oldContent: string, newContent: string): DiffStats | undefined {
  const oldNormalized = normalizeLineEndings(oldContent);
  const newNormalized = normalizeLineEndings(newContent);
  if (oldNormalized === newNormalized) return undefined;

  const oldLines = splitDiffLines(oldNormalized);
  const newLines = splitDiffLines(newNormalized);
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

function writeInput(comp: ToolRowDataLike | undefined): WriteInput | undefined {
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

// Only captureWriteSnapshot ever writes the field, always a full WriteSnapshot.
function writeSnapshot(comp: ToolRowDataLike | undefined): WriteSnapshot | undefined {
  return comp?.__tracelineWriteSnapshot as WriteSnapshot | undefined;
}

function sameWriteInput(a: WriteInput | undefined, b: WriteInput | undefined): boolean {
  return !!a && !!b && a.path === b.path && a.cwd === b.cwd && a.content === b.content;
}

function captureWriteSnapshot(comp: ToolRowDataLike): void {
  const input = writeInput(comp);
  if (!input) return;
  const previous = writeSnapshot(comp);
  if (sameWriteInput(previous, input)) return;
  const oldContent = readWriteOldContent(input);
  comp.__tracelineWriteSnapshot = { ...input, stats: diffStatsFromContents(oldContent, input.content) } satisfies WriteSnapshot;
}

function writeDiffStats(comp: ToolRowDataLike | undefined): DiffStats | undefined {
  const input = writeInput(comp);
  const snapshot = writeSnapshot(comp);
  if (!sameWriteInput(snapshot, input)) return undefined;
  return snapshot?.stats;
}

function diffTextFromComp(comp: ToolRowDataLike | undefined): string | undefined {
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

// Parsing a diff is O(its length), and the block's shared fact columns (§9.7) ask
// every row for stats on every frame — so the parse caches per row against the diff
// text's identity. A settled row hits the reference-equality fast path; a streaming
// edit's changing preview text misses and re-parses. The write-snapshot fallback
// stays uncached: it is a handful of reference compares.
const diffTextStatsCache = new WeakMap<object, { text: string; stats: DiffStats | undefined }>();

function mutationDiffStats(comp: ToolRowDataLike): DiffStats | undefined {
  const text = diffTextFromComp(comp);
  if (text === undefined) return writeDiffStats(comp);
  const cached = diffTextStatsCache.get(comp);
  if (cached && cached.text === text) return cached.stats ?? writeDiffStats(comp);
  const stats = diffStatsFromText(text);
  diffTextStatsCache.set(comp, { text, stats });
  return stats ?? writeDiffStats(comp);
}

// Zero sides are dropped (design language §9.7): `+2 -0` → `+2` — the dimmed zero
// was a half-measure, and every new-file write wore a guaranteed-noise `-0`. But the
// drop is ink-only: within a block the diff cells form two right-aligned columns
// (§9.7) — every cell pads left so units sit under units, and a dropped side
// holds its column as blank space — so each column's right edge and the `·` share one
// x down the block. Without column widths (a lone row), a cell pads to itself and
// renders exactly as before.
type DiffColumns = { plus: number; minus: number; size: number };

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

// A file mutation wears its diff inline on the basename (§9.5), the way a read wears
// its `:line-range`: the magnitude rides the file it changed instead of drifting to a
// right column, so no gap opens between the path and how much it moved. add-green /
// remove-red, zero side dropped, per-row (no block sign columns — an inline cell can
// never align down a column of ragged-length paths, and does not try).
function mutationInlineDiffInk(comp: ToolRowDataLike): string {
  const stats = mutationDiffStats(comp);
  if (!stats) return "";
  return ` ${formatMutationDiffStats(stats, currentTheme())}`;
}

// --- records of consequence (design language §9.10) -----------------------------------

// Some bash rows change shared state beyond the working tree — a commit, a push, a PR
// merged or closed, an issue closed, a release or package published. The invocation
// says only what was *attempted*, and truncation may eat even that; the proof is
// porcelain in the result, which one-line mode hides. Such a row graduates to a
// verb-led outcome row (§9.10): the record leads — `pushed main $ git push` — stated
// only from what the output reported: the command must name the operation *and* its
// success porcelain must appear. A failed push after a good commit therefore still
// headlines `committed a4f21c9` on a red row — committed, demonstrably not landed.
// `git tag` earns nothing: its success porcelain is silence.
type RecordTone = "success" | "warning";
type RecordFact = { verb: string; datum: string; at: number; tone: RecordTone; opaque: boolean };

type RecordRule = { gate: RegExp; parse: (out: string) => RecordFact[] };

function factsFrom(
  out: string,
  pattern: RegExp,
  verb: string,
  datum: (m: RegExpMatchArray) => string,
  options: { opaque?: boolean; tone?: (m: RegExpMatchArray) => RecordTone } = {},
): RecordFact[] {
  const facts: RecordFact[] = [];
  for (const m of out.matchAll(pattern))
    facts.push({ verb, datum: datum(m), at: m.index ?? 0, tone: options.tone?.(m) ?? "success", opaque: options.opaque === true });
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
    // The sha is opaque audit data (§9.10): the verb wears the ink, the sha stays dim.
    parse: (out) => factsFrom(out, /^\[[^\n\]]*?([0-9a-f]{7,40})\]/gm, "committed", (m) => m[1]!, { opaque: true }),
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
        // git's `+` flag column is its forced-update porcelain — a riskier real
        // state, so the fact tints warning instead of success (§9.10).
        { tone: (m) => (m[0].trimStart().startsWith("+") ? "warning" : "success") },
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

function resultText(comp: ToolRowDataLike | undefined): string {
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

function recordFacts(comp: ToolRowDataLike): RecordFact[] {
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
// (`pushed main, v0.5.9`) and exact duplicates collapse. Merging also requires the
// tones to agree (§9.10): a forced push never hides inside a routine one.
type RecordCellData = { verb: string; data: string[]; tone: RecordTone; opaque: boolean };

function recordCellData(comp: ToolRowDataLike): RecordCellData[] {
  const merged: RecordCellData[] = [];
  for (const fact of recordFacts(comp)) {
    const last = merged[merged.length - 1];
    if (last && last.verb === fact.verb && last.tone === fact.tone) {
      if (!last.data.includes(fact.datum)) last.data.push(fact.datum);
    } else {
      merged.push({ verb: fact.verb, data: [fact.datum], tone: fact.tone, opaque: fact.opaque });
    }
  }
  return merged;
}

function recordCellText(cell: RecordCellData): string {
  return `${cell.verb} ${cell.data.join(", ")}`;
}

function recordCells(comp: ToolRowDataLike): string[] {
  return recordCellData(comp).map(recordCellText);
}

// Records may take at most roughly a third of the row (§9.10), so the command keeps
// its width: overflow drops whole facts oldest first — terminal state wins, a mangled
// sha is worse than none, and the full output stays one Ctrl+T away.
const RECORD_HEADLINE_SHARE = 1 / 3;

// Records wear the ink of what they state (§9.10): the cell renders bold in its
// fact's tone — success for landed state, warning for a forced push — verb and datum
// as one chunk, because the refname/tag/version/PR number is the event's identity.
// Opaque audit data (a commit sha) stays dim: copy-paste material, not news. The tone
// is per-fact, not per-row: a failed row keeps its surviving facts success-toned —
// red discriminators beside a green `committed` is exactly "committed, demonstrably
// not landed" (§9.10); separators stay at the supporting grey and the size cell
// keeps its severity ink.
function inkRecordCell(cell: RecordCellData): string {
  const theme = currentTheme();
  if (cell.opaque) {
    const verb = ink(theme, cell.tone, `${BOLD}${cell.verb}${BOLD_OFF}`);
    return `${verb}${dim(` ${cell.data.join(", ")}`)}`;
  }
  return ink(theme, cell.tone, `${BOLD}${recordCellText(cell)}${BOLD_OFF}`);
}

// A bash row that landed real shared state graduates to a verb-led outcome row
// (§9.10): the record leads — `pushed main $ git push` — joining the verb-first
// family (read, edit, write, `$`), and the command trails as provenance behind its
// `$`, which keeps its promise that what follows ran in a shell (a record never sits
// between `$` and the command). Records exist only when success porcelain appeared,
// so a row leads with an outcome exactly when there demonstrably was one; a partial
// success on a red row still headlines what landed. The headline survives truncation:
// the middle cut (§9.8) lands in the command, never in the record.
function recordHeadline(comp: ToolRowDataLike, available: number): string {
  const cells = recordCellData(comp);
  if (!cells.length) return "";
  const cap = Math.floor(available * RECORD_HEADLINE_SHARE);
  while (cells.length && cells.map(recordCellText).join(SEP).length > cap) cells.shift();
  return cells.map(inkRecordCell).join(dim(SEP));
}

function recordRow(comp: ToolRowDataLike): boolean {
  return recordCellData(comp).length > 0;
}

// A record row's size cell is suppressed as noise (§9.10/§9.7): its result is
// porcelain about the event, not pulled context. At warning severity (§6) the cell
// re-earns its berth — an output that balloons is a story of its own.
function recordCharSuffix(comp: ToolRowDataLike): string {
  const chars = resultTextCharCount(comp);
  if (chars === undefined || chars < sizeThresholds.warning) return "";
  return charSuffix(chars);
}

function toolFactSuffix(comp: ToolRowLike, available = Number.POSITIVE_INFINITY, facts: BlockFacts = blockFactsOf(comp)): string {
  const theme = currentTheme();
  const parts: string[] = [];
  // Inline-diff mutations (§9.5) spend no right-column ink: the diff rides the
  // basename and the confirmation-size cell is dropped, so the suffix stays empty.
  // Record rows (§9.10) headline their facts on the left and suppress the size cell
  // below warning severity.
  const inline = inlineMutationRow(comp);
  const diff = inline ? undefined : mutationDiffStats(comp);
  const chars = inline ? "" : recordRow(comp) ? recordCharSuffix(comp) : resultCharSuffix(comp, facts);
  if (diff) {
    // The diff cell right-aligns within the block's sign columns, and the size cell
    // pads left to the block's widest, so each diff column's right edge and the `·`
    // hold one x down the block (§9.7).
    const cols = facts.diffColumns;
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

function lineRange(args: ToolArgsLike | undefined): string {
  const rawOffset = args?.offset;
  const rawLimit = args?.limit;
  const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.max(1, Math.floor(rawOffset)) : undefined;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : undefined;
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

// No plain ink in native rows (design language §9.6): every span a native renderer
// leaves unstyled would render at the terminal default — prose ink inside a trace row,
// the §9.3 problem alive on grep/web_search/fetch/mcp rows. Demote such spans to
// L3-dim; spans with a deliberate foreground, and bold/faint-only spans (§9.3's
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
// noise; the full invocation (timeout included) is one Ctrl+T away. Bash rows
// are rebuilt from plain text (see bashInvocationText), so this works on plain text.
function stripTimeoutSuffix(text: string): string {
  return text.replace(/ \(timeout [^)]*\)\s*$/i, "");
}

// --- bash rows: plain-text rebuild + family ink (§2/§9.3/§9.4) ------
// Bash rows speak the exact grammar of path rows: the bold `$` anchors at L0, and the
// head words that survive crown selection (below) render L0-bold the way a basename
// does (`$ rm`, `$ npm`, `$ python3` scan like `read file.ts`; §9.3), while
// everything else — arguments, connectors, redirects, heredoc markers, demoted glue
// commands, and the ↵/⋯ flatten/elision marks — sits at the one L3-dim supporting
// grey shared with directories, plumbing, and size suffixes. Pi's native bash styling
// is deliberately dropped: the invocation *text* still comes from pi's renderer, the
// ink is the family's.

// The rendered bash invocation as plain text: every visible line flattened into one,
// leading bullet and timeout boilerplate dropped. All later transforms (tildify, cd
// elision) stay in plain text; inkBashRow applies the family ink last.
function bashInvocationText(comp: ToolRowDataLike | undefined): string | undefined {
  const call = comp?.callRendererComponent;
  if (!call || typeof call.render !== "function") return undefined;
  const rendered = call.render(ONE_LINE_CAPTURE_WIDTH);
  const lines = Array.isArray(rendered) ? rendered : [];
  const flattened = flattenInvocationLines(lines.map((line: unknown) => stripAnsi(String(line))));
  if (!flattened) return undefined;
  return stripTimeoutSuffix(flattened.replace(/^•\s*/, ""));
}

// Env-var assignments (`FOO=1 npm test`) are not the command; the head scans past them.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Sequencing operators start a new command whose head word is a discriminator
// (§9.4). Pipes and redirects continue a command — `| head -240` is a filter, and
// §9.4's rejection of brightening filters stands — so `|` consumes a pending head
// slot instead of re-arming it. The attached form of the semicolon (`sleep 60; ps`)
// sequences too (§9.4); it is detected on the token, quote-aware, in the walk below.
const BASH_SEQUENCER = /^(?:&&|\|\||;)$/;

// A heredoc marker arms body-inertness (§9.4): from the `↵` that follows `<<TAG`
// until the terminator line, tokens are data — no heads, no re-arms, and no quote
// tracking, so an unbalanced apostrophe in heredoc prose cannot silence the commands
// after the terminator (§9.4). A bare `<<`/`<<-` takes the next token as its tag;
// `<<<` is a here-string, not a heredoc, and matches neither form.
const BASH_HEREDOC_TOKEN = /^<<-?(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))?$/;

// The crown vocabularies (§9.4, measured over a 51k-invocation corpus — see
// scripts/dev/bash-corpus/). Preambles situate (`cd X && …`, `set -e; …`); plumbing
// glues (`|| true`, `&& echo done`); neither is why the row exists, so neither wears
// a crown when a real command in the row does. Closers are the block keywords a
// sequencer exposes (`; do`, `↵ fi`); they pass the crown to the head that follows.
const BASH_PREAMBLE_HEADS = new Set(["cd", "set"]);
const BASH_PLUMBING_HEADS = new Set(["echo", "true", "false", "printf", "exit"]);
const BASH_CLOSERS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "in"]);

type BashHeadClass = "real" | "plumbing" | "preamble";
type BashHead = { start: number; end: number; cls: BashHeadClass };

// One walk over the flattened body collects every command's head candidate (§9.4's
// grammar): tokens scan left to right with quote state carried across
// them (the gaps are whitespace and hold none), sequencers re-arm the pending head
// slot only outside quotes, a token-final unquoted `;` re-arms exactly like the
// space-delimited form, and heredoc bodies are skipped whole. Within an armed slot:
// env assignments are scanned past (§9.4), block closers pass the crown through,
// and a token with no word character (§9.4) or a leading `-` (a flattened
// continuation line's flag, §9.4) renders headless and consumes the slot so a
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
        // Parens are apparatus (§9.4's spirit): `(cd …` and `… || true)` classify
        // and crown on the inner word, so a subshell close cannot smuggle glue past
        // the §9.4 vocabularies and a crown never bolds punctuation.
        const trimmed = endsWithUnquotedSemi ? text.slice(0, -1) : text;
        const open = /^\(+/.exec(trimmed)?.[0].length ?? 0;
        const close = /\)+$/.exec(trimmed)?.[0].length ?? 0;
        const word = trimmed.slice(open, trimmed.length - close);
        const wordStart = match.index + open;
        if (!/[A-Za-z0-9]/.test(word) || word.startsWith("-")) {
          headPending = false; // §9.4: apparatus and flags consume the slot
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

// Crown selection is row-global (§9.4): every real command head is crowned, and
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
// (middleTruncate replays the active ink after a cut, §5, so a long dim run
// survives truncation), and each crowned word takes the discriminator ink (§9.3;
// §9.2's error tint on failed rows). The visible text is untouched.
function inkBashBody(body: string, comp?: ToolRowDataLike): string {
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

function inkBashRow(comp: ToolRowDataLike | undefined, text: string): string {
  if (!text.startsWith("$ ")) return dim(text);
  return `${verbInk(comp, "$")} ${inkBashBody(text.slice(2), comp)}`;
}

function commandPrefixLength(comp: ToolRowDataLike | undefined, line: string): number {
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

function colourCommandPrefix(comp: ToolRowDataLike | undefined, line: string): string {
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
function nativeInvocationLine(comp: ToolRowDataLike | undefined): string | undefined {
  const call = comp?.callRendererComponent;
  if (!call || typeof call.render !== "function") return undefined;
  const rendered = call.render(ONE_LINE_CAPTURE_WIDTH);
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
function fallbackInvocationLine(comp: ToolRowDataLike | undefined): string {
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

function inkedFallbackLine(comp: ToolRowDataLike | undefined): string {
  const body = tildify(fallbackInvocationLine(comp));
  const verb = toolLabel(comp?.toolName);
  if (body === verb) return verbInk(comp, verb);
  if (body.startsWith(`${verb} `)) {
    // Argument text at the one supporting grey (§9.3), matching bash argument ink.
    return `${verbInk(comp, verb)} ${dim(body.slice(verb.length + 1))}`;
  }
  return dim(body);
}

// Emphasis for plain file reads, edits, and writes (design language §9.5): dim the
// directory so the basename (which file) stands out, and keep the read :line-range in
// pi's warning/yellow treatment so scoped reads pop. Applied only when the native row
// is a bare `<verb> <path>[:range]`; rows with extra native decoration (resource /
// [skill] labels, inline diff hints) keep pi's own rendering.
const PATH_VERBS = new Set(["read", "edit", "write"]);

function toolPathArg(c: ToolRowDataLike): string | undefined {
  if (!PATH_VERBS.has(toolLabel(c?.toolName))) return undefined;
  const path = c?.args?.path ?? c?.args?.file_path;
  return typeof path === "string" && path.length > 0 ? cwdRelativePath(c, path) : undefined;
}

// cwd collapses to `./` (design language §9.5): a path under the row's cwd renders
// as the shell's own notation for "here" — two columns instead of thirty. Paths
// outside cwd keep their tildified absolute form; the asymmetry is the information.
function cwdRelativePath(comp: ToolRowDataLike | undefined, rawPath: string): string {
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

// Dim the boring prefix, not the directory (design language §9.5): the dim zone is
// the longest of the block's common directory prefix (when at least two meaningful
// segments deep — a shared bare `/` or `~/` carries no information) and the row's
// cwd prefix (session-ambient context is boring by default). Everything past it —
// divergent directories included — is the discriminator. Falls back to the whole
// directory, i.e. the classic basename-only emphasis.
function boringPrefix(comp: ToolRowLike, tildePath: string): string {
  const dir = tildePath.slice(0, tildePath.lastIndexOf("/") + 1);
  const candidates: string[] = [];
  const blockPaths = blockToolRows(comp)
    .map(toolPathArg)
    .filter((p): p is string => p !== undefined);
  const common = commonDirSegments(blockPaths.length ? blockPaths : [tildePath]);
  // `./` counts like `~` (§9.5): alone it is a trivial root marker, but `./src/`
  // is a meaningful shared prefix. Either way it is always boring on its own.
  if (common.filter((s) => s !== "").length >= 2) {
    const prefix = `${common.join("/")}/`;
    if (tildePath.startsWith(prefix)) candidates.push(prefix);
  }
  if (tildePath.startsWith("./")) candidates.push("./");
  const boring = candidates.sort((a, b) => b.length - a.length)[0];
  return boring !== undefined && boring.length <= dir.length ? boring : dir;
}

function pathEmphasisLine(comp: ToolRowLike, nativeColored: string): string | undefined {
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
  // The basename carries one inline qualifier (§9.5): a read's warning `:line-range`,
  // or an edit/write's `+N -M` diff. Both survive truncation as the protected tail.
  const qualifier =
    verb === "read" ? ink(theme, "warning", lineRange(comp?.args)) : mutationInlineDiffInk(comp);
  return `${verbInk(comp, verb)} ${dim(boring)}${discriminatorInk(comp, tail)}${qualifier}`;
}

// The invocation body with family ink applied: bash rows rebuild from plain text, path
// rows get the dim-directory emphasis, everything else keeps pi's native line with a
// re-inked verb; tools without a renderer fall back to a plain verb+args line.
function invocationInk(comp: ToolRowLike, available = Number.POSITIVE_INFINITY): string {
  if (toolLabel(comp?.toolName) === "bash") {
    const plain = bashInvocationText(comp);
    if (plain === undefined) return inkedFallbackLine(comp);
    const body = inkBashRow(comp, foldBashPreamble(comp, tildify(plain)));
    const headline = recordHeadline(comp, available);
    return headline ? `${headline} ${body}` : body;
  }
  const native = nativeInvocationLine(comp);
  const base = (native && pathEmphasisLine(comp, native)) ?? native;
  return base ? tildify(base) : inkedFallbackLine(comp);
}

// The body+suffix budget inside the two-sided inset (§9.1): what remains after the
// rail prefix and the right margin.
function traceRowAvailable(width: number): number {
  return Math.max(1, Math.max(1, width) - TOOL_PREFIX_VISIBLE_WIDTH - TOOL_RIGHT_MARGIN);
}

// The one row form shared by single rows and folded read runs: body left, the block's
// reserved fact-suffix column right (§9.8/§9.1), behind the railed status prefix.
function fitTraceRow(tone: Tone, body: string, suffix: string, reserve: number, width: number): string {
  const fitted = rightAlignSuffix(body, suffix, traceRowAvailable(width), currentTheme(), reserve);
  return truncateToWidth(`${toolPrefix(tone)}${fitted}`, Math.max(1, width), ELLIPSIS);
}

function oneLine(comp: ToolRowLike, width: number): string {
  if (toolLabel(comp?.toolName) === "write" && !comp?.result) {
    try {
      captureWriteSnapshot(comp);
    } catch {
      /* keep one-line rendering best-effort */
    }
  }
  const rows = blockToolRows(comp);
  const facts = blockFacts(rows);
  const available = traceRowAvailable(width);
  return fitTraceRow(
    statusTone(comp),
    invocationInk(comp, available),
    toolFactSuffix(comp, available, facts),
    blockSuffixReserve(rows, facts, available),
    width,
  );
}

// --- repetition folding + preamble reclaim (issue #14, design language §9.4/§9.9) ---

// A demoted preamble still spends width: dim ink alone leaves `set -euo pipefail ↵ cd
// <dir> ↵` eating two-thirds of a row, and the shared truncation budget (§9.8) then
// cuts the real command behind it. So a bash row's *leading preamble run* — the opening
// sequence of situating segments (`set -…` hygiene, `cd <dir>`, bare `VAR=…`/`export`
// assignments) across `&&`, `;` and `↵` breaks — is reclaimed, not just dimmed: the
// `set -…` hygiene drops like the `(timeout Ns)` suffix, and the `cd`/assignment context
// folds to a dim `⋯` when it repeats the previous bash row's (§9.4).

// Top-level segments of a flattened bash body, split on `&&`/`||`/`;`/`↵` outside
// quotes, command substitutions and backticks. Only the leading preamble run is read
// (the walk stops at the first real command), so heredoc bodies — which live only in
// real segments — need no handling here.
function bashTopLevelSegments(body: string): { start: number; text: string }[] {
  const segs: { start: number; text: string }[] = [];
  let quote: "'" | '"' | undefined;
  let paren = 0;
  let backtick = false;
  let segStart = 0;
  const push = (end: number) => {
    const raw = body.slice(segStart, end);
    const lead = raw.length - raw.replace(/^\s+/, "").length;
    const text = raw.trim();
    if (text.length > 0) segs.push({ start: segStart + lead, text });
  };
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') quote = undefined;
      i++;
      continue;
    }
    if (backtick) {
      if (ch === "`") backtick = false;
      i++;
      continue;
    }
    if (ch === "'") { quote = "'"; i++; continue; }
    if (ch === '"') { quote = '"'; i++; continue; }
    if (ch === "`") { backtick = true; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "(") { paren++; i++; continue; }
    if (ch === ")") { if (paren > 0) paren--; i++; continue; }
    if (paren === 0) {
      if (body.startsWith("&&", i) || body.startsWith("||", i)) { push(i); i += 2; segStart = i; continue; }
      if (ch === ";" || ch === LINE_BREAK_MARK) { push(i); i += 1; segStart = i; continue; }
    }
    i++;
  }
  push(body.length);
  return segs;
}

// One env-assignment-only segment (`WORK=$(cat x)`, `A=1 B=2`) is setup, not a command,
// so it situates; `FOO=bar cmd` is the command `cmd` and does not. Consumes each
// `VAR=value` token quote/substitution-aware, then checks nothing but assignments remain.
function isEnvAssignmentOnly(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) return true;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(text.slice(i))) return false;
    let quote: "'" | '"' | undefined;
    let paren = 0;
    let backtick = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (quote === "'") { if (ch === "'") quote = undefined; i++; continue; }
      if (quote === '"') { if (ch === "\\") { i += 2; continue; } if (ch === '"') quote = undefined; i++; continue; }
      if (backtick) { if (ch === "`") backtick = false; i++; continue; }
      if (ch === "'") { quote = "'"; i++; continue; }
      if (ch === '"') { quote = '"'; i++; continue; }
      if (ch === "`") { backtick = true; i++; continue; }
      if (ch === "\\") { i += 2; continue; }
      if (ch === "(") { paren++; i++; continue; }
      if (ch === ")") { if (paren > 0) paren--; i++; continue; }
      if (paren === 0 && /\s/.test(ch)) break;
      i++;
    }
  }
  return true;
}

type BashSegmentClass = "hygiene" | "context" | "real";

// `set -…` is hygiene (drop-always); `cd`, `export …` and bare assignments situate
// (fold-on-repeat); everything else is the reason the row exists and stops the run.
function classifyBashSegment(text: string): BashSegmentClass {
  if (/^set(\s|$)/.test(text)) return "hygiene";
  if (/^cd(\s|$)/.test(text)) return "context";
  if (/^export\s+[A-Za-z_]/.test(text)) return "context";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return isEnvAssignmentOnly(text) ? "context" : "real";
  return "real";
}

type BashPreambleRun = {
  contextText: string; // situating context, joined; "" when the run has none
  firstRealStart?: number; // body index of the first real command, if any
  dropStart?: number; // body index just past a leading `set -…` run, when a drop applies
};

// The leading preamble run of a flattened bash body. contextText compares context
// across rows (both computed from tildified bodies, so `cd ~/x` matches `cd ~/x`);
// firstRealStart is where the `⋯` fold would point; dropStart marks where a leading
// `set -…` run ends. dropStart stays undefined when the whole body is hygiene, so a
// `set -e`-only row keeps its head and no row goes dark (§9.4).
function bashPreambleRun(body: string): BashPreambleRun {
  const contextParts: string[] = [];
  let firstRealStart: number | undefined;
  let dropStart: number | undefined;
  for (const seg of bashTopLevelSegments(body)) {
    const cls = classifyBashSegment(seg.text);
    if (cls === "real") {
      firstRealStart = seg.start;
      if (dropStart === undefined) dropStart = seg.start;
      break;
    }
    if (cls === "context") {
      contextParts.push(seg.text);
      if (dropStart === undefined) dropStart = seg.start;
    }
    // a leading hygiene (`set`) segment leaves dropStart pointing just past it
  }
  return { contextText: contextParts.join("\n"), firstRealStart, dropStart };
}

// The previous bash row within the same visual group: reads and other tools interleave
// freely, but visible prose opens a new paragraph — a `⋯` must never point across one.
function previousBashRow(comp: ToolRowDataLike): ToolRowLike | undefined {
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

// The preamble run of a rendered bash comp, read from the same tildified body the row
// shows, so context keys compare like-for-like across rows.
function bashPreambleRunOf(comp: ToolRowDataLike | undefined): BashPreambleRun | undefined {
  if (!comp || toolLabel(comp?.toolName) !== "bash") return undefined;
  const plain = bashInvocationText(comp);
  if (plain === undefined || !plain.startsWith("$ ")) return undefined;
  return bashPreambleRun(tildify(plain).slice(2));
}

// Reclaim the leading preamble of a `$ …` line (§9.4): fold the situating context to a
// dim `⋯` when it repeats the previous bash row's, else drop a leading `set -…` run.
// Operates on plain text (see bashInvocationText); inkBashBody later dims the `⋯` and
// the surviving `cd`/assignment context with the rest of the shell apparatus.
function foldBashPreamble(comp: ToolRowDataLike, line: string): string {
  if (!line.startsWith("$ ")) return line;
  const body = line.slice(2);
  const run = bashPreambleRun(body);
  // A: the context folds only when a real command follows it (a `⋯` must point at
  // something) and it repeats the previous bash row's — the `⋯` absorbs the whole run
  // and its trailing separator.
  if (run.firstRealStart !== undefined && run.contextText !== "") {
    const prev = bashPreambleRunOf(previousBashRow(comp));
    if (prev && prev.contextText === run.contextText) {
      return `$ ${PREAMBLE_MARK} ${body.slice(run.firstRealStart)}`;
    }
  }
  // B: otherwise drop a leading `set -…` hygiene run outright (dropStart > 0 means a
  // set ran ahead of surviving context or a real command).
  if (run.dropStart !== undefined && run.dropStart > 0) {
    return `$ ${body.slice(run.dropStart)}`;
  }
  return line;
}

// Consecutive reads paging through one file (read → truncation notice → read with offset)
// differ only in the range; fold the run into one row —
// `read path:1-200,201-400 · 2 calls` with the combined result size — carried by the
// run's first row while the later rows render nothing. Runs are broken by anything
// visible between the reads (prose, a collapsed Thinking… line, another tool), so the
// fold never reorders what the transcript shows; Ctrl+T's native view restores the
// individual rows.
function readPath(comp: ToolRowDataLike): string | undefined {
  if (toolLabel(comp?.toolName) !== "read") return undefined;
  const path = comp?.args?.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

// A read row that may participate in a fold: error rows never fold — a failed page must
// keep its own red row, not vanish into a folded one whose tone reflects only the last
// call. An error therefore also breaks the run on both sides.
function foldableReadPath(comp: ToolRowDataLike): string | undefined {
  const path = readPath(comp);
  if (path === undefined) return undefined;
  return toolStatus(comp) === "error" ? undefined : path;
}

function readRun(comp: ToolRowLike): { rows: ToolRowLike[]; index: number } | undefined {
  const path = foldableReadPath(comp);
  if (path === undefined) return undefined;
  const found = componentLocation(comp);
  if (!found) return undefined;
  const { sibs, index } = found;
  const rows: ToolRowLike[] = [comp];
  let selfIndex = 0;
  for (let j = index - 1; j >= 0; j--) {
    const prev = sibs[j];
    if (isEmptyConnector(prev)) continue;
    if (!isToolRow(prev) || foldableReadPath(prev) !== path) break;
    rows.unshift(prev);
    selfIndex++;
  }
  for (let j = index + 1; j < sibs.length; j++) {
    const next = sibs[j];
    if (isEmptyConnector(next)) continue;
    if (!isToolRow(next) || foldableReadPath(next) !== path) break;
    rows.push(next);
  }
  return rows.length > 1 ? { rows, index: selfIndex } : undefined;
}

function foldedReadSuffix(rows: ToolRowDataLike[], facts: BlockFacts): string {
  let total: number | undefined;
  for (const row of rows) {
    const chars = resultTextCharCount(row);
    if (chars !== undefined) total = (total ?? 0) + chars;
  }
  const calls = `${rows.length} calls`;
  const sizeCell = charSuffix(total, facts.sizeColumnLive);
  return total === undefined || !sizeCell ? dim(calls) : `${dim(`${calls}${SEP}`)}${sizeCell}`;
}

function foldedReadLine(rows: ToolRowLike[], width: number): string {
  const theme = currentTheme();
  const last = rows[rows.length - 1];
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
  const blockRows = blockToolRows(last);
  const facts = blockFacts(blockRows);
  return fitTraceRow(
    statusTone(last),
    body,
    foldedReadSuffix(rows, facts),
    blockSuffixReserve(blockRows, facts, traceRowAvailable(width)),
    width,
  );
}

// An assistant turn that renders nothing (a tool-call-only turn with no visible
// text/thinking) — these sit *between* sequential tool rows and must be skipped so a
// run of tool calls groups tightly.
function isEmptyConnector(c: unknown): boolean {
  if (!isAssistantRow(c)) return false;
  const content = c.lastMessage?.content;
  if (!Array.isArray(content)) return true;
  return !content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
    return (b.type === "text" && typeof b.text === "string" && b.text.trim()) ||
      (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim());
  });
}

function componentLocation(comp: ToolRowDataLike): { sibs: unknown[]; index: number } | undefined {
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
function isCollapsedThinkingRow(c: unknown): boolean {
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
function leadingBlank(comp: ToolRowDataLike): boolean {
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
function renderTraceRow(comp: ToolRowLike, width: number): string[] {
  const run = readRun(comp);
  if (run) {
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

function nativeHiddenThinkingLabel(comp: AssistantRowDataLike): string {
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

function thinkingPreviewLines(comp: AssistantRowDataLike): string[] {
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

function dedupeThinkingLabels(comp: AssistantRowDataLike, lines: string[], width?: number): string[] {
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

function patchAssistantRowPrototype(proto: AssistantRowPrototypeLike): void {
  if (!proto || typeof proto.render !== "function") return;
  if (proto.__tracelineAssistantPatchVersion === TRACELINE_ASSISTANT_PATCH_VERSION) return;
  const original = proto.__tracelineOriginalAssistantRender ?? proto.render;
  proto.__tracelineOriginalAssistantRender = original;
  proto.render = function (this: AssistantRowDataLike, width: number) {
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
  return g.__tracelinePatchVersion === TRACELINE_PATCH_VERSION;
}

// The write pre-image is captured at three seams, deduped by sameWriteInput: on
// setArgsComplete (streamed args settle — the earliest safe point), on
// markExecutionStarted (the last hook before the tool replaces the file), and at
// render time in oneLine for a row that streamed in before this patch landed — the
// session's first write is what installs the prototype patch, from its own
// requestRender tick.
function patchWriteSnapshotHooks(proto: ToolRowPrototypeLike): void {
  if (!proto || proto.__tracelineWriteSnapshotPatchVersion === TRACELINE_PATCH_VERSION) return;

  const originalSetArgsComplete = proto.__tracelineOriginalSetArgsComplete ?? proto.setArgsComplete;
  if (typeof originalSetArgsComplete === "function") {
    proto.__tracelineOriginalSetArgsComplete = originalSetArgsComplete;
    proto.setArgsComplete = function (this: ToolRowDataLike, ...args: unknown[]) {
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
    proto.markExecutionStarted = function (this: ToolRowDataLike, ...args: unknown[]) {
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

function patchToolRowPrototype(proto: ToolRowPrototypeLike): void {
  if (currentPatchInstalled() || !proto || typeof proto.render !== "function") return;
  patchWriteSnapshotHooks(proto);
  const original = proto.__tracelineOriginalRender ?? proto.render;
  proto.__tracelineOriginalRender = original;
  proto.render = function (this: ToolRowLike, width: number) {
    // One guard, one policy: any failure on traceline's path falls back to the
    // native render — never let pi-traceline break a render.
    try {
      if (displayMode() === "native") return original.call(this, width);
      return renderTraceRow(this, width);
    } catch {
      return original.call(this, width);
    }
  };
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
// (see docs/testing.md) and is not a stable public API. An entry stays only while
// a test or dev script actually uses it.
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
  bashCrownedHeads,
  inkBashBody,
  inkBashRow,
  flattenInvocationLines,
  // row grammar
  formatCharCount,
  charSuffix,
  diffStatsFromText,
  diffStatsFromContents,
  captureWriteSnapshot,
  writeDiffStats,
  mutationDiffStats,
  toolFactSuffix,
  recordCells,
  recordHeadline,
  configureSizeThresholds,
  lineRange,
  toolStatus,
  blockSizeColumnLive,
  boringPrefix,
  cwdRelativePath,
  oneLine,
  leadingBlank,
  renderTraceRow,
  // repetition folding + preamble reclaim + thinking-label preview/dedupe (issue #14)
  bashPreambleRun,
  bashPreambleRunOf,
  foldBashPreamble,
  previousBashRow,
  readRun,
  dedupeThinkingLabels,
  // typed test/dev accessors for traceline's Pi seam globals
  setTracelineChat,
  getTracelineChat,
  setTracelineThemeGetter,
  // Ctrl+T status-line suppression
  isThinkingToggleStatusRow,
  isSpacerRow,
  suppressThinkingToggleStatus,
};

export default function piTraceline(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Capture the real TUI (passed synchronously to the widget factory), then patch only
    // extension-visible seams: requestRender for delayed tool-row patching, and raw
    // terminal input for Ctrl+T key-release/repeat handling.
    g.__tracelineGetTheme = () => {
      try {
        return (ctx.ui as ExtensionUiWithTheme).theme;
      } catch {
        return undefined;
      }
    };
    const config = Object.assign(
      {},
      ...configPaths("pi-traceline", process.cwd()).map(
        (path) => readJsonConfig(path, parseTracelineConfig) ?? {},
      ),
    );
    configureSizeThresholds(config);
    captureTui(ctx.ui, "__pi_traceline_capture", (tui) => {
      const t = tui as TracelineTuiLike;
      g.__tracelineTui = t;
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
