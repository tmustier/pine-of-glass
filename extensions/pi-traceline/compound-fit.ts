// Fit compound bash rows by command (§9.8). Return source ranges so styling can
// reuse the original crowns without parsing truncated shell text.

import type { BashHead } from "./bash-crowns.ts";

/** A command head, optionally protected because it produced a record. */
export type FitHead = Omit<BashHead, "cls"> & { earned?: boolean };

/** A kept source range, followed by a dim elision mark when `mark` is set. */
export type FitPiece = { start: number; end: number; mark?: string };

const CUT_MARK = "\u2026"; // …

// A cut that saves fewer columns than this renders whole instead: `cd …projects/repo`
// for `cd ~/projects/repo` costs an ellipsis to save one column.
const MIN_CUT_SAVING = 4; // agent-default (not a user rule): 2026-10-15

// A command cut below this many columns is a crown with no story (§9.8); the row wraps
// instead. agent-default (not a user rule): 2026-10-20
const COMMAND_FLOOR_COLS = 24;
// Wrapped rows stop here; the remainder packs onto the last line by command (§9.8).
// agent-default (not a user rule): 2026-10-20
const WRAP_LINE_CAP = 4;

// The connector run that ends a command before the next crowned head: whitespace,
// sequencers, flattened line breaks, pipes and opening group brackets. It belongs to
// the tail, so a cut command drops it along with its arguments.
const TRAILING_CONNECTOR = /(?:\s|&&|\|\||;|\u21b5|\||\(|\{)*$/;

// git's global options sit between `git` and its subcommand. A cut command folds them
// to `…` so the subcommand survives (§9.8). Options listed in VALUE take the next token.
const GIT_GLOBAL_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const GIT_GLOBAL_FLAG = /^(?:--no-pager|-P|-p|--paginate|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--(?:git-dir|work-tree|namespace|exec-path|config-env)=\S*)$/;

type Unit = {
  start: number;
  end: number; // full source range, trailing connector included
  contentEnd: number;
  floor: number;
} & (
  | { kind: "prefix"; lead: number }
  // Cuts start at the shell word; record protection counts from the head inside it.
  | { kind: "command"; last: boolean; earned: boolean; cutFrom: number; word: number; skip?: { start: number; end: number } }
);

// One shell word at `i`, quote-aware; returns its end.
function wordEnd(body: string, i: number, limit: number): number {
  let quote: "'" | '"' | undefined;
  while (i < limit) {
    const ch = body[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") i++;
    else if (/\s/.test(ch)) break;
    i++;
  }
  return Math.min(i, limit);
}

// Cuts drop leading assignments and replace git's global options with ` …`.
function cutContentLength(unit: Unit): number {
  const length = unit.contentEnd - (unit.kind === "command" ? unit.cutFrom : unit.start);
  return unit.kind === "command" && unit.skip ? length - (unit.skip.end - unit.skip.start) + 2 : length;
}

function fullWidth(unit: Unit): number {
  return unit.end - unit.start;
}

// The width of a unit that keeps `keep` content chars. A command that keeps all of its
// content renders whole; a cut command adds `… ` (the last one just `…`). A cut prefix
// keeps its lead and tail around one `…` and keeps its connector.
function unitWidth(unit: Unit, keep: number): number {
  const content = cutContentLength(unit);
  const full = fullWidth(unit);
  if (keep >= content) return full;
  const cut = unit.kind === "prefix" ? keep + 1 + (unit.end - unit.contentEnd) : keep + (unit.last ? 1 : 2);
  return cut > full - MIN_CUT_SAVING ? full : cut;
}

// The leading context gives first (§9.8): it sits at its floor while commands share
// the level, and only regains width from what the commands leave over.
function totalWidth(units: Unit[], level: number): number {
  let total = 0;
  for (const unit of units) total += unitWidth(unit, unit.kind === "prefix" ? unit.floor : Math.max(level, unit.floor));
  return total;
}

// A cut must not split a surrogate pair.
function safeCut(body: string, index: number): number {
  const code = body.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function pieces(body: string, unit: Unit, keep: number): FitPiece[] {
  if (unitWidth(unit, keep) >= fullWidth(unit)) return [{ start: unit.start, end: unit.end }];
  if (unit.kind === "prefix") {
    const tail = Math.max(0, keep - unit.lead);
    return [
      { start: unit.start, end: safeCut(body, unit.start + unit.lead), mark: CUT_MARK },
      { start: safeCut(body, unit.contentEnd - tail), end: unit.end },
    ];
  }
  const mark = unit.last ? CUT_MARK : `${CUT_MARK} `;
  if (!unit.skip) return [{ start: unit.cutFrom, end: safeCut(body, unit.cutFrom + keep), mark }];
  const headLength = unit.skip.start - unit.cutFrom;
  const rest = keep - headLength - 2;
  return [
    { start: unit.cutFrom, end: unit.skip.start, mark: ` ${CUT_MARK}` },
    { start: unit.skip.end, end: safeCut(body, unit.skip.end + rest), mark },
  ];
}

function buildUnits(body: string, heads: readonly FitHead[]): Unit[] {
  const units: Unit[] = [];
  const first = heads[0]!.from;
  if (first > 0) {
    const text = body.slice(0, first);
    const contentEnd = first - TRAILING_CONNECTOR.exec(text)![0].length;
    const space = text.search(/\s/);
    const lead = space > 0 && space < 8 && space < contentEnd ? space + 1 : Math.min(3, contentEnd);
    // A cut context keeps its opening word and its final path segment (`cd …/fix`),
    // or about ten chars when that segment is missing or very long.
    const slash = text.lastIndexOf("/", contentEnd - 1);
    const finalSegment = slash >= lead && contentEnd - slash <= 32 ? contentEnd - slash : 10; // agent-default (not a user rule): 2026-10-15
    units.push({ kind: "prefix", start: 0, end: first, contentEnd, floor: Math.min(contentEnd, lead + finalSegment), lead });
  }
  heads.forEach((head, index) => {
    const end = index + 1 < heads.length ? heads[index + 1]!.from : body.length;
    const text = body.slice(head.from, end);
    const last = index === heads.length - 1;
    const contentEnd = end - (last ? /\s*$/.exec(text)![0].length : TRAILING_CONNECTOR.exec(text)![0].length);
    const unit: Unit = { kind: "command", start: head.from, end, contentEnd, floor: head.end - head.token, last, earned: head.earned === true, cutFrom: head.token, word: head.start };
    if (body.slice(head.start, head.end) === "git") {
      let i = head.end;
      let optionsEnd: number | undefined;
      while (i < contentEnd) {
        while (i < contentEnd && /\s/.test(body[i]!)) i++;
        if (i >= contentEnd) break;
        const end = wordEnd(body, i, contentEnd);
        const word = body.slice(i, end);
        if (GIT_GLOBAL_VALUE.has(word)) {
          i = end;
          while (i < contentEnd && /\s/.test(body[i]!)) i++;
          if (i >= contentEnd) break;
          i = optionsEnd = wordEnd(body, i, contentEnd);
        } else if (GIT_GLOBAL_FLAG.test(word)) {
          i = optionsEnd = end;
        } else {
          if (optionsEnd !== undefined) {
            unit.skip = { start: head.end, end: optionsEnd };
            unit.floor = head.end - head.token + 2 + end - optionsEnd;
          }
          break;
        }
      }
    }
    units.push(unit);
  });
  return units;
}

/** A by-command fit: the kept ranges, and whether any command was cut below the floor. */
export type CompoundFit = { pieces: FitPiece[]; starved: boolean };

// A body fits by unit when it has two crowned heads, or one behind a leading context
// (§9.8): the context is the cuttable unit, and the single middle cut must not land on
// the command because a `cd` spent the budget.
function fitsByUnit(heads: readonly FitHead[]): boolean {
  return heads.length >= 2 || (heads.length === 1 && heads[0]!.from > 0);
}

// A command that earned a record is never cut below the floor (§9.8): whole when shorter,
// so the headline's outcome keeps its command beside it. When even that leaves the others
// too little room, it shares the cut like any other.
function fitUnits(body: string, units: Unit[], budget: number): CompoundFit | undefined {
  const shielded = units.map((unit) => unit.kind === "command" && unit.earned
    ? { ...unit, floor: Math.max(unit.floor, Math.min(cutContentLength(unit), unit.word - unit.cutFrom + COMMAND_FLOOR_COLS)) }
    : unit);
  return waterFill(body, shielded, budget) ?? waterFill(body, units, budget);
}

function waterFill(body: string, units: Unit[], budget: number): CompoundFit | undefined {
  if (totalWidth(units, 0) > budget) return undefined;
  // Water-filling over the commands: the highest common keep level that fits. Short
  // commands render whole below it; long ones are cut back to it.
  let low = 0;
  let high = Math.max(...units.map(cutContentLength));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (totalWidth(units, mid) <= budget) low = mid;
    else high = mid - 1;
  }
  const keeps = units.map((unit) => (unit.kind === "prefix" ? unit.floor : Math.max(low, unit.floor)));
  // Hand leftover columns to cut units so the row ends flush: commands left to right,
  // the context last (§9.8).
  const order = [...units.keys()].sort((a, b) => Number(units[a]!.kind === "prefix") - Number(units[b]!.kind === "prefix"));
  let spare = budget - totalWidth(units, low);
  for (let progress = true; spare > 0 && progress;) {
    progress = false;
    for (const index of order) {
      const unit = units[index]!;
      const now = unitWidth(unit, keeps[index]!);
      if (spare <= 0 || now >= fullWidth(unit)) continue;
      const next = unitWidth(unit, keeps[index]! + 1);
      if (next - now > spare) continue;
      keeps[index]!++;
      spare -= next - now;
      progress = true;
    }
  }
  const starved = units.some((unit, index) =>
    unit.kind === "command" && unitWidth(unit, keeps[index]!) < fullWidth(unit) && keeps[index]! < COMMAND_FLOOR_COLS);
  return { pieces: units.flatMap((unit, index) => pieces(body, unit, keeps[index]!)), starved };
}

/**
 * Plan a by-command fit of a bash body into `budget` columns (§9.8). Returns undefined
 * when the body fits, when it has nothing to fit by unit, or when even bare heads
 * overflow; the caller then keeps the single middle cut.
 */
export function fitCompoundCommand(body: string, heads: readonly FitHead[], budget: number): CompoundFit | undefined {
  if (!fitsByUnit(heads) || body.length <= budget) return undefined;
  return fitUnits(body, buildUnits(body, heads), budget);
}

// A unit that ends a line keeps its connector but not the whitespace after it.
function trailingSpace(body: string, start: number, end: number): number {
  return /\s*$/.exec(body.slice(start, end))![0].length;
}

function lineEndWidth(body: string, unit: Unit): number {
  return fullWidth(unit) - trailingSpace(body, unit.start, unit.end);
}

function closeLine(body: string, line: FitPiece[]): FitPiece[] {
  const last = line[line.length - 1]!;
  return last.mark ? line : [...line.slice(0, -1), { start: last.start, end: last.end - trailingSpace(body, last.start, last.end) }];
}

/**
 * Plan a wrap of a bash body at command boundaries (§9.8): the first line has `budget`
 * columns, continuation lines `contBudget`, and at most WRAP_LINE_CAP lines. Units
 * pack whole onto lines; once the cap is reached, or a lone unit is wider than its
 * line, the remainder fits by command onto that line so every head still shows. Each
 * line's trailing whitespace is dropped. Returns undefined when the body fits on one
 * line or has nothing to wrap.
 */
export function wrapCompoundCommand(body: string, heads: readonly FitHead[], budget: number, contBudget: number): FitPiece[][] | undefined {
  if (!fitsByUnit(heads) || body.length <= budget) return undefined;
  const units = buildUnits(body, heads);
  const lines: FitPiece[][] = [];
  let line: FitPiece[] = [];
  let lineFrom = 0; // the first unit on the current line
  let used = 0;
  let lineBudget = budget;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!;
    // The context gives first (§9.8): a wrapping row's leading context is cut to its
    // floor when that lets the first command share its line; a context line that
    // would stand alone either way keeps its full path.
    const next = units[index + 1];
    if (unit.kind === "prefix" && next && fullWidth(unit) + lineEndWidth(body, next) > lineBudget &&
      unitWidth(unit, unit.floor) + lineEndWidth(body, next) <= lineBudget) {
      line.push(...pieces(body, unit, unit.floor));
      used += unitWidth(unit, unit.floor);
      continue;
    }
    if (used + lineEndWidth(body, unit) <= lineBudget) {
      line.push({ start: unit.start, end: unit.end });
      used += fullWidth(unit);
      continue;
    }
    if (line.length > 0 && lines.length < WRAP_LINE_CAP - 1) {
      lines.push(closeLine(body, line));
      line = [];
      lineFrom = index;
      used = 0;
      lineBudget = contBudget;
      if (lineEndWidth(body, unit) <= lineBudget) {
        line.push({ start: unit.start, end: unit.end });
        used += fullWidth(unit);
        continue;
      }
    }
    // The last allowed line, or a unit wider than a fresh line: fit the remainder by
    // command into what this line has left. A command behind a record still to come
    // (§9.8) buys more: the line's commands share it with the remainder, so they yield
    // to its floor, and a unit wider than a fresh line is cut on a line of its own,
    // ending `… &&` like any wrapped line.
    const rest = units.slice(index);
    const earnedAhead = rest.some((unit) => unit.kind === "command" && unit.earned);
    const fit = earnedAhead ? fitUnits(body, units.slice(lineFrom), lineBudget) : fitUnits(body, rest, lineBudget - used);
    let alone: FitPiece[] | undefined;
    if (earnedAhead && line.length === 0 && lines.length < WRAP_LINE_CAP - 1 && (!fit || fit.starved)) {
      // A unit cut to fill a line of its own keeps its connector at the end.
      const ending = { start: unit.contentEnd, end: unit.end - trailingSpace(body, unit.start, unit.end) };
      const own: Unit = unit.kind === "command" ? { ...unit, end: unit.contentEnd, last: true } : { ...unit, end: ending.end };
      const ownFit = fitUnits(body, [own], lineBudget - (unit.kind === "command" ? ending.end - ending.start : 0));
      alone = ownFit && (unit.kind === "command" ? [...ownFit.pieces, ending] : ownFit.pieces);
    }
    if (alone) {
      lines.push(alone);
      lineFrom = index + 1;
      lineBudget = contBudget;
      continue;
    }
    const kept = earnedAhead && fit ? fit.pieces : [...line, ...(fit ? fit.pieces : [{ start: rest[0]!.start, end: body.length }])];
    lines.push(closeLine(body, kept));
    return lines.length > 1 ? lines : undefined;
  }
  if (line.length > 0) lines.push(closeLine(body, line));
  return lines.length > 1 ? lines : undefined;
}
