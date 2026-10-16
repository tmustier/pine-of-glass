// The composed row's ledger (design language §9.14): one line per nested call under the
// parent, folded per §9.9, each in its tool's grammar with outcome facts in the suffix.
// Pure functions of theme, row data and width; the z0 body and the shared ink helpers
// live in nested-rows.ts, parsing in nested-calls.ts, the reveal default in index.ts.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_lib/ansi.ts";
import type { ToolRowDataLike } from "../_lib/chat.ts";
import { compactCount, formatLatency } from "../_lib/fmt.ts";
import {
  ELLIPSIS,
  GLYPH,
  SEP,
  ink,
  middleTruncate,
  rightAlignSuffix,
  sizeTone,
  tildify,
  type SizeThresholds,
  type Tone,
} from "../_lib/style.ts";
import { fitBashLines } from "./bash-lines.ts";
import { relativizeContextCd } from "./bash-preamble.ts";
import { failureFact, failureFactWidth } from "./failure.ts";
import type { ComposedFacts, NestedCall } from "./nested-calls.ts";
import { PATH_VERBS, bold, dim, flattenCommand, nameInk, pathInk } from "./nested-rows.ts";
import { cwdRelativePath, readDirKey } from "./path-rows.ts";

const STATUS_TONES = { ok: "success", error: "error", running: "running", cancelled: "dim" } as const;
const CHAR_SUFFIX_FLOOR = 100;
/** A ledger duration under this is ambient chrome, not a fact (agent-default, not a user rule: 2026-09-30). */
const DURATION_FLOOR_MS = 100;

const LEDGER_INDENT = "  ";
const LEDGER_NEST = "   "; // one gutter deeper than the parent's `› `
const LEDGER_RIGHT_MARGIN = 2;
const LEDGER_PREFIX_WIDTH = LEDGER_INDENT.length + 1 + LEDGER_NEST.length + 1 + 1;
// A dir fold's continuation lines indent to the directory cell (after `read `), §9.9.
const FOLD_CONT_INDENT = "read ".length;
// A wrapped bash line's continuation lines indent to the command column (after `$ `), §9.8.
const BASH_CONT_INDENT = "$ ".length;

/** One ledger line's worth of calls (§9.14): a single call, a dir or pagination fold of
 * consecutive reads, or a run of identical invocations. */
export type LedgerEntry =
  | { kind: "call"; calls: [NestedCall] }
  | { kind: "reads"; calls: [NestedCall, ...NestedCall[]] }
  | { kind: "repeat"; calls: [NestedCall, ...NestedCall[]] };

// The invocation text a repetition folds on (§9.9): the visible body, arguments included.
function invocationKey(row: ToolRowDataLike, call: NestedCall): string {
  return `${call.name}\u0000${stripAnsi(plainBody(undefined, row, call, "text"))}`;
}

/** Group a ledger's calls into lines: only healthy calls fold, and only with their
 * immediate neighbours, so the ledger never reorders the record (§9.9, §9.14). A read
 * whose live result reached warning severity keeps its own line and splits the run. */
export function ledgerEntries(row: ToolRowDataLike, facts: ComposedFacts, warningChars: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const call of facts.calls) {
    const last = entries[entries.length - 1];
    const ballooned = call.resultChars !== undefined && call.resultChars >= warningChars;
    const foldable = call.status === "ok" && !ballooned;
    if (foldable && last && last.calls[0].status === "ok" && !(last.kind === "call" && last.calls[0].resultChars !== undefined && last.calls[0].resultChars >= warningChars)) {
      if (last.kind !== "repeat" && call.name === "read" && call.args.path !== undefined && last.calls[0].name === "read" &&
        last.calls[0].args.path !== undefined && readDirKey(call.args.path) === readDirKey(last.calls[0].args.path)) {
        entries[entries.length - 1] = { kind: "reads", calls: [...last.calls, call] };
        continue;
      }
      if (last.kind !== "reads" && call.name !== "read" && invocationKey(row, call) === invocationKey(row, last.calls[0])) {
        entries[entries.length - 1] = { kind: "repeat", calls: [...last.calls, call] };
        continue;
      }
    }
    entries.push({ kind: "call", calls: [call] });
  }
  return entries;
}

// A call's body without fitting: the tool's grammar, no outcome cells.
function plainBody(theme: Theme | undefined, row: ToolRowDataLike, call: NestedCall, tone: Tone): string {
  const command = call.name === "bash" ? call.args.command : undefined;
  if (command !== undefined) return `${bold(theme, tone, "$")} ${dim(theme, bashText(row, command))}`;
  if (PATH_VERBS.has(call.name) && call.args.path !== undefined) {
    return `${bold(theme, tone, call.name)} ${pathInk(theme, tone, row, call.args.path, call.name === "read" ? call.args.range ?? "" : "")}`;
  }
  const args = call.args.text;
  return args && args !== "{}" ? `${nameInk(theme, call.name, tone)} ${dim(theme, args)}` : nameInk(theme, call.name, tone);
}

// A ledger bash line's text: flattened, tildified, and its leading `cd` relative to the
// parent's cwd (§9.4), so a worktree path reads `./.worktrees/x`.
function bashText(row: ToolRowDataLike, command: string): string {
  const cwd = typeof row.cwd === "string" && row.cwd.length > 0 ? tildify(row.cwd) : undefined;
  return relativizeContextCd(flattenCommand(command), cwd);
}

type LedgerLine = { ink: string; continuations: string[]; suffix: string; bullet: string; contIndent: number };

// The error text a nested failure fact is read from: the live result when this
// session observed it, else codemode's capped preview (§9.14).
function nestedFailureCell(theme: Theme | undefined, call: NestedCall, available: number): string {
  if (call.status !== "error" || !call.error) return "";
  const fact = failureFact(call.name, call.error, call.args.command);
  if (!fact) return "";
  const inked = ink(theme, "error", fact.text);
  return fact.parsed ? inked : middleTruncate(inked, failureFactWidth(available), theme);
}

function sizeCell(theme: Theme | undefined, chars: number | undefined, thresholds: SizeThresholds, columnLive: boolean): string {
  if (chars === undefined || (chars < CHAR_SUFFIX_FLOOR && !columnLive)) return "";
  return ink(theme, sizeTone(chars, thresholds), `${compactCount(chars)} ch`);
}

// A single call's suffix: outcome (failure fact or `cancelled`), duration, then what
// it pulled; a failed call's size cell gives way to its fact below warning severity
// (§9.2.1). A fold sums its live sizes and drops its duration: nested calls run
// concurrently, so a sum is a number no event reported (§10.1).
function entrySuffix(theme: Theme | undefined, entry: LedgerEntry, thresholds: SizeThresholds, columnLive: boolean, available: number): string {
  const cells: string[] = [];
  if (entry.kind === "call") {
    const [call] = entry.calls;
    const failure = nestedFailureCell(theme, call, available);
    if (failure) cells.push(failure);
    else if (call.status === "cancelled") cells.push(dim(theme, "cancelled"));
    if (call.durationMs !== undefined && call.durationMs >= DURATION_FLOOR_MS) cells.push(dim(theme, formatLatency(call.durationMs)));
    if (call.imageFact) cells.push(dim(theme, call.imageFact));
    else if (!failure || (call.resultChars !== undefined && call.resultChars >= thresholds.warning)) {
      cells.push(sizeCell(theme, call.resultChars, thresholds, columnLive));
    }
  } else {
    const sizes = entry.calls.map((call) => call.resultChars).filter((chars): chars is number => chars !== undefined);
    cells.push(sizeCell(theme, sizes.length ? sizes.reduce((a, b) => a + b, 0) : undefined, thresholds, columnLive));
  }
  return cells.filter((cell) => cell.length > 0).join(dim(theme, SEP));
}

/** A body laid out in lines: the first beside the bullet, continuations indented to its cell. */
type FoldBody = { ink: string; continuations: string[] };

// A dir or pagination fold's cells (§9.9): one paged file merges its ranges; sibling
// files list their basenames after the directory printed once.
function readFoldBody(theme: Theme | undefined, row: ToolRowDataLike, calls: readonly NestedCall[], budget: number, contBudget: number): FoldBody {
  const paths = calls.map((call) => call.args.path!);
  const tone: Tone = "text";
  if (new Set(paths).size === 1) {
    const ranges = calls.map((call) => (call.args.range ?? "").slice(1)).filter(Boolean).join(",");
    return { ink: `${bold(theme, tone, "read")} ${pathInk(theme, tone, row, paths[0]!, ranges ? `:${ranges}` : "")}`, continuations: [] };
  }
  const shown = cwdRelativePath(row, paths[0]!);
  const dir = shown.slice(0, shown.lastIndexOf("/") + 1);
  // Bare cwd-relative names share the empty directory key; the verb then stands alone.
  const head = dir
    ? { ink: `${bold(theme, tone, "read")} ${dim(theme, dir)}`, plain: `read ${dir}` }
    : { ink: bold(theme, tone, "read"), plain: "read" };
  // Adjacent same-file calls merge their ranges first.
  const groups: { base: string; ranges: string[] }[] = [];
  for (const call of calls) {
    const base = call.args.path!.slice(call.args.path!.lastIndexOf("/") + 1);
    const range = (call.args.range ?? "").slice(1);
    const last = groups[groups.length - 1];
    if (last && last.base === base) {
      if (range) last.ranges.push(range);
    } else groups.push({ base, ranges: range ? [range] : [] });
  }
  const cells = groups.map((group) => {
    const range = group.ranges.length ? `:${group.ranges.join(",")}` : "";
    return { ink: `${bold(theme, tone, group.base)}${ink(theme, "warning", range)}`, plain: `${group.base}${range}` };
  });
  // Pack at file boundaries (§9.9); a wrapped line keeps its trailing dim comma.
  type Line = { ink: string; plain: string; continuation: boolean; hasCell: boolean };
  const lines: Line[] = [];
  let cur: Line = { ink: head.ink, plain: head.plain, continuation: false, hasCell: false };
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const sepPlain = cur.hasCell ? ", " : " ";
    const lineBudget = cur.continuation ? contBudget : budget;
    const commaRoom = i < cells.length - 1 ? 1 : 0;
    const fits = visibleWidth(cur.plain) + sepPlain.length + visibleWidth(cell.plain) + commaRoom <= lineBudget;
    if (fits || (cur.continuation && !cur.hasCell)) {
      cur.ink += `${cur.hasCell ? dim(theme, ", ") : " "}${cell.ink}`;
      cur.plain += `${sepPlain}${cell.plain}`;
      cur.hasCell = true;
      continue;
    }
    if (cur.hasCell) {
      cur.ink += dim(theme, ",");
      cur.plain += ",";
    }
    lines.push(cur);
    cur = { ink: cell.ink, plain: cell.plain, continuation: true, hasCell: true };
  }
  lines.push(cur);
  return { ink: lines[0]!.ink, continuations: lines.slice(1).map((line) => line.ink) };
}

function entryLine(
  theme: Theme | undefined,
  row: ToolRowDataLike,
  entry: LedgerEntry,
  suffix: string,
  budget: number,
  wrap: boolean,
): LedgerLine {
  const [first] = entry.calls;
  if (entry.kind === "reads") {
    const fold = readFoldBody(theme, row, entry.calls, budget, wrap ? Math.max(1, budget - FOLD_CONT_INDENT) : Number.POSITIVE_INFINITY);
    return { ink: fold.ink, continuations: wrap ? fold.continuations : [], suffix, bullet: ink(theme, "success", GLYPH.tool), contIndent: FOLD_CONT_INDENT };
  }
  const tone: Tone = first.status === "error" ? "error" : first.status === "cancelled" ? "dim" : "text";
  const count = entry.kind === "repeat" ? ` ${dim(theme, `×${entry.calls.length}`)}` : "";
  const command = first.name === "bash" ? first.args.command : undefined;
  if (command !== undefined) {
    const text = bashText(row, command);
    const countWidth = entry.kind === "repeat" ? ` ×${entry.calls.length}`.length : 0;
    const lines = fitBashLines(theme, tone, text, budget - BASH_CONT_INDENT - countWidth, wrap ? budget - BASH_CONT_INDENT : undefined);
    return {
      ink: `${bold(theme, tone, "$")} ${lines.first}${count}`,
      continuations: lines.continuations,
      suffix,
      bullet: ink(theme, STATUS_TONES[first.status], GLYPH.tool),
      contIndent: BASH_CONT_INDENT,
    };
  }
  return { ink: `${plainBody(theme, row, first, tone)}${count}`, continuations: [], suffix, bullet: ink(theme, STATUS_TONES[first.status], GLYPH.tool), contIndent: 0 };
}

/** The ledger's lines: one per entry, folded per §9.9 when `fold` is set (the pager
 * passes false and shows every call), indented under the parent, sharing one body
 * budget and one right edge (§9.14, §9.8). Dir folds wrap at file boundaries and bash
 * lines at command boundaries onto rail-only continuation lines. */
export function ledgerLines(
  theme: Theme | undefined,
  row: ToolRowDataLike,
  facts: ComposedFacts,
  width: number,
  thresholds: SizeThresholds,
  fold = true,
): string[] {
  const available = Math.max(1, width - LEDGER_PREFIX_WIDTH - LEDGER_RIGHT_MARGIN);
  const entries: LedgerEntry[] = fold ? ledgerEntries(row, facts, thresholds.warning) : facts.calls.map((call) => ({ kind: "call", calls: [call] }));
  const sizeColumnLive = facts.calls.some((call) => call.resultChars !== undefined && call.resultChars >= CHAR_SUFFIX_FLOOR);
  const suffixes = entries.map((entry) => entrySuffix(theme, entry, thresholds, sizeColumnLive, available));
  const widest = Math.max(0, ...suffixes.map((suffix) => visibleWidth(suffix)));
  const reserve = widest > 0 ? widest + 2 : 0;
  const bodyBudget = Math.max(1, available - reserve);
  const rail = dim(theme, GLYPH.rail);
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const line = entryLine(theme, row, entry, suffixes[index]!, bodyBudget, fold);
    const prefix = `${LEDGER_INDENT}${rail}${LEDGER_NEST}${line.bullet} `;
    const fitted = rightAlignSuffix(line.ink, line.suffix, available, theme, reserve);
    lines.push(truncateToWidth(`${prefix}${fitted}`, Math.max(1, width), ELLIPSIS));
    const contPrefix = `${LEDGER_INDENT}${rail}${" ".repeat(LEDGER_NEST.length + 2 + line.contIndent)}`;
    const contBudget = Math.max(1, bodyBudget - line.contIndent);
    for (const text of line.continuations) {
      lines.push(truncateToWidth(`${contPrefix}${middleTruncate(text, contBudget, theme)}`, Math.max(1, width), ELLIPSIS));
    }
  });
  if (!facts.complete) {
    lines.push(truncateToWidth(`${LEDGER_INDENT}${rail}${LEDGER_NEST}  ${dim(theme, "record incomplete: pi dropped calls or arguments past its cap")}`, Math.max(1, width), ELLIPSIS));
  }
  return lines;
}
