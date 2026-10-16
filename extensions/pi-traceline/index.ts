import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { captureTui } from "../_lib/capture.ts";
import {
  findChatContainer,
  isAssistantRow,
  isToolRow,
  type AssistantRowPrototypeLike,
  type ContainerLike,
  resultTextCharCount as rawResultTextCharCount,
  type ToolRowDataLike,
  type ToolRowLike,
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
  suffixBodyWidth,
  tildify,
  type SizeThresholds,
  type Tone,
} from "../_lib/style.ts";
import {
  LINE_BREAK_MARK,
  PREAMBLE_MARK,
  bashPreambleRun,
  bashTopLevelSegments,
  loneCdTarget,
  relativizeContextCd,
  type BashPreambleRun,
} from "./bash-preamble.ts";
import { checkFacts, checkFailed } from "./checks.ts";
import { failureFact, failureFactWidth } from "./failure.ts";
import { fitHeadline, mergeHeadlineFacts, recordCellText, type RecordCellData } from "./headline.ts";
import { fitBashLines, inkBashBody as inkBashBodyWithTone, type BashLines } from "./bash-lines.ts";
import { bashCrownedHeads } from "./bash-crowns.ts";
import {
  drillDecorateNativeRow,
  drillRenderKey,
  drillTracePrefix,
  enterDrillMode,
  exitDrillMode,
  type DrillHost,
} from "./drill.ts";
import { handleDrillTerminalInput } from "./drill-input.ts";
import { resultImageFact as rawResultImageFact } from "./image-fact.ts";
import { isRevealed, ledgerOverride, resetRevealedFolds, revealRenderKey, revealedBullet, type LedgerView, type TraceMousePrototype } from "./click.ts";
import {
  cachedIntrinsic,
  installAssistantCacheHook,
  installCachedTraceMouse,
  installContainerCacheHooks,
  objectCacheKey,
} from "./cache-hooks.ts";
import { clearNestedCaptures, composedFactsOf, recordNestedEnd, recordNestedStart } from "./nested-calls.ts";
import { ledgerEntries, ledgerLines } from "./ledger.ts";
import { composedBody } from "./nested-rows.ts";
import { commonDirSegments, compactReadDisplay, cwdRelativePath, lineRange, readDirKey } from "./path-rows.ts";
import { recordFacts, resultText } from "./records.ts";
import { wrapReadCells } from "./read-fold.ts";
import { TraceRenderCache } from "./render-cache.ts";
import { adjacentReadGroups, combinedResultChars, groupedReadRun, groupedRepetitionRun, readPlan, repetitionPlan } from "./repetition-fold.ts";
import { TraceTopology, isEmptyConnector, isCollapsedThinkingRow, isExpandedToolRow } from "./topology.ts";
import {
  captureWriteCallSnapshot,
  clearWriteCallSnapshots,
  diffStatsFromContents,
  diffStatsFromText,
  mutationDiffStats as rawMutationDiffStats,
  writeDiffStats,
  type DiffStats,
} from "./write-diff.ts";
import { installThinkingPreviews } from "./thinking-preview.ts";
import { captureCallLines } from "./call-capture.ts";
import { summarizeCallLines } from "./call-summary.ts";
import { handleThinkingToggleTerminalInput } from "./thinking-toggle.ts";
import { suppressThinkingToggleStatus } from "./status-line.ts";
import { dimUnstyledSpans, stripSgrBackgrounds, stripSgrForegrounds } from "./sgr.ts";
import { createTracelineTuiOwner } from "./tui-owner.ts";
import { DEFAULT_LEDGER_POLICY, parseTracelineConfig, type LedgerPolicy, type TracelineConfig } from "./traceline-config.ts";

/** Compact trace rendering; see docs/design-language.md §9. */

type ToolDisplayMode = "native" | "oneLine";

type TracelineGlobal = typeof globalThis & {
  __tracelinePatchVersion?: number;
  __tracelineTui?: TUI;
  __tracelineChat?: ContainerLike;
  __tracelineGetTheme?: () => Theme | undefined;
  __tracelineAssistantPatchVersion?: number;
  __tracelineRenderCache?: TraceRenderCache;
};
const g = globalThis as TracelineGlobal;
const renderCache = g.__tracelineRenderCache ??= new TraceRenderCache();
const topology = new TraceTopology(renderCache);
function topologyChanged(): void { if (g.__tracelineChat) topology.changed(g.__tracelineChat); }
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
const TOOL_ROW_PATCH_VERSION = 30;
const ASSISTANT_ROW_PATCH_VERSION = 8;

// --- theme-derived ink (design language §3) --------------------------------------------
// Before session_start (and in unit tests without a UI), ink falls back to basic ANSI.

function currentTheme(): Theme | undefined {
  return g.__tracelineGetTheme?.();
}

function dim(text: string): string {
  return ink(currentTheme(), "dim", text);
}

const resultTextCharCount = cachedIntrinsic(renderCache, "result-chars", rawResultTextCharCount);
const resultImageFact = cachedIntrinsic(renderCache, "image-fact", rawResultImageFact);
const mutationDiffStats = cachedIntrinsic(renderCache, "mutation-diff", rawMutationDiffStats);
// Composed-call facts (§9.14) re-derive whenever the row's result changes: the streamed
// ledger and a live capture both land through updateResult, which dirties the row.
const composedFacts = cachedIntrinsic(renderCache, "composed", composedFactsOf);
// The failure fact (§9.2.1): why a failed call failed, read from the result it returned.
const rowFailureFact = cachedIntrinsic(renderCache, "failure", (row) => {
  if (!row.result?.isError) return undefined;
  const command = row.args?.command;
  return failureFact(toolLabel(row.toolName), resultText(row), typeof command === "string" ? command : undefined);
});
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
  chatChildren();
  const chat = g.__tracelineChat;
  return chat ? topology.prepare(chat).lastAssistant?.hideThinkingBlock ?? false : false;
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

function toolStatus(comp: ToolRowDataLike | undefined): ToolStatus {
  if (comp?.result?.isError) return "error";
  if (comp?.result && comp?.isPartial !== true) return "success";
  return "running";
}

// A row that exited 0 while its output reports a failed check (§9.2, §9.10.1) wears a
// warning bullet: `npm test | tail -5` returns tail's status, not the tests'.
function statusTone(comp: ToolRowDataLike | undefined): Tone {
  const status = toolStatus(comp);
  if (status === "error") return "error";
  if (status === "success") return comp && checkFailed(comp) ? "warning" : "success";
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
// While drill mode is active (§9.13), a numbered row swaps the rail cell for its
// right-aligned number at identical width, so numbering never reflows the transcript.
function toolPrefix(tone: Tone, comp?: ToolRowDataLike, disclosure?: string): string {
  const bullet = ink(currentTheme(), tone, disclosure ?? revealedBullet(comp) ?? TOOL_BULLET);
  return (
    drillTracePrefix(currentTheme(), comp, bullet) ??
    `${TOOL_INDENT}${dim(TOOL_RAIL)} ${bullet}${TOOL_AFTER_BULLET}`
  );
}

function formatCharCount(value: number): string {
  return compactCount(Math.max(0, Math.floor(value)));
}

// Severity thresholds (design language §6): dim while healthy, warning/error when an
// output balloons. Overridable via the family config convention
// (~/.pi/agent/pi-traceline.json / <cwd>/.pi/pi-traceline.json).
let sizeThresholds: SizeThresholds = SIZE_THRESHOLDS;

// The ledger is the trace (§9.14): a composed row reveals its ledger by default unless
// it would run past the cap even after folding. Both knobs live in the family config.
let ledgerPolicy: LedgerPolicy = DEFAULT_LEDGER_POLICY;

function configureSizeThresholds(config: TracelineConfig | undefined): void {
  renderCache.reset();
  const warning = config?.sizeWarningChars ?? SIZE_THRESHOLDS.warning;
  const error = config?.sizeErrorChars ?? SIZE_THRESHOLDS.error;
  sizeThresholds = { warning, error: Math.max(error, warning) };
  ledgerPolicy = {
    reveal: config?.revealLedgers ?? DEFAULT_LEDGER_POLICY.reveal,
    maxLines: config?.ledgerMaxLines ?? DEFAULT_LEDGER_POLICY.maxLines,
  };
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

// The image what-fact (§9.7, image-fact.ts): dim, never lighting the size column.
function imageFactCell(comp: ToolRowDataLike | undefined): string {
  const fact = resultImageFact(comp);
  return fact ? dim(fact) : "";
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
  if (renderCache.active && g.__tracelineChat) return topology.block(g.__tracelineChat, comp);
  const found = componentLocation(comp);
  if (!found) return [comp];
  const breaks = (row: unknown) => isToolRow(row) ? row.expanded === true : !isEmptyConnector(row);
  let start = found.index;
  while (start > 0 && !breaks(found.sibs[start - 1])) start--;
  const rows: ToolRowLike[] = [];
  for (let i = start; i < found.sibs.length && !breaks(found.sibs[i]); i++) {
    const row = found.sibs[i];
    if (isToolRow(row)) rows.push(row);
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
  return renderCache.memo(rows, `facts:${objectCacheKey(currentTheme())}`, () => {
    for (const row of rows) renderCache.depend(row);
    // Columns are block-scoped (design language §9.7): the size column lights up for
    // a whole contiguous trace block when any of its completed rows clears the fact
    // floor. An all-tiny block (a `mkdir`/`rm` cleanup run) keeps a clean right edge.
    // Inline-diff mutations (§9.5) carry no right-column fact, so they neither light the
    // size column nor set its width — their magnitude lives on the basename instead.
    const sizeColumnLive = rows.some((c) => {
      if (inlineMutationRow(c)) return false;
      if (composedFacts(c)?.trimmed) return true; // a trimmed output is warning severity (§9.14)
      const chars = resultTextCharCount(c);
      if (chars === undefined) return false;
      // Record rows (§9.10) and failed rows (§9.2.1) suppress their size cell below
      // warning severity, so only a ballooning output lights the column.
      if (recordRow(c) || rowFailureFact(c)) return chars >= sizeThresholds.warning;
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
      size = Math.max(size, visibleWidth(sizeBerthCell(row, sizeColumnLive)));
    }
    return { sizeColumnLive, diffColumns: { plus, minus, size } };
  });
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
  return renderCache.memo(rows, `reserve:${available}:${objectCacheKey(currentTheme())}`, () => {
    facts = renderCache.active ? blockFacts(rows) : facts;
    let widest = 0;
    const seen = new Set<ToolRowLike[]>();
    for (const row of rows) {
      const read = readRun(row);
      const repeated = read ? undefined : repetitionRun(row);
      const group = read?.rows ?? repeated?.rows;
      if (group && seen.has(group)) continue;
      if (group) seen.add(group);
      const suffix = read
        ? foldedReadSuffix(read.rows, facts)
        : repeated
          ? foldedRepetitionSuffix(repeated.rows, facts, available)
          : toolFactSuffix(row, available, facts);
      widest = Math.max(widest, visibleWidth(suffix));
    }
    return widest > 0 ? widest + 2 : 0;
  });
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

function recordCellData(comp: ToolRowDataLike): RecordCellData[] {
  return renderCache.memo(comp, "records", () => mergeHeadlineFacts(recordFacts(comp), checkFacts(comp)));
}

function recordCells(comp: ToolRowDataLike): string[] {
  return recordCellData(comp).map(recordCellText);
}

function recordHeadline(comp: ToolRowDataLike, available: number): string {
  return fitHeadline(currentTheme(), recordCellData(comp), available);
}

// Only records of consequence suppress the size cell (§9.7); a check row keeps it,
// because test output is pulled context (§9.10.1).
function recordRow(comp: ToolRowDataLike): boolean {
  return recordFacts(comp).length > 0;
}

// A record row's size cell is suppressed as noise (§9.10/§9.7): its result is
// porcelain about the event, not pulled context. At warning severity (§6) the cell
// re-earns its berth — an output that balloons is a story of its own.
function recordCharSuffix(comp: ToolRowDataLike): string {
  const chars = resultTextCharCount(comp);
  if (chars === undefined || chars < sizeThresholds.warning) return "";
  return charSuffix(chars);
}

// A failed row's failure fact cell (§9.2.1): error ink; free text middle-cut to its
// share of the row so one verbose error cannot push the block's bodies aside.
function failureCell(comp: ToolRowDataLike | undefined, available: number): string {
  const fact = rowFailureFact(comp);
  if (!fact) return "";
  const theme = currentTheme();
  const inked = ink(theme, "error", fact.text);
  return fact.parsed ? inked : middleTruncate(inked, failureFactWidth(available), theme);
}

// The row's size-berth cell: a record's or a failed row's suppressed cell (§9.10,
// §9.2.1), an image what-fact, or the char count; a composed call's `trimmed` fact
// rides ahead of it (§9.14).
function sizeBerthCell(comp: ToolRowDataLike, sizeColumnLive: boolean): string {
  const base = recordRow(comp) || rowFailureFact(comp) ? recordCharSuffix(comp) : imageFactCell(comp) || charSuffix(resultTextCharCount(comp), sizeColumnLive);
  if (!composedFacts(comp)?.trimmed) return base;
  const trimmed = ink(currentTheme(), "warning", "trimmed");
  return base ? `${trimmed}${dim(SEP)}${base}` : trimmed;
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
  const chars = inline ? "" : sizeBerthCell(comp, facts.sizeColumnLive);
  // A failed row leads its facts with why (§9.2.1).
  const failure = failureCell(comp, available);
  if (failure) parts.push(failure);
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

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value ?? "");
  }
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
  return comp ? renderCache.memo(comp, "bash-invocation", () => {
    const lines = captureCallLines(comp.callRendererComponent, comp.args);
    if (!lines) return undefined;
    const flattened = flattenInvocationLines(lines.map((line) => stripAnsi(line)));
    return flattened ? stripTimeoutSuffix(flattened.replace(/^•\s*/, "")) : undefined;
  }) : undefined;
}

// Crowns bold in the row's discriminator tone, everything else dim (§9.3; §9.2's error
// tint on failed rows). The fitting and ink live in bash-lines.ts, shared with the ledger.
function inkBashBody(body: string, comp?: ToolRowDataLike): string {
  return inkBashBodyWithTone(currentTheme(), verbTone(comp), body);
}

// A bash row's body laid out against its budget (§9.8): whole, fitted by command, or,
// when `contBudget` is given and the fit would starve a command, wrapped at command
// boundaries onto continuation lines at the command column.
function bashRowLines(comp: ToolRowDataLike | undefined, text: string, budget = Number.POSITIVE_INFINITY, contBudget?: number): BashLines {
  if (!text.startsWith("$ ")) return { first: dim(text), continuations: [] };
  const lines = fitBashLines(currentTheme(), verbTone(comp), text.slice(2), budget - 2, contBudget);
  return { first: `${verbInk(comp, "$")} ${lines.first}`, continuations: lines.continuations };
}

function inkBashRow(comp: ToolRowDataLike | undefined, text: string, budget = Number.POSITIVE_INFINITY): string {
  return bashRowLines(comp, text, budget).first;
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

// Borrow the complete native call grammar, including continuation lines (§9.6), but a
// path row is Pi's header alone: the diff or file preview under it is content (§9.5).
// Results stay separate. Re-ink the verb neutral bold (error rows error).
function nativeInvocationLine(comp: ToolRowLike): string | undefined {
  return renderCache.memo(comp, `native-invocation:${objectCacheKey(currentTheme())}`, () => {
    const captured = captureCallLines(comp.callRendererComponent, comp.args);
    if (!captured) return undefined;
    const visible = captured.map(stripTrailingExpandHint).filter((line) => stripAnsi(line).trim().length > 0);
    const line = summarizeCallLines(PATH_VERBS.has(toolLabel(comp.toolName)) ? visible.slice(0, 1) : visible);
    // Demote after verb re-inking, which strips foregrounds from the prefix region;
    // doing it first would lose the dim opener and leave its body at terminal default.
    if (!line) return undefined;
    const styled = dimUnstyledSpans(colourCommandPrefix(comp, stripSgrBackgrounds(line)), currentTheme());
    return pathEmphasisLine(comp, styled) ?? styled;
  });
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

// Dim the boring prefix, not the directory (design language §9.5): the dim zone is
// the longest of the block's common directory prefix (when at least two meaningful
// segments deep — a shared bare `/` or `~/` carries no information) and the row's
// cwd prefix (session-ambient context is boring by default). Everything past it —
// divergent directories included — is the discriminator. Falls back to the whole
// directory, i.e. the classic basename-only emphasis.
function boringPrefix(comp: ToolRowLike, tildePath: string): string {
  const dir = tildePath.slice(0, tildePath.lastIndexOf("/") + 1);
  const candidates: string[] = [];
  const rows = blockToolRows(comp);
  const blockPaths = renderCache.memo(rows, "paths", () => rows.map((row) => {
    renderCache.depend(row); return toolPathArg(row);
  }).filter((path): path is string => path !== undefined));
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
  const range = lineRange(comp?.args);
  const compact = verb === "read" ? compactReadDisplay(visible, range) : undefined;
  if (compact) {
    const boring = boringPrefix(comp, compact.path);
    const tail = compact.path.slice(boring.length);
    return `${verbInk(comp, verb)} ${dim(`${compact.classification} ${boring}`)}${discriminatorInk(comp, tail)}${ink(currentTheme(), "warning", range)}`;
  }
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
// `bodyBudget` is the width the row's body may use beside its suffix; a compound bash
// row fits itself to it by command (§9.8). Other rows leave the cut to rightAlignSuffix.
function invocationInk(comp: ToolRowLike, available = Number.POSITIVE_INFINITY, bodyBudget = Number.POSITIVE_INFINITY, wrap = false): string {
  return renderCache.memo(comp, `invocation:${available}:${bodyBudget}:${wrap}:${objectCacheKey(currentTheme())}`, () => {
    // A composed call states its effects, never its script (§9.14).
    const composed = composedFacts(comp);
    if (composed) {
      // The body budget is the row's share after the block's suffix reserve (§9.8).
      const rows = blockToolRows(comp);
      const facts = blockFacts(rows);
      const budget = available - blockSuffixReserve(rows, facts, available);
      return composedBody(currentTheme(), comp, composed, toolStatus(comp) === "error", budget);
    }
    if (toolLabel(comp?.toolName) === "bash") return bashInvocationPlan(comp, available, bodyBudget, wrap).first;
    const native = nativeInvocationLine(comp);
    return native ? tildify(native) : inkedFallbackLine(comp);
  });
}

// A bash row's lines (§9.8): the record headline and `$ body` on the first, and, when
// `wrap` allows it, continuation lines at the command column. The continuation
// column sits after the headline and the `$ `, so wrapped commands share one left edge.
type BashRowPlan = BashLines & { commandColumn: number };

function bashInvocationPlan(comp: ToolRowLike, available: number, bodyBudget: number, wrap: boolean): BashRowPlan {
  return renderCache.memo(comp, `bash-plan:${available}:${bodyBudget}:${wrap}:${objectCacheKey(currentTheme())}`, () => {
    const plain = bashInvocationText(comp);
    if (plain === undefined) return { first: inkedFallbackLine(comp), continuations: [], commandColumn: 0 };
    const headline = recordHeadline(comp, available);
    const headlineWidth = headline ? visibleWidth(headline) + 1 : 0;
    const commandColumn = headlineWidth + 2;
    const budget = bodyBudget - headlineWidth;
    const text = foldBashPreamble(comp, bashDisplayLine(comp, plain));
    const lines = bashRowLines(comp, text, budget, wrap ? budget - 2 : undefined);
    return { first: headline ? `${headline} ${lines.first}` : lines.first, continuations: lines.continuations, commandColumn };
  });
}

// The body+suffix budget inside the two-sided inset (§9.1): what remains after the
// rail prefix and the right margin.
function traceRowAvailable(width: number): number {
  return Math.max(1, Math.max(1, width) - TOOL_PREFIX_VISIBLE_WIDTH - TOOL_RIGHT_MARGIN);
}

// The one row form shared by single rows and folded read runs: body left, the block's
// reserved fact-suffix column right (§9.8/§9.1), behind the railed status prefix.
function fitTraceRow(comp: ToolRowDataLike | undefined, tone: Tone, body: string, suffix: string, reserve: number, width: number, disclosure?: string): string {
  const key = JSON.stringify(["fit", width, reserve, tone, body, suffix, disclosure, drillRenderKey(comp), objectCacheKey(currentTheme())]);
  const fit = () => truncateToWidth(`${toolPrefix(tone, comp, disclosure)}${rightAlignSuffix(body, suffix, traceRowAvailable(width), currentTheme(), reserve)}`, Math.max(1, width), ELLIPSIS);
  return comp ? renderCache.memo(comp, key, fit) : fit();
}

// A composed row with a ledger is an aggregate (§9.14): `▸` folded, `▾` revealed. The
// reader's click wins; otherwise the ledger shows unless it would run past the cap.
function ledgerView(comp: ToolRowDataLike): LedgerView | undefined {
  const composed = composedFacts(comp);
  if (!composed || composed.calls.length === 0) return undefined;
  const shown = ledgerOverride(comp) ?? (ledgerPolicy.reveal && ledgerEntries(comp, composed, sizeThresholds.warning).length <= ledgerPolicy.maxLines);
  return shown ? "revealed" : "folded";
}

function oneLine(comp: ToolRowLike, width: number): string {
  return rowLines(comp, width)[0]!;
}

// One row's lines: the bullet line, then a wrapped bash row's continuation lines (§9.8)
// at the command column, rail-only like a dir fold's (§9.9).
function rowLines(comp: ToolRowLike, width: number): string[] {
  const rows = blockToolRows(comp);
  const facts = blockFacts(rows);
  const available = traceRowAvailable(width);
  const suffix = toolFactSuffix(comp, available, facts);
  const reserve = blockSuffixReserve(rows, facts, available);
  const ledger = ledgerView(comp);
  const bodyBudget = suffixBodyWidth(suffix, available, reserve);
  const bash = toolLabel(comp.toolName) === "bash" && !composedFacts(comp);
  const plan = bash ? bashInvocationPlan(comp, available, bodyBudget, true) : undefined;
  const body = plan ? plan.first : invocationInk(comp, available, bodyBudget);
  const line = fitTraceRow(
    comp,
    statusTone(comp),
    body,
    suffix,
    reserve,
    width,
    ledger === "revealed" ? "▾" : ledger === "folded" ? "▸" : undefined,
  );
  if (!plan || plan.continuations.length === 0) return [line];
  const contPrefix = `${TOOL_INDENT}${dim(TOOL_RAIL)}${" ".repeat(TOOL_PREFIX_VISIBLE_WIDTH - TOOL_INDENT.length - 1 + plan.commandColumn)}`;
  const contBudget = Math.max(1, bodyBudget - plan.commandColumn);
  return [line, ...plan.continuations.map((text) =>
    truncateToWidth(`${contPrefix}${middleTruncate(text, contBudget, currentTheme())}`, Math.max(1, width), ELLIPSIS))];
}

// --- repetition folding + preamble reclaim (issue #14, design language §9.4/§9.9) ---

// A demoted preamble still spends width: dim ink alone leaves `set -euo pipefail ↵ cd
// <dir> ↵` eating two-thirds of a row, and the shared truncation budget (§9.8) then
// cuts the real command behind it. So a bash row's *leading preamble run* — the opening
// sequence of situating segments (`set -…` hygiene, `cd <dir>`, bare `VAR=…`/`export`
// assignments) across `&&`, `;` and `↵` breaks — is reclaimed, not just dimmed: the
// `set -…` hygiene drops like the `(timeout Ns)` suffix, and the `cd`/assignment context
// folds to a dim `⋯` when it repeats the previous bash row's (§9.4).

// The segment grammar behind the reclaim (top-level splitting, env-assignment
// detection, hygiene/context/real classification) lives in bash-preamble.ts.

// The previous bash row within the same visual group: reads and other tools interleave
// freely, but visible prose opens a new paragraph — a `⋯` must never point across one.
function previousBashRow(comp: ToolRowDataLike): ToolRowLike | undefined {
  if (renderCache.active && g.__tracelineChat) return topology.previousBash(g.__tracelineChat, comp);
  const found = componentLocation(comp);
  if (!found) return undefined;
  for (let j = found.index - 1; j >= 0; j--) {
    const prev = found.sibs[j];
    renderCache.depend(prev);
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
  return bashPreambleRun(bashDisplayLine(comp, plain).slice(2));
}

// The tildified `$ …` line with its leading `cd` targets relative to the row's cwd
// (§9.4), so context keys and the shown text agree across rows.
function bashDisplayLine(comp: ToolRowDataLike, plain: string): string {
  const line = tildify(plain);
  if (!line.startsWith("$ ")) return line;
  const cwd = typeof comp.cwd === "string" && comp.cwd.length > 0 ? tildify(comp.cwd) : undefined;
  return `$ ${relativizeContextCd(line.slice(2), cwd)}`;
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
    // A lone `cd` strictly below the previous row's lone `cd` folds the shared part:
    // `cd ⋯/slack-bridge && …` (§9.4).
    const target = loneCdTarget(run.contextText);
    const base = prev ? loneCdTarget(prev.contextText) : undefined;
    if (target && base && base !== "." && target.startsWith(`${base}/`)) {
      const seg = bashTopLevelSegments(body).find((s) => s.text.startsWith("cd") && s.start >= (run.dropStart ?? 0));
      if (seg) {
        const targetStart = seg.start + seg.text.length - target.length;
        const nested = `${body.slice(seg.start, targetStart)}${PREAMBLE_MARK}${target.slice(base.length)}`;
        return `$ ${nested}${body.slice(seg.start + seg.text.length)}`;
      }
    }
  }
  // B: otherwise drop a leading `set -…` hygiene run outright (dropStart > 0 means a
  // set ran ahead of surviving context or a real command).
  if (run.dropStart !== undefined && run.dropStart > 0) {
    return `$ ${body.slice(run.dropStart)}`;
  }
  return line;
}

// Consecutive reads fold into one entity (issue #14, design language §9.9), at two
// granularities sharing one grammar: reads paging through one file merge their ranges
// (`read path:1-200,201-400 · 2 calls`), and consecutive reads of sibling files (the
// same exact directory) fold into a dir row (`read dir/ a.ts, b.ts · 2 calls`) whose
// shared directory prints once, with adjacent same-file calls merging ranges first.
// The fold compresses only the boring: an error row never folds (a failed page keeps
// its own red row) and a file whose combined landed result reaches warning severity
// keeps its own row (itself a pagination fold when paged); both split the run, so
// what balloons stays visible in the size column. Runs are broken by anything visible
// between the reads (prose, a collapsed Thinking… line, another tool), so the fold
// never reorders what the transcript shows; Ctrl+T's native view restores the
// individual rows. The folded unit is carried by its first row while the later rows
// render nothing; a dir fold that overflows the block's body budget wraps at file
// boundaries onto rail-only continuation lines (§9.9) instead of truncating
// basenames away.
function readPath(comp: ToolRowDataLike): string | undefined {
  if (toolLabel(comp?.toolName) !== "read") return undefined;
  const path = comp?.args?.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

// A read row that may participate in a fold: error rows never fold — a failed page must
// keep its own red row, not vanish into a folded one whose tone reflects only the last
// call. An error therefore also breaks the run on both sides. Warning-size breakout is
// per file, not per call, and lives in readRun's unit scan.
function foldableReadPath(comp: ToolRowDataLike): string | undefined {
  const path = readPath(comp);
  if (path === undefined) return undefined;
  if (comp.expanded === true || isRevealed(comp)) return undefined; // explicit view choices never fold
  return toolStatus(comp) === "error" ? undefined : path;
}

// The maximal run of consecutive foldable reads sharing comp's directory, walked
// through invisible connectors in both directions. Every member sees the same run,
// so the unit segmentation below is consistent whichever row renders first.
function sameDirReadRows(comp: ToolRowLike): { rows: ToolRowLike[]; index: number } | undefined {
  const path = foldableReadPath(comp);
  if (path === undefined) return undefined;
  const dir = readDirKey(path);
  const found = componentLocation(comp);
  if (!found) return undefined;
  const { sibs, index } = found;
  const inRun = (c: unknown): c is ToolRowLike => {
    if (!isToolRow(c)) return false;
    const p = foldableReadPath(c);
    return p !== undefined && readDirKey(p) === dir;
  };
  const rows: ToolRowLike[] = [comp];
  let selfIndex = 0;
  for (let j = index - 1; j >= 0; j--) {
    const prev = sibs[j];
    renderCache.depend(prev);
    if (isEmptyConnector(prev)) continue;
    if (!inRun(prev)) break;
    rows.unshift(prev);
    selfIndex++;
  }
  for (let j = index + 1; j < sibs.length; j++) {
    const next = sibs[j];
    renderCache.depend(next);
    if (isEmptyConnector(next)) continue;
    if (!inRun(next)) break;
    rows.push(next);
  }
  return { rows, index: selfIndex };
}

function readRun(comp: ToolRowLike): { rows: ToolRowLike[]; index: number } | undefined {
  if (renderCache.active) {
    const block = blockToolRows(comp);
    return renderCache.memo(block, `reads:${revealRenderKey()}`, () => {
      for (const row of block) renderCache.depend(row);
      return readPlan(block, sizeThresholds.warning, sameDirReadRows);
    }).get(comp);
  }
  const run = sameDirReadRows(comp);
  return run ? groupedReadRun(run, sizeThresholds.warning) : undefined;
}

// Reads, mutations, records and images carry facts a generic count cannot preserve.
function repetitionKey(comp: ToolRowLike): string | undefined {
  if (comp.expanded === true || isRevealed(comp) || toolLabel(comp.toolName) === "read") return undefined;
  if (inlineMutationRow(comp) || recordCellData(comp).length > 0 || resultImageFact(comp) || composedFacts(comp)) return undefined;
  return stripAnsi(invocationInk(comp)).trim() || undefined;
}

function repetitionRun(comp: ToolRowLike): { rows: ToolRowLike[]; index: number } | undefined {
  const found = componentLocation(comp);
  if (!found) return undefined;
  if (renderCache.active && g.__tracelineChat) {
    const step = topology.step(g.__tracelineChat, comp);
    if (!step) return undefined;
    return renderCache.memo(step.rows, `repeated:${objectCacheKey(currentTheme())}:${revealRenderKey()}`, () => {
      for (const row of step.rows) renderCache.depend(row);
      return repetitionPlan(step.rows, repetitionKey);
    }).get(comp);
  }
  return groupedRepetitionRun(comp, found.sibs, repetitionKey);
}

function foldedRepetitionLine(rows: ToolRowLike[], width: number): string {
  const carrier = rows[0]!;
  const failed = rows.find((row) => toolStatus(row) === "error");
  const status = failed ? "error" : rows.some((row) => toolStatus(row) === "running") ? "running" : "success";
  const blockRows = blockToolRows(carrier);
  const facts = blockFacts(blockRows);
  const available = traceRowAvailable(width);
  const count = ` ×${rows.length}`;
  const suffix = foldedRepetitionSuffix(rows, facts, available);
  const reserve = blockSuffixReserve(blockRows, facts, available);
  const budget = suffixBodyWidth(suffix, available, reserve) - count.length;
  const body = `${invocationInk(failed ?? carrier, available, budget)}${dim(count)}`;
  return fitTraceRow(carrier, status, body, suffix, reserve, width, "▸");
}

// A folded repetition sums its landed sizes; the first failed member lends the fold
// its failure fact (§9.2.1), so a red `×N` row still says why, and the fact takes the
// size cell's place below warning severity as it does on a single row.
function foldedRepetitionSuffix(rows: ToolRowLike[], facts: BlockFacts, available: number): string {
  const failed = rows.find((row) => toolStatus(row) === "error");
  const total = combinedResultChars(rows);
  const size = failed
    ? total !== undefined && total >= sizeThresholds.warning ? charSuffix(total) : ""
    : charSuffix(total, facts.sizeColumnLive);
  const cells = [failureCell(failed, available), size];
  return cells.filter((cell) => cell.length > 0).join(dim(SEP));
}

function foldedReadSuffix(rows: ToolRowDataLike[], facts: BlockFacts): string {
  const total = combinedResultChars(rows);
  const calls = `${rows.length} calls`;
  const sizeCell = charSuffix(total, facts.sizeColumnLive);
  return total === undefined || !sizeCell ? dim(calls) : `${dim(`${calls}${SEP}`)}${sizeCell}`;
}

// Continuation lines of a wrapped dir fold indent to the directory cell's column
// (the width of the `read ` verb cell), so the file list shares one left edge.
const FOLD_CONT_INDENT = "read ".length;

function foldedReadLines(rows: ToolRowLike[], width: number): string[] {
  const theme = currentTheme();
  const last = rows[rows.length - 1]!;
  const tone = rows.some((row) => toolStatus(row) === "running") ? "running" : statusTone(last);
  const blockRows = blockToolRows(last);
  const facts = blockFacts(blockRows);
  const available = traceRowAvailable(width);
  const reserve = blockSuffixReserve(blockRows, facts, available);
  // Call count rides the right-aligned suffix (fact order: what · how many · how big),
  // so middle truncation protects the discriminating basename+ranges tail of the body.
  const suffix = foldedReadSuffix(rows, facts);
  const paths = rows.map((row) => String(row?.args?.path ?? ""));

  if (new Set(paths).size === 1) {
    // One paged file: §9.9's original form, and the breakout unit for a ballooned one.
    const path = cwdRelativePath(last, paths[0]!);
    const lastSlash = path.lastIndexOf("/");
    const dir = lastSlash >= 0 ? boringPrefix(last, path) : "";
    const base = path.slice(dir.length);
    const ranges = rows
      .map((row) => lineRange(row?.args).slice(1))
      .filter(Boolean)
      .join(",");
    const body = `${verbInk(last, "read")} ${dim(dir)}${discriminatorInk(last, base)}${ink(theme, "warning", ranges ? `:${ranges}` : "")}`;
    // rows[0] is the carrier: in drill mode the fold is one target and rows[0] renders it.
    return [fitTraceRow(rows[0], tone, body, suffix, reserve, width, "▸")];
  }

  // Sibling files fold into one dir row (§9.9): the shared directory prints once
  // (§9.5's grammar: block-scoped boring prefix dim, divergent dir tail bold), then
  // the basenames follow as a bold list with dim commas, each wearing its own
  // warning `:ranges` with adjacent same-file calls' ranges already merged.
  const shown = cwdRelativePath(last, paths[0]!);
  const dirEnd = shown.lastIndexOf("/") + 1;
  const shownDir = shown.slice(0, dirEnd);
  const boring = dirEnd > 0 ? boringPrefix(last, shown) : "";
  const headInk =
    dirEnd > 0
      ? `${verbInk(last, "read")} ${dim(boring)}${discriminatorInk(last, shownDir.slice(boring.length))}`
      : verbInk(last, "read");

  const cells = adjacentReadGroups(rows).map((group) => {
    const base = group.path.slice(group.path.lastIndexOf("/") + 1);
    const ranges = group.rows
      .map((row) => lineRange(row.args).slice(1))
      .filter(Boolean)
      .join(",");
    const rangeText = ranges ? `:${ranges}` : "";
    return `${discriminatorInk(last, base)}${ink(theme, "warning", rangeText)}`;
  });

  const bodyBudget = Math.max(1, available - Math.max(visibleWidth(suffix) + 2, reserve));
  const contBudget = Math.max(1, bodyBudget - FOLD_CONT_INDENT);
  const [first, ...continuations] = wrapReadCells(theme, headInk, cells, bodyBudget, contBudget);

  // The bullet line carries the suffix (§9.9), so the block's fact column stays
  // aligned against bullets; continuation lines keep the rail but not the bullet.
  const contPrefix = `${TOOL_INDENT}${dim(TOOL_RAIL)}${" ".repeat(TOOL_PREFIX_VISIBLE_WIDTH - TOOL_INDENT.length - 1 + FOLD_CONT_INDENT)}`;
  return [
    fitTraceRow(rows[0], tone, first, suffix, reserve, width, "▸"),
    ...continuations.map((line) => truncateToWidth(`${contPrefix}${middleTruncate(line, contBudget, theme)}`, Math.max(1, width), ELLIPSIS)),
  ];
}

function componentLocation(comp: ToolRowDataLike): { sibs: unknown[]; index: number } | undefined {
  renderCache.depend(comp);
  if (renderCache.active && g.__tracelineChat) {
    const index = topology.prepare(g.__tracelineChat).positions.get(comp);
    if (index !== undefined) return { sibs: g.__tracelineChat.children, index };
  }
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
// connector turns; tight if the nearest visible sibling is another collapsed tool row
// or the collapsed thinking-label line that motivated this call.
function leadingBlank(comp: ToolRowDataLike): boolean {
  const found = componentLocation(comp);
  if (!found || found.index <= 0) return true;
  const { sibs, index } = found;
  for (let j = index - 1; j >= 0; j--) {
    const prev = sibs[j];
    renderCache.depend(prev);
    if (isExpandedToolRow(prev)) return true; // a native-rendered block above → new trace block
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
  const read = readRun(comp);
  if (read) {
    if (read.index > 0) return []; // a later call: the unit's first row carries the fold
    const lines = foldedReadLines(read.rows, width);
    return leadingBlank(comp) ? ["", ...lines] : lines;
  }
  const repeated = repetitionRun(comp);
  if (repeated) {
    if (repeated.index > 0) return [];
    const line = foldedRepetitionLine(repeated.rows, width);
    return leadingBlank(comp) ? ["", line] : [line];
  }
  const lines = rowLines(comp, width);
  const composed = composedFacts(comp);
  const ledger = composed && ledgerView(comp) === "revealed" ? ledgerLines(currentTheme(), comp, composed, width, sizeThresholds) : [];
  return leadingBlank(comp) ? ["", ...lines, ...ledger] : [...lines, ...ledger];
}

// --- collapsed thinking previews (issue #14, pi-native rendering) ----------------------

function patchAssistantRowPrototype(proto: AssistantRowPrototypeLike): void {
  if (!proto || typeof proto.render !== "function") return;
  installAssistantCacheHook(proto, (row) => {
    try { installThinkingPreviews(row); } catch { /* keep Pi's native render */ }
  }, (row) => { renderCache.dirty(row); topologyChanged(); });
  proto.__tracelineAssistantPatchVersion = ASSISTANT_ROW_PATCH_VERSION;
  g.__tracelineAssistantPatchVersion = ASSISTANT_ROW_PATCH_VERSION;
}

// --- prototype patch (shared by every current + future tool row, applied once) --------

function currentPatchInstalled(): boolean {
  return g.__tracelinePatchVersion === TOOL_ROW_PATCH_VERSION;
}

function patchToolRowPrototype(proto: TraceMousePrototype): void {
  if (currentPatchInstalled() || typeof proto.render !== "function" || typeof proto.handleMouse !== "function") return;
  installCachedTraceMouse(proto, renderCache, {
    bulletColumn: TOOL_PREFIX_VISIBLE_WIDTH - TOOL_AFTER_BULLET.length - 1,
    isCompact: (row) => displayMode() === "oneLine" && row.expanded !== true,
    renderTrace: cachedLayout,
    decorateNative: (row, lines) => drillDecorateNativeRow(
      currentTheme(), row, lines, ink(currentTheme(), statusTone(row), TOOL_BULLET),
    ),
    viewChanged: (rows) => rows.forEach((row) => renderCache.dirty(row)),
  }, topologyChanged);

  g.__tracelinePatchVersion = TOOL_ROW_PATCH_VERSION;
}

function cachedLayout(row: ToolRowLike, width: number) {
  const chat = g.__tracelineChat!;
  installContainerCacheHooks(renderCache, chat, topologyChanged);
  topology.prepare(chat);
  const key = `${width}:${objectCacheKey(chat)}:${objectCacheKey(currentTheme())}:${drillRenderKey(row)}:${revealRenderKey()}`;
  return renderCache.value(row, `layout:${key}`, () => {
    const lines = renderTraceRow(row, width);
    return { lines, plain: lines.map(stripAnsi), members: readRun(row)?.rows ?? repetitionRun(row)?.rows, ledger: ledgerView(row) };
  });
}

function assistantPatchInstalled(): boolean {
  return g.__tracelineAssistantPatchVersion === ASSISTANT_ROW_PATCH_VERSION;
}

function tryPatch(): boolean {
  if (!g.__tracelineTui) return false;
  const toolWasPatched = currentPatchInstalled();
  const assistantWasPatched = assistantPatchInstalled();
  let containerWasPatched = false;
  try {
    const sibs = chatChildren();
    if (!Array.isArray(sibs)) return false;
    if (!toolWasPatched) {
      const row = sibs.find(isToolRow);
      if (row) patchToolRowPrototype(Object.getPrototypeOf(row));
    }
    if (!assistantWasPatched) {
      const assistant = sibs.find(isAssistantRow);
      if (assistant) patchAssistantRowPrototype(Object.getPrototypeOf(assistant));
    }
    const chat = g.__tracelineChat;
    if (chat && !chat.__tracelineCachePatched) {
      installContainerCacheHooks(renderCache, chat, topologyChanged);
      containerWasPatched = true;
    }
  } catch {
    return false;
  }
  return containerWasPatched || (!toolWasPatched && currentPatchInstalled()) ||
    (!assistantWasPatched && assistantPatchInstalled());
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
  dimUnstyledSpans: (line: string) => dimUnstyledSpans(line, currentTheme()),
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
  captureWriteCallSnapshot,
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
  patchToolRowPrototype,
  patchAssistantRowPrototype,
  isExpandedToolRow,
  statusTone,
  foldedReadLines,
  // repetition folding + preamble reclaim + thinking-label preview/dedupe (issue #14)
  bashPreambleRun,
  bashPreambleRunOf,
  foldBashPreamble,
  previousBashRow,
  readRun,
  // typed test/dev accessors for traceline's Pi seam globals
  setTracelineChat,
  getTracelineChat,
  setTracelineThemeGetter,
  cachedRenderTraceRow: (row: ToolRowLike, width: number) => cachedLayout(row, width).lines,
  uncachedRenderTraceRow: (row: ToolRowLike, width: number) =>
    renderCache.withoutCache(() => renderTraceRow(row, width)),
  renderCacheWorkCounts: (reset = false) => renderCache.workCounts(reset),
  resetRenderCache: () => renderCache.reset(),
};

export default function piTraceline(pi: ExtensionAPI) {
  const config: TracelineConfig = Object.assign(
    {},
    ...configPaths("pi-traceline", process.cwd()).map(
      (path) => readJsonConfig(path, parseTracelineConfig) ?? {},
    ),
  );
  let patchTimer: ReturnType<typeof setTimeout> | undefined;
  const tuiOwner = createTracelineTuiOwner();
  let inputUnsubscribe: (() => void) | undefined;
  const applyPatches = () => {
    patchTimer = undefined;
    if (tryPatch()) g.__tracelineTui?.requestRender();
  };
  const schedulePatches = () => {
    if (!g.__tracelineTui || patchTimer) return;
    patchTimer = setTimeout(applyPatches, 0);
  };
  const clearPatchTimer = () => {
    if (patchTimer) clearTimeout(patchTimer);
    patchTimer = undefined;
  };
  const afterThinkingToggle = () => {
    const patched = tryPatch();
    const suppressed = suppressThinkingToggleStatus(chatChildren());
    if (patched || suppressed) g.__tracelineTui?.requestRender();
  };

  // Drill mode (§9.13) lives in drill.ts / drill-pager.ts; this host hands it just the
  // render internals it needs. Entry points: a shortcut (alt+t by default, `drillKey`
  // in the family config to rebind) plus /drill for discoverability.
  const drillHost = (ui: ExtensionUIContext): DrillHost => ({
    ui,
    theme: currentTheme,
    chatChildren,
    requestRender: () => g.__tracelineTui?.requestRender(),
    traceLines: (comp, width) => {
      const read = readRun(comp);
      if (read?.index === 0) return foldedReadLines(read.rows, width);
      const repeated = repetitionRun(comp);
      return repeated?.index === 0 ? [foldedRepetitionLine(repeated.rows, width)] : rowLines(comp, width);
    },
    runRows: (comp) => {
      const read = readRun(comp);
      if (read?.index === 0) return read.rows;
      const repeated = repetitionRun(comp);
      return repeated?.index === 0 ? repeated.rows : undefined;
    },
    // Only one-line mode folds rows away; in native mode every row is its own target.
    hiddenByFold: (comp) =>
      displayMode() === "oneLine" && ((readRun(comp)?.index ?? 0) > 0 || (repetitionRun(comp)?.index ?? 0) > 0),
    statusTone,
    // The pager is the fidelity surface (§9.13): every call, unfolded.
    ledgerLines: (comp, width) => {
      const composed = composedFacts(comp);
      return composed && composed.calls.length > 0 ? ledgerLines(currentTheme(), comp, composed, width, sizeThresholds, false) : [];
    },
  });
  const startDrill = (ctx: { ui: ExtensionUIContext; hasUI: boolean }) => {
    if (!ctx.hasUI) return;
    enterDrillMode(drillHost(ctx.ui));
  };
  // SAFETY: drillKey comes from user config; an unknown key id just never matches.
  pi.registerShortcut((config.drillKey ?? "alt+t") as KeyId, {
    description: "traceline: drill into tool rows (number, peek, pin)",
    handler: async (ctx) => startDrill(ctx),
  });
  pi.registerCommand("drill", {
    description: "traceline: number the visible tool rows; type one to peek",
    handler: async (_args, ctx) => startDrill(ctx),
  });
  pi.on("message_start", (event, ctx) => {
    if (tuiOwner.owns() && ctx.mode === "tui" && event.message.role === "assistant") schedulePatches();
  });
  pi.on("message_update", (_event, ctx) => { if (tuiOwner.owns() && ctx.mode === "tui") schedulePatches(); });
  // Nested calls (§9.14) never get rows of their own; their live events are the only
  // source of a nested result's size, so capture what the row grammar needs and
  // re-render the parent row that owns them.
  const invalidateParent = (parentToolCallId: string) => {
    for (const row of chatChildren() ?? []) if (isToolRow(row) && row.toolCallId === parentToolCallId) renderCache.dirty(row);
    g.__tracelineTui?.requestRender();
  };
  pi.on("tool_execution_start", (event, ctx) => {
    if (!tuiOwner.owns() || ctx.mode !== "tui") return;
    if (!event.parentToolCallId) return schedulePatches();
    recordNestedStart(event.toolCallId, event.args);
    invalidateParent(event.parentToolCallId);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!tuiOwner.owns() || ctx.mode !== "tui" || !event.parentToolCallId) return;
    recordNestedEnd(event.toolCallId, event.result, event.isError);
    invalidateParent(event.parentToolCallId);
  });
  pi.on("session_tree", (_event, ctx) => { if (tuiOwner.owns() && ctx.mode === "tui") schedulePatches(); });
  pi.on("tool_call", (event, ctx) => {
    if (!tuiOwner.owns() || ctx.mode !== "tui" || event.toolName !== "write") return;
    try {
      captureWriteCallSnapshot(event.toolCallId, event.input, ctx.cwd);
      for (const row of chatChildren() ?? []) if (isToolRow(row) && row.toolCallId === event.toolCallId) renderCache.dirty(row);
    } catch {
      /* Traceline display work must never block write execution. */
    }
  });
  pi.on("session_start", (_event, ctx) => {
    if (!tuiOwner.claim(ctx)) return;
    clearPatchTimer();
    clearWriteCallSnapshots();
    clearNestedCaptures();
    resetRevealedFolds();
    renderCache.reset();
    g.__tracelinePatchVersion = g.__tracelineAssistantPatchVersion = undefined; // rebind both adapters on reload
    setTracelineChat(undefined);
    g.__tracelineTui = undefined;
    configureSizeThresholds(config);
    g.__tracelineGetTheme = () => ctx.ui.theme;
    captureTui(ctx.ui, "__pi_traceline_capture", (tui) => {
      g.__tracelineTui = tui;
      if (tryPatch()) tui.requestRender();
      else schedulePatches();
    });
    inputUnsubscribe?.();
    inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      // A foreign chord exits drill mode before the same input reaches Pi (§9.13).
      handleDrillTerminalInput(data);
      return handleThinkingToggleTerminalInput(data, ctx.ui, afterThinkingToggle);
    });
  });

  pi.on("session_shutdown", () => {
    if (!tuiOwner.release()) return;
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    clearPatchTimer();
    clearWriteCallSnapshots();
    resetRevealedFolds();
    exitDrillMode(); // restores the editor when shutdown interrupts drill mode
    g.__tracelineTui = undefined;
    setTracelineChat(undefined);
    setTracelineThemeGetter(undefined);
  });
}
