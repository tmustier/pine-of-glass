import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { rawIndexAtVisibleIndex, rawIndexBeforeVisibleIndex, stripAnsi } from "../_lib/ansi.ts";
import { captureTui } from "../_lib/capture.ts";
import {
  findChatContainer,
  isAssistantRow,
  isNoticeRow,
  isToolRow,
  type AssistantRowPrototypeLike,
  type ChatRowLike,
  type ContainerLike,
  type NoticeRowLike,
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
} from "./bash-preamble.ts";
import { checkFacts, checkFailed } from "./checks.ts";
import { failureCell as inkFailureFact, failureFact } from "./failure.ts";
import { fitHeadline, mergeHeadlineFacts, type RecordCellData } from "./headline.ts";
import { fitBashLines, type BashLines } from "./bash-lines.ts";
import {
  drillDecorateNativeRow,
  drillRenderKey,
  drillTracePrefix,
  enterDrillMode,
  exitDrillMode,
} from "./drill.ts";
import { handleDrillTerminalInput } from "./drill-input.ts";
import { resultImageFact as rawResultImageFact } from "./image-fact.ts";
import { installTraceMouse, isRevealed, ledgerOverride, resetRevealedFolds, revealRenderKey, revealedBullet, type LedgerView, type TraceMousePrototype } from "./click.ts";
import {
  cachedIntrinsic,
  installAssistantCacheHook,
  installContainerCacheHooks,
  objectCacheKey,
} from "./cache-hooks.ts";
import { clearNestedCaptures, composedFactsOf, recordNestedEnd, recordNestedStart } from "./nested-calls.ts";
import { ledgerEntries, ledgerLines } from "./ledger.ts";
import { composedBody } from "./nested-rows.ts";
import { stripTrailingExpandHint, trimLeadingVisibleWhitespace } from "./native-lines.ts";
import { noticeBody } from "./notice-rows.ts";
import { installRowMouse, type RowLayout } from "./row-mouse.ts";
import { commonDirSegments, compactReadDisplay, cwdRelativePath, lineRange, readDirKey } from "./path-rows.ts";
import { recordFacts, resultText } from "./records.ts";
import { installVocabulary } from "./vocabulary-layers.ts";
import { gistFor, installSummaries } from "./summaries.ts";
import { wrapReadCells } from "./read-fold.ts";
import { TraceRenderCache } from "./render-cache.ts";
import { adjacentReadGroups, combinedResultChars, groupedReadRun, groupedRepetitionRun, readPlan, repetitionPlan } from "./repetition-fold.ts";
import { TraceTopology, isCompactNoticeRow, isEmptyConnector, isCollapsedThinkingRow, isExpandedToolRow } from "./topology.ts";
import {
  captureWriteCallSnapshot,
  clearWriteCallSnapshots,
  mutationDiffStats as rawMutationDiffStats,
  type DiffStats,
} from "./write-diff.ts";
import { installThinkingPreviews } from "./thinking-preview.ts";
import { captureCallLines } from "./call-capture.ts";
import { summarizeCallLines } from "./call-summary.ts";
import { handleThinkingToggleTerminalInput } from "./thinking-toggle.ts";
import { suppressThinkingToggleStatus } from "./status-line.ts";
import { dimUnstyledSpans, stripSgrBackgrounds, stripSgrForegrounds } from "./sgr.ts";
import { createTracelineTuiOwner } from "./tui-owner.ts";
import { parseTracelineConfig, type TracelineConfig } from "./traceline-config.ts";

/** Compact trace rendering; see docs/design-language.md §9. */

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
  if (!chat) {
    chat = g.__tracelineTui ? findChatContainer(g.__tracelineTui) : undefined;
    g.__tracelineChat = chat;
  }
  return chat?.children;
}

// --- reasoning-visibility = source of truth for tool collapse -------------------------

// Follow Pi's live reasoning state; use native rendering until an assistant exists.
function thinkingHidden(): boolean {
  chatChildren();
  const chat = g.__tracelineChat;
  return chat ? topology.prepare(chat).lastAssistant?.hideThinkingBlock ?? false : false;
}

// --- one-line rendering ---------------------------------------------------------------

// Raw tool name exactly as pi reports it (read, edit, bash, mcp/tool names, etc.).
function toolLabel(name: unknown): string {
  return typeof name === "string" && name.length > 0 ? name : "tool";
}

type ToolStatus = "success" | "running" | "error";

function toolStatus(comp: ToolRowDataLike | undefined): ToolStatus {
  if (comp?.result?.isError) return "error";
  if (comp?.result && comp.isPartial !== true) return "success";
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

// Discriminators (verbs, basenames and bash heads) share neutral bold ink (§2/§9.2).
// Status lives in the bullet; only a failed call tints its discriminators.
function verbTone(comp: ToolRowDataLike | undefined): Tone {
  return toolStatus(comp) === "error" ? "error" : "text";
}

function verbInk(comp: ToolRowDataLike | undefined, verb: string): string {
  return ink(currentTheme(), verbTone(comp), `${BOLD}${verb}${BOLD_OFF}`);
}

// Trace tools and notices share the same nested rail (§9.1).
function railPrefix(bullet: string): string {
  return `${TOOL_INDENT}${dim(TOOL_RAIL)} ${bullet}${TOOL_AFTER_BULLET}`;
}

// Severity thresholds (design language §6): dim while healthy, warning/error when an
// output balloons. Overridable via the family config convention
// (~/.pi/agent/pi-traceline.json / <cwd>/.pi/pi-traceline.json).
let sizeThresholds: SizeThresholds = SIZE_THRESHOLDS;

// The ledger is the trace (§9.14): a composed row reveals its ledger by default unless
// it would run past the cap even after folding. Both knobs live in the family config.
const LEDGER_POLICY = { reveal: true, maxLines: 12 }; // agent-default (not a user rule): 2026-10-20
let ledgerPolicy = LEDGER_POLICY;

function configureSizeThresholds(config: TracelineConfig | undefined): void {
  renderCache.reset();
  const warning = config?.sizeWarningChars ?? SIZE_THRESHOLDS.warning;
  const error = config?.sizeErrorChars ?? SIZE_THRESHOLDS.error;
  sizeThresholds = { warning, error: Math.max(error, warning) };
  ledgerPolicy = { reveal: config?.revealLedgers ?? LEDGER_POLICY.reveal, maxLines: config?.ledgerMaxLines ?? LEDGER_POLICY.maxLines };
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
  return ink(currentTheme(), sizeTone(chars, sizeThresholds), `${compactCount(chars)} ch`);
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

// Scope columns and path emphasis to the contiguous trace block (§9.5/§9.7/§9.8).
function blockToolRows(comp: ToolRowLike): ToolRowLike[] {
  if (renderCache.active && g.__tracelineChat) return topology.block(g.__tracelineChat, comp);
  const found = componentLocation(comp);
  if (!found) return [comp];
  const breaks = (row: unknown) => isToolRow(row) ? row.expanded === true : !isEmptyConnector(row) && !isCompactNoticeRow(row);
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

// --- records of consequence (design language §9.10) -----------------------------------

function recordCellData(comp: ToolRowDataLike): RecordCellData[] {
  return renderCache.memo(comp, "records", () => mergeHeadlineFacts(recordFacts(comp), checkFacts(comp)));
}

// Only records of consequence suppress the size cell (§9.7); a check row keeps it,
// because test output is pulled context (§9.10.1).
function recordRow(comp: ToolRowDataLike): boolean {
  return recordFacts(comp).length > 0;
}

// A failed row leads its facts with why (§9.2.1).
function failureCell(comp: ToolRowDataLike | undefined, available: number): string {
  const fact = rowFailureFact(comp);
  return fact ? inkFailureFact(currentTheme(), fact, available) : "";
}

// The row's size-berth cell: a record's or a failed row's suppressed cell (§9.10,
// §9.2.1), an image what-fact, or the char count; a composed call's `trimmed` fact
// rides ahead of it (§9.14).
function sizeBerthCell(comp: ToolRowDataLike, sizeColumnLive: boolean): string {
  const chars = resultTextCharCount(comp);
  let base: string;
  if (recordRow(comp) || rowFailureFact(comp)) {
    // Records and failures suppress confirmation-sized text, even in a live column.
    base = chars !== undefined && chars >= sizeThresholds.warning ? charSuffix(chars) : "";
  } else {
    const image = resultImageFact(comp);
    base = image ? dim(image) : charSuffix(chars, sizeColumnLive);
  }
  if (!composedFacts(comp)?.trimmed) return base;
  const trimmed = ink(currentTheme(), "warning", "trimmed");
  return base ? `${trimmed}${dim(SEP)}${base}` : trimmed;
}

function toolFactSuffix(comp: ToolRowLike, available = Number.POSITIVE_INFINITY, facts: BlockFacts = blockFacts(blockToolRows(comp))): string {
  const theme = currentTheme();
  const parts: string[] = [];
  // Inline-diff mutations (§9.5) spend no right-column ink: the diff rides the
  // basename and the confirmation-size cell is dropped, so the suffix stays empty.
  // Record rows (§9.10) headline their facts on the left and suppress the size cell
  // below warning severity.
  const inline = inlineMutationRow(comp);
  const diff = inline ? undefined : mutationDiffStats(comp);
  const chars = inline ? "" : sizeBerthCell(comp, facts.sizeColumnLive);
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

// Flatten every visible bash line with ↵; apply family ink after preamble reclaim.

function bashInvocationText(comp: ToolRowDataLike | undefined): string | undefined {
  return comp ? renderCache.memo(comp, "bash-invocation", () => {
    const lines = captureCallLines(comp.callRendererComponent, comp.args);
    if (!lines) return undefined;
    const flattened = lines.map(stripAnsi)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim())
      .join(` ${LINE_BREAK_MARK} `);
    // Timeout is boilerplate; the full invocation stays one zoom away (§9.3).
    return flattened ? flattened.replace(/^•\s*/, "").replace(/ \(timeout [^)]*\)\s*$/i, "") : undefined;
  }) : undefined;
}

// Rare fallback for tools without a renderCall component.
function inkedFallbackLine(comp: ToolRowDataLike | undefined): string {
  const verb = toolLabel(comp?.toolName);
  const args = comp?.args ?? {};
  const path = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
  const invocation = verb === "read"
    ? `${verb} ${path ?? ""}${lineRange(args)}`
    : `${verb} ${path ?? JSON.stringify(args)}`;
  const body = tildify(invocation.replace(/\s+/g, " ").trim() || verb);
  if (body === verb) return verbInk(comp, verb);
  // Argument text at the one supporting grey (§9.3), matching bash argument ink.
  return body.startsWith(`${verb} `) ? `${verbInk(comp, verb)} ${dim(body.slice(verb.length + 1))}` : dim(body);
}

// Emphasis for plain file reads, edits, and writes (design language §9.5): dim the
// directory so the basename (which file) stands out, and keep the read :line-range in
// pi's warning/yellow treatment so scoped reads pop. Applied only when the native row
// is a bare `<verb> <path>[:range]`; rows with extra native decoration (resource /
// [skill] labels, inline diff hints) keep pi's own rendering.
const PATH_VERBS = new Set(["read", "edit", "write"]);

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
    renderCache.depend(row);
    if (!PATH_VERBS.has(toolLabel(row.toolName))) return undefined;
    const path = row.args?.path ?? row.args?.file_path;
    return typeof path === "string" && path.length > 0 ? cwdRelativePath(row, path) : undefined;
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

// The invocation body with family ink applied: bash rows rebuild from plain text, path
// rows get the dim-directory emphasis, everything else keeps pi's native line with a
// re-inked verb; tools without a renderer fall back to a plain verb+args line.
// `bodyBudget` is the width the row's body may use beside its suffix; a compound bash
// row fits itself to it by command (§9.8), never wrapping here: rowLines owns the
// wrapped form. Other rows leave the cut to rightAlignSuffix.
function invocationInk(comp: ToolRowLike, available = Number.POSITIVE_INFINITY, bodyBudget = Number.POSITIVE_INFINITY): string {
  return renderCache.memo(comp, `invocation:${available}:${bodyBudget}:${objectCacheKey(currentTheme())}`, () => {
    // A composed call states its effects, never its script (§9.14).
    const composed = composedFacts(comp);
    if (composed) {
      // The body budget is the row's share after the block's suffix reserve (§9.8).
      const rows = blockToolRows(comp);
      const facts = blockFacts(rows);
      const budget = available - blockSuffixReserve(rows, facts, available);
      return composedBody(currentTheme(), comp, composed, toolStatus(comp) === "error", budget);
    }
    if (comp.toolName === "bash") return bashInvocationPlan(comp, available, bodyBudget, false).first;
    const native = renderCache.memo(comp, `native-invocation:${objectCacheKey(currentTheme())}`, () => {
      const captured = captureCallLines(comp.callRendererComponent, comp.args);
      if (!captured) return undefined;
      const verb = toolLabel(comp.toolName);
      const visibleLines = captured.map(stripTrailingExpandHint).filter((line) => stripAnsi(line).trim().length > 0);
      // A path row borrows only Pi's header, not the diff or file preview (§9.5/§9.6).
      const line = summarizeCallLines(PATH_VERBS.has(verb) ? visibleLines.slice(0, 1) : visibleLines);
      if (!line) return undefined;
      const unindented = trimLeadingVisibleWhitespace(stripSgrBackgrounds(line));
      const bullet = stripAnsi(unindented).match(/^•\s*/)?.[0];
      const trimmed = bullet ? unindented.slice(rawIndexAtVisibleIndex(unindented, bullet.length)) : unindented;
      const visible = stripAnsi(trimmed).trimStart();
      const prefixLength = visible.startsWith(verb) ? verb.length : visible.match(/^\S+/)?.[0].length ?? 0;
      let styled = trimmed;
      if (prefixLength > 0) {
        const end = rawIndexBeforeVisibleIndex(trimmed, prefixLength);
        styled = `${verbInk(comp, stripSgrForegrounds(trimmed.slice(0, end)))}${trimmed.slice(end)}`;
      }
      // Demote after re-inking the verb, so its stripped foreground cannot erase dim.
      styled = dimUnstyledSpans(styled, currentTheme());
      if (!PATH_VERBS.has(verb)) return styled;
      const path = comp.args?.path ?? comp.args?.file_path;
      if (typeof path !== "string" || path.length === 0) return styled;
      const tildePath = tildify(path);
      if (!tildePath.includes("/")) return styled;
      const plain = stripAnsi(styled).trim();
      const range = lineRange(comp.args);
      const compact = verb === "read" ? compactReadDisplay(plain, range) : undefined;
      if (compact) {
        const boring = boringPrefix(comp, compact.path);
        const tail = compact.path.slice(boring.length);
        return `${verbInk(comp, verb)} ${dim(`${compact.classification} ${boring}`)}${verbInk(comp, tail)}${ink(currentTheme(), "warning", range)}`;
      }
      const matches = verb === "read"
        ? plain.startsWith(`${verb} ${tildePath}`) || plain.startsWith(`${verb} ${path}`)
        : plain === `${verb} ${tildePath}` || plain === `${verb} ${path}`;
      if (!matches) return styled;
      const shown = cwdRelativePath(comp, path);
      const boring = boringPrefix(comp, shown);
      // The basename protects the read range or mutation diff as its tail (§9.5).
      const stats = verb === "read" ? undefined : mutationDiffStats(comp);
      const qualifier = verb === "read" ? ink(currentTheme(), "warning", range)
        : stats ? ` ${formatMutationDiffStats(stats)}` : "";
      return `${verbInk(comp, verb)} ${dim(boring)}${verbInk(comp, shown.slice(boring.length))}${qualifier}`;
    });
    return native ? tildify(native) : inkedFallbackLine(comp);
  });
}

// A bash row's lines (§9.8): the record headline and `$ body` on the first, and, when
// `wrap` allows it and fitting by command would starve one, continuation lines at the
// command column, which sits after the headline and the `$ ` so wrapped commands share
// one left edge. Rows with no `$ ` body (pi's rendering changed) dim whole.
type BashRowPlan = BashLines & { commandColumn: number };

function bashInvocationPlan(comp: ToolRowLike, available: number, bodyBudget: number, wrap: boolean): BashRowPlan {
  return renderCache.memo(comp, `bash-plan:${available}:${bodyBudget}:${wrap}:${objectCacheKey(currentTheme())}`, () => {
    const plain = bashInvocationText(comp);
    if (plain === undefined) return { first: inkedFallbackLine(comp), continuations: [], overflow: false, commandColumn: 0 };
    const headline = fitHeadline(currentTheme(), recordCellData(comp), available);
    const headlineWidth = headline ? visibleWidth(headline) + 1 : 0;
    let text = bashDisplayLine(comp, plain);
    if (text.startsWith("$ ")) {
      const body = text.slice(2);
      const run = bashPreambleRun(body);
      let folded: string | undefined;
      if (run.firstRealStart !== undefined && run.contextText !== "") {
        // A ⋯ may point through tool rows and invisible connectors, never prose (§9.4).
        let previous: ToolRowLike | undefined;
        if (renderCache.active && g.__tracelineChat) previous = topology.previousBash(g.__tracelineChat, comp);
        else {
          const found = componentLocation(comp);
          if (found) {
            for (let j = found.index - 1; j >= 0; j--) {
              const row = found.sibs[j];
              renderCache.depend(row);
              if (isToolRow(row)) {
                if (row.toolName === "bash") { previous = row; break; }
                continue;
              }
              if (!isEmptyConnector(row) && !isCollapsedThinkingRow(row)) break;
            }
          }
        }
        const previousText = previous ? bashInvocationText(previous) : undefined;
        const previousRun = previous && previousText?.startsWith("$ ")
          ? bashPreambleRun(bashDisplayLine(previous, previousText).slice(2)) : undefined;
        if (previousRun?.contextText === run.contextText) {
          folded = `${PREAMBLE_MARK} ${body.slice(run.firstRealStart)}`;
        } else {
          // A lone cd below the previous lone cd folds only the shared directory.
          const target = loneCdTarget(run.contextText);
          const base = previousRun ? loneCdTarget(previousRun.contextText) : undefined;
          if (target && base && base !== "." && target.startsWith(`${base}/`)) {
            const segment = bashTopLevelSegments(body).find((s) => s.text.startsWith("cd") && s.start >= (run.dropStart ?? 0));
            if (segment) {
              const targetStart = segment.start + segment.text.length - target.length;
              folded = `${body.slice(segment.start, targetStart)}${PREAMBLE_MARK}${target.slice(base.length)}${body.slice(segment.start + segment.text.length)}`;
            }
          }
        }
      }
      // Otherwise only leading set hygiene drops; the row keeps its own context.
      text = `$ ${folded ?? (run.dropStart ? body.slice(run.dropStart) : body)}`;
    }
    const commandColumn = headlineWidth + 2;
    const budget = bodyBudget - commandColumn;
    const lines: BashLines = text.startsWith("$ ")
      ? fitBashLines(currentTheme(), verbTone(comp), text.slice(2), budget, wrap ? budget : undefined, recordFacts(comp).flatMap(({ by }) => by))
      : { first: dim(text), continuations: [], overflow: false };
    const body = text.startsWith("$ ") ? `${verbInk(comp, "$")} ${headline ? middleTruncate(lines.first, budget, currentTheme()) : lines.first}` : lines.first;
    return { ...lines, first: headline ? `${headline} ${body}` : body, commandColumn };
  });
}

function traceRowAvailable(width: number): number {
  return Math.max(1, width - TOOL_PREFIX_VISIBLE_WIDTH - TOOL_RIGHT_MARGIN);
}

function fitTraceLine(prefix: string, body: string, suffix: string, reserve: number, width: number): string {
  const fitted = rightAlignSuffix(body, suffix, traceRowAvailable(width), currentTheme(), reserve);
  return truncateToWidth(`${prefix}${fitted}`, Math.max(1, width), ELLIPSIS);
}

function fitTraceRow(comp: ToolRowDataLike | undefined, tone: Tone, body: string, suffix: string, reserve: number, width: number, disclosure?: string): string {
  const key = JSON.stringify(["fit", width, reserve, tone, body, suffix, disclosure, drillRenderKey(comp), objectCacheKey(currentTheme())]);
  const fit = () => {
    const bullet = ink(currentTheme(), tone, disclosure ?? revealedBullet(comp) ?? TOOL_BULLET);
    const prefix = drillTracePrefix(currentTheme(), comp, bullet) ?? railPrefix(bullet);
    return fitTraceLine(prefix, body, suffix, reserve, width);
  };
  return comp ? renderCache.memo(comp, key, fit) : fit();
}

// A composed row with a ledger is an aggregate (§9.14): `▸` folded, `▾` revealed. The
// reader's click wins; otherwise the ledger shows unless it would run past the cap.
function ledgerView(comp: ToolRowDataLike): LedgerView | undefined {
  const composed = composedFacts(comp);
  if (!composed || composed.calls.length === 0) return undefined;
  const shown = ledgerOverride(comp) ?? (ledgerPolicy.reveal && ledgerEntries(composed, sizeThresholds.warning).length <= ledgerPolicy.maxLines);
  return shown ? "revealed" : "folded";
}

// One row's lines: the bullet line, then a wrapped bash row's continuation lines (§9.8)
// at the command column, rail-only like a dir fold's (§9.9), then a cut or wrapped
// command's `≈` gist at the body column, wrapped across the row's width, never cut (§9.15).
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
  const disclosure = ledger === "revealed" ? "▾" : ledger === "folded" ? "▸" : undefined;
  const line = fitTraceRow(comp, statusTone(comp), body, suffix, reserve, width, disclosure);
  const command = comp.args?.command;
  const gist = plan?.overflow && typeof command === "string" ? gistFor("command", command, comp.result !== undefined) : undefined;
  if (!plan || (plan.continuations.length === 0 && !gist)) return [line];
  const railed = (column: number, budget: number, text: string) => truncateToWidth(`${TOOL_INDENT}${dim(TOOL_RAIL)}${" ".repeat(TOOL_PREFIX_VISIBLE_WIDTH - TOOL_INDENT.length - 1 + column)}${middleTruncate(text, budget, currentTheme())}`, Math.max(1, width), ELLIPSIS);
  const gistLines = gist ? wrapTextWithAnsi(gist, Math.max(1, available - 2)).map((text, i) => railed(0, available, `${i ? " " : dim("≈")} ${ink(currentTheme(), "muted", text)}`)) : [];
  return [line, ...plan.continuations.map((text) => railed(plan.commandColumn, Math.max(1, bodyBudget - plan.commandColumn), text)), ...gistLines];
}

// The tildified `$ …` line with its leading `cd` targets relative to the row's cwd
// (§9.4), so context keys and the shown text agree across rows.
function bashDisplayLine(comp: ToolRowDataLike, plain: string): string {
  const line = tildify(plain);
  if (!line.startsWith("$ ")) return line;
  const cwd = typeof comp.cwd === "string" && comp.cwd.length > 0 ? tildify(comp.cwd) : undefined;
  return `$ ${relativizeContextCd(line.slice(2), cwd)}`;
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
// Explicit view choices and failed pages never fold: their own facts must stay visible.
function foldableReadPath(comp: ToolRowDataLike): string | undefined {
  if (comp.toolName !== "read" || comp.expanded === true || isRevealed(comp) || toolStatus(comp) === "error") return undefined;
  const path = comp.args?.path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
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
    const body = `${verbInk(last, "read")} ${dim(dir)}${verbInk(last, base)}${ink(theme, "warning", ranges ? `:${ranges}` : "")}`;
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
      ? `${verbInk(last, "read")} ${dim(boring)}${verbInk(last, shownDir.slice(boring.length))}`
      : verbInk(last, "read");

  const cells = adjacentReadGroups(rows).map((group) => {
    const base = group.path.slice(group.path.lastIndexOf("/") + 1);
    const ranges = group.rows
      .map((row) => lineRange(row.args).slice(1))
      .filter(Boolean)
      .join(",");
    const rangeText = ranges ? `:${ranges}` : "";
    return `${verbInk(last, base)}${ink(theme, "warning", rangeText)}`;
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

function componentLocation(comp: ChatRowLike): { sibs: unknown[]; index: number } | undefined {
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
    index = Array.isArray(sibs) ? sibs.indexOf(comp) : -1;
  }
  return Array.isArray(sibs) && index >= 0 ? { sibs, index } : undefined;
}

// Compact tools, notices and thinking labels share one block across empty turns.
function leadingBlank(comp: ChatRowLike): boolean {
  const found = componentLocation(comp);
  if (!found || found.index <= 0) return true;
  const { sibs, index } = found;
  for (let j = index - 1; j >= 0; j--) {
    const prev = sibs[j];
    renderCache.depend(prev);
    if (isExpandedToolRow(prev)) return true;
    if (isToolRow(prev)) return false;
    if (isNoticeRow(prev)) return prev._expanded;
    if (isEmptyConnector(prev)) continue;
    if (isCollapsedThinkingRow(prev)) return false;
    return true;
  }
  return true;
}

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

function adoptNoticeRow(child: unknown): boolean {
  if (!isNoticeRow(child)) return false;
  const patched = installRowMouse<NoticeRowLike, RowLayout>(Object.getPrototypeOf(child), {
    renderTrace(row, width) {
      if (!thinkingHidden() || row._expanded) return undefined;
      const theme = currentTheme();
      const { body, chars } = noticeBody(row, theme);
      const bullet = theme ? theme.fg("customMessageLabel", TOOL_BULLET) : TOOL_BULLET;
      const line = fitTraceLine(railPrefix(bullet), body, charSuffix(chars), 0, width);
      const lines = leadingBlank(row) ? ["", line] : [line];
      return { lines, plain: lines.map(stripAnsi) };
    },
    click(row) {
      if (!thinkingHidden()) return false;
      row.setExpanded(!row._expanded);
      return true;
    },
    changed: (row) => { renderCache.dirty(row); topologyChanged(); },
  });
  if (patched) g.__tracelineTui?.requestRender();
  return patched;
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

function currentPatchInstalled(): boolean {
  return g.__tracelinePatchVersion === TOOL_ROW_PATCH_VERSION;
}

function patchToolRowPrototype(proto: TraceMousePrototype): void {
  if (currentPatchInstalled() || typeof proto.render !== "function" || typeof proto.handleMouse !== "function") return;
  installTraceMouse(proto, renderCache, {
    bulletColumn: TOOL_PREFIX_VISIBLE_WIDTH - TOOL_AFTER_BULLET.length - 1,
    isCompact: (row) => thinkingHidden() && row.expanded !== true,
    renderTrace(row, width) {
      const chat = g.__tracelineChat!;
      installContainerCacheHooks(renderCache, chat, topologyChanged, adoptNoticeRow);
      topology.prepare(chat);
      const key = `${width}:${objectCacheKey(chat)}:${objectCacheKey(currentTheme())}:${drillRenderKey(row)}:${revealRenderKey()}`;
      return renderCache.value(row, `layout:${key}`, () => {
        const lines = renderTraceRow(row, width);
        return { lines, plain: lines.map(stripAnsi), members: readRun(row)?.rows ?? repetitionRun(row)?.rows, ledger: ledgerView(row) };
      });
    },
    decorateNative: (row, lines) => drillDecorateNativeRow(
      currentTheme(), row, lines, ink(currentTheme(), statusTone(row), TOOL_BULLET),
    ),
    viewChanged: (rows) => rows.forEach((row) => renderCache.dirty(row)),
  }, topologyChanged);

  g.__tracelinePatchVersion = TOOL_ROW_PATCH_VERSION;
}

function assistantPatchInstalled(): boolean {
  return g.__tracelineAssistantPatchVersion === ASSISTANT_ROW_PATCH_VERSION;
}

function tryPatch(): boolean {
  if (!g.__tracelineTui) return false;
  const toolWasPatched = currentPatchInstalled();
  const assistantWasPatched = assistantPatchInstalled();
  let containerWasPatched = false;
  let noticeWasPatched = false;
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
    for (const row of sibs) {
      noticeWasPatched = adoptNoticeRow(row) || noticeWasPatched;
    }
    const chat = g.__tracelineChat;
    if (chat && !chat.__tracelineCachePatched) {
      installContainerCacheHooks(renderCache, chat, topologyChanged, adoptNoticeRow);
      containerWasPatched = true;
    }
  } catch {
    return false;
  }
  return containerWasPatched || noticeWasPatched || (!toolWasPatched && currentPatchInstalled()) ||
    (!assistantWasPatched && assistantPatchInstalled());
}

// Legacy test/dev access, not a public API. Entries only shrink (docs/testing.md).
export const internals = {
  // Legacy row-grammar fixtures.
  inkBashBody: (body: string, comp?: ToolRowDataLike) =>
    fitBashLines(currentTheme(), verbTone(comp), body, Number.POSITIVE_INFINITY).first,
  toolFactSuffix,
  configureSizeThresholds,
  toolStatus,
  oneLine: (comp: ToolRowLike, width: number) => rowLines(comp, width)[0]!,
  renderTraceRow,
  patchToolRowPrototype,
  patchAssistantRowPrototype,
  isExpandedToolRow,
  statusTone,
  foldedReadLines,
  // repetition folding + preamble reclaim + thinking-label preview/dedupe (issue #14)
  readRun,
  // typed test/dev accessors for traceline's Pi seam globals
  setTracelineChat: (chat: ContainerLike | undefined) => { g.__tracelineChat = chat; },
  setTracelineThemeGetter: (getTheme: (() => Theme | undefined) | undefined) => { g.__tracelineGetTheme = getTheme; },
  uncachedRenderTraceRow: (row: ToolRowLike, width: number) =>
    renderCache.withoutCache(() => renderTraceRow(row, width)),
  renderCacheWorkCounts: (reset = false) => renderCache.workCounts(reset),
  resetRenderCache: () => renderCache.reset(),
};

export default function piTraceline(pi: ExtensionAPI) {
  const config: TracelineConfig = Object.assign({}, ...configPaths("pi-traceline", process.cwd()).map(
    (path) => readJsonConfig(path, parseTracelineConfig) ?? {},
  ));
  let patchTimer: ReturnType<typeof setTimeout> | undefined;
  const tuiOwner = createTracelineTuiOwner();
  let inputUnsubscribe: (() => void) | undefined;
  const schedulePatches = () => {
    if (!g.__tracelineTui || patchTimer) return;
    patchTimer = setTimeout(() => {
      patchTimer = undefined;
      if (tryPatch()) g.__tracelineTui?.requestRender();
    }, 0);
  };
  const clearPatchTimer = () => {
    if (patchTimer) clearTimeout(patchTimer);
    patchTimer = undefined;
  };
  // Drill mode (§9.13) lives in drill.ts / drill-pager.ts; this host hands it just the
  // render internals it needs. Entry points: a shortcut (alt+t by default, `drillKey`
  // in the family config to rebind) plus /drill for discoverability.
  const startDrill = (ctx: { ui: ExtensionUIContext; hasUI: boolean }) => {
    if (!ctx.hasUI) return;
    enterDrillMode({
      ui: ctx.ui,
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
        thinkingHidden() && ((readRun(comp)?.index ?? 0) > 0 || (repetitionRun(comp)?.index ?? 0) > 0),
      statusTone,
      // The pager is the fidelity surface (§9.13): every call, unfolded.
      ledgerLines: (comp, width) => {
        const composed = composedFacts(comp);
        return composed && composed.calls.length > 0 ? ledgerLines(currentTheme(), comp, composed, width, sizeThresholds, false) : [];
      },
    });
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
    if (tuiOwner.owns() && ctx.mode === "tui" && (event.message.role === "assistant" || event.message.role === "custom")) schedulePatches();
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
    g.__tracelineChat = undefined;
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
      return handleThinkingToggleTerminalInput(data, ctx.ui, chatChildren, () => {
        const patched = tryPatch();
        const suppressed = suppressThinkingToggleStatus(chatChildren());
        if (patched || suppressed) g.__tracelineTui?.requestRender();
      });
    });
  });

  // Vocabulary layers (§9.10) and summaries (§9.15) start after the claim above; a new
  // vocabulary or a gist that arrives re-renders every row.
  const rerender = () => { renderCache.reset(); g.__tracelineTui?.requestRender(); };
  installVocabulary(pi, tuiOwner.owns, rerender);
  installSummaries(pi, tuiOwner.owns, rerender);
  pi.on("session_shutdown", () => {
    if (!tuiOwner.release()) return;
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    clearPatchTimer();
    clearWriteCallSnapshots();
    resetRevealedFolds();
    exitDrillMode(); // restores the editor when shutdown interrupts drill mode
    g.__tracelineTui = undefined;
    g.__tracelineChat = undefined;
    g.__tracelineGetTheme = undefined;
  });
}
