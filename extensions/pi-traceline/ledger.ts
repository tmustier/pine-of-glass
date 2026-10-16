// The composed row's ledger (design language §9.14): one line per nested call under the
// parent, folded per §9.9, each in its tool's grammar with outcome facts in the suffix.
// Pure functions of theme, row data and width; the z0 body and the shared ink helpers
// live in nested-rows.ts, parsing in nested-calls.ts, the reveal default in index.ts.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
import { failureCell, failureFact } from "./failure.ts";
import type { ComposedFacts, NestedCall } from "./nested-calls.ts";
import { PATH_VERBS, bold, dim, flattenCommand, nameInk, pathInk } from "./nested-rows.ts";
import { cwdRelativePath, readDirKey } from "./path-rows.ts";
import { wrapReadCells } from "./read-fold.ts";

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
  | { kind: "reads" | "repeat"; calls: [NestedCall, NestedCall, ...NestedCall[]] };

/** Group a ledger's calls into lines: only healthy calls fold, and only with their
 * immediate neighbours, so the ledger never reorders the record (§9.9, §9.14). A read
 * whose live result reached warning severity keeps its own line and splits the run. */
export function ledgerEntries(facts: ComposedFacts, warningChars: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let previousKey: string | undefined;
  for (const call of facts.calls) {
    const healthy = call.status === "ok" && (call.resultChars === undefined || call.resultChars < warningChars);
    let key: string | undefined;
    if (healthy) key = call.name === "read" ? (call.args.path && `read\u0000${readDirKey(call.args.path)}`) : `${call.name}\u0000${call.args.text}`;
    const last = entries[entries.length - 1];
    if (last && key !== undefined && key === previousKey) {
      if (last.kind === "call") entries[entries.length - 1] = { kind: call.name === "read" ? "reads" : "repeat", calls: [last.calls[0], call] };
      else last.calls.push(call);
    } else entries.push({ kind: "call", calls: [call] });
    previousKey = key;
  }
  return entries;
}

type EntryBody = { body: string; continuations: string[]; contIndent: number };

// A dir fold's body (§9.9): `read dir/ a.md, b.md:1-40` wrapped at file boundaries, or,
// when every member read one file, that file with its ranges joined.
function readsBody(theme: Theme | undefined, row: ToolRowDataLike, calls: readonly NestedCall[], budget: number): EntryBody {
  const paths = calls.map((call) => call.args.path!);
  const rangeOf = (call: NestedCall) => (call.args.range ?? "").slice(1);
  if (new Set(paths).size === 1) {
    const ranges = calls.map(rangeOf).filter(Boolean).join(",");
    return { body: `${bold(theme, "text", "read")} ${pathInk(theme, "text", row, paths[0]!, ranges ? `:${ranges}` : "")}`, continuations: [], contIndent: FOLD_CONT_INDENT };
  }
  const shown = cwdRelativePath(row, paths[0]!);
  const dir = shown.slice(0, shown.lastIndexOf("/") + 1);
  const head = dir ? `${bold(theme, "text", "read")} ${dim(theme, dir)}` : bold(theme, "text", "read");
  const groups: { base: string; ranges: string[] }[] = [];
  for (const call of calls) {
    const base = call.args.path!.slice(call.args.path!.lastIndexOf("/") + 1);
    const range = rangeOf(call);
    const last = groups[groups.length - 1];
    if (last?.base === base) {
      if (range) last.ranges.push(range);
    } else groups.push({ base, ranges: range ? [range] : [] });
  }
  const cells = groups.map(({ base, ranges }) => `${bold(theme, "text", base)}${ink(theme, "warning", ranges.length ? `:${ranges.join(",")}` : "")}`);
  const [body, ...continuations] = wrapReadCells(theme, head, cells, budget, Math.max(1, budget - FOLD_CONT_INDENT));
  return { body, continuations, contIndent: FOLD_CONT_INDENT };
}

// One call's body in its tool's grammar, with `count` (a repeat's ` ×N`) after it. A bash
// body flattens, tildifies and reads its leading `cd` relative to the parent's cwd (§9.4),
// then fits by command or, when `wrap` allows, wraps onto continuation lines (§9.8).
function callBody(theme: Theme | undefined, row: ToolRowDataLike, call: NestedCall, tone: Tone, count: string, budget: number, wrap: boolean): EntryBody {
  const command = call.name === "bash" ? call.args.command : undefined;
  if (command !== undefined) {
    const cwd = typeof row.cwd === "string" && row.cwd.length > 0 ? tildify(row.cwd) : undefined;
    const text = relativizeContextCd(flattenCommand(command), cwd);
    const contBudget = budget - BASH_CONT_INDENT;
    const plan = fitBashLines(theme, tone, text, contBudget - count.length, wrap ? contBudget : undefined);
    return { body: `${bold(theme, tone, "$")} ${plan.first}${dim(theme, count)}`, continuations: plan.continuations, contIndent: BASH_CONT_INDENT };
  }
  let body: string;
  if (PATH_VERBS.has(call.name) && call.args.path !== undefined) {
    body = `${bold(theme, tone, call.name)} ${pathInk(theme, tone, row, call.args.path, call.name === "read" ? call.args.range ?? "" : "")}`;
  } else {
    const args = call.args.text;
    body = args && args !== "{}" ? `${nameInk(theme, call.name, tone)} ${dim(theme, args)}` : nameInk(theme, call.name, tone);
  }
  return { body: `${body}${dim(theme, count)}`, continuations: [], contIndent: 0 };
}

function sizeCell(theme: Theme | undefined, chars: number | undefined, thresholds: SizeThresholds, columnLive: boolean): string {
  if (chars === undefined || (chars < CHAR_SUFFIX_FLOOR && !columnLive)) return "";
  return ink(theme, sizeTone(chars, thresholds), `${compactCount(chars)} ch`);
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
  const entries: LedgerEntry[] = fold ? ledgerEntries(facts, thresholds.warning) : facts.calls.map((call) => ({ kind: "call", calls: [call] }));
  const sizeColumnLive = facts.calls.some((call) => call.resultChars !== undefined && call.resultChars >= CHAR_SUFFIX_FLOOR);
  const suffixes = entries.map((entry) => {
    const cells: string[] = [];
    if (entry.kind === "call") {
      const [call] = entry.calls;
      const fact = call.status === "error" && call.error ? failureFact(call.name, call.error, call.args.command) : undefined;
      const failure = fact ? failureCell(theme, fact, available) : "";
      if (failure) cells.push(failure);
      else if (call.status === "cancelled") cells.push(dim(theme, "cancelled"));
      if (call.durationMs !== undefined && call.durationMs >= DURATION_FLOOR_MS) cells.push(dim(theme, formatLatency(call.durationMs)));
      if (call.imageFact) cells.push(dim(theme, call.imageFact));
      else if (!failure || (call.resultChars !== undefined && call.resultChars >= thresholds.warning)) {
        cells.push(sizeCell(theme, call.resultChars, thresholds, sizeColumnLive));
      }
    } else {
      const sizes = entry.calls.map((call) => call.resultChars).filter((chars): chars is number => chars !== undefined);
      cells.push(sizeCell(theme, sizes.length ? sizes.reduce((a, b) => a + b, 0) : undefined, thresholds, sizeColumnLive));
    }
    return cells.filter((cell) => cell.length > 0).join(dim(theme, SEP));
  });
  const widest = Math.max(0, ...suffixes.map((suffix) => visibleWidth(suffix)));
  const reserve = widest > 0 ? widest + 2 : 0;
  const bodyBudget = Math.max(1, available - reserve);
  const rail = dim(theme, GLYPH.rail);
  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const [call] = entry.calls;
    const tone: Tone = call.status === "error" ? "error" : call.status === "cancelled" ? "dim" : "text";
    const count = entry.kind === "repeat" ? ` ×${entry.calls.length}` : "";
    const { body, continuations, contIndent } = entry.kind === "reads"
      ? readsBody(theme, row, entry.calls, bodyBudget)
      : callBody(theme, row, call, tone, count, bodyBudget, fold);
    const bullet = ink(theme, STATUS_TONES[call.status], GLYPH.tool);
    const prefix = `${LEDGER_INDENT}${rail}${LEDGER_NEST}${bullet} `;
    const fitted = rightAlignSuffix(body, suffixes[index]!, available, theme, reserve);
    lines.push(truncateToWidth(`${prefix}${fitted}`, Math.max(1, width), ELLIPSIS));
    const contPrefix = `${LEDGER_INDENT}${rail}${" ".repeat(LEDGER_NEST.length + 2 + contIndent)}`;
    const contBudget = Math.max(1, bodyBudget - contIndent);
    for (const text of continuations) {
      lines.push(truncateToWidth(`${contPrefix}${middleTruncate(text, contBudget, theme)}`, Math.max(1, width), ELLIPSIS));
    }
  });
  if (!facts.complete) {
    lines.push(truncateToWidth(`${LEDGER_INDENT}${rail}${LEDGER_NEST}  ${dim(theme, "record incomplete: pi dropped calls or arguments past its cap")}`, Math.max(1, width), ELLIPSIS));
  }
  return lines;
}
