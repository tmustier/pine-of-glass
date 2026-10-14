// Fitting a compound bash row by command (design language §9.8). A single middle cut
// keeps a long row's opening context and closing filter and drops the commands between
// them, which are why the row exists. This module plans a cut that keeps every crowned
// head instead. It is plain text in, source ranges out: index.ts inks the kept ranges
// with the crowns it already computed, so the shell grammar is never re-parsed on a
// string that has lost its closing quotes.

/** A crowned head word: a half-open range into the body. */
export type FitHead = { start: number; end: number };

/** A kept source range, followed by a dim elision mark when `mark` is set. */
export type FitPiece = { start: number; end: number; mark?: string };

const CUT_MARK = "\u2026"; // …

// A cut that saves fewer columns than this renders whole instead: `cd …projects/repo`
// for `cd ~/projects/repo` costs an ellipsis to save one column.
const MIN_CUT_SAVING = 4; // agent-default (not a user rule): 2026-10-15

// The connector run that ends a command before the next crowned head: whitespace,
// sequencers, flattened line breaks, pipes and opening group brackets. It belongs to
// the tail, so a cut command drops it along with its arguments.
const TRAILING_CONNECTOR = /(?:\s|&&|\|\||;|\u21b5|\||\(|\{)*$/;

// git's global options sit between `git` and its subcommand. A cut command folds them
// to `…` so the subcommand survives (§9.8). Options listed in VALUE take the next token.
const GIT_GLOBAL_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const GIT_GLOBAL_FLAG = /^(?:--no-pager|-P|-p|--paginate|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--(?:git-dir|work-tree|namespace|exec-path|config-env)=\S*)$/;

type Unit = {
  kind: "prefix" | "command";
  start: number;
  end: number; // full source range, trailing connector included
  contentEnd: number; // where the trailing connector starts
  floor: number; // content chars a cut always keeps
  lead: number; // prefix only: chars kept before the middle cut
  skip?: { start: number; end: number; headEnd: number }; // git global options
  last: boolean;
};

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

function gitSkip(body: string, headEnd: number, limit: number): { skip: Unit["skip"]; subEnd: number } | undefined {
  let i = headEnd;
  let optionsEnd: number | undefined;
  while (i < limit) {
    while (i < limit && /\s/.test(body[i]!)) i++;
    if (i >= limit) return undefined;
    const end = wordEnd(body, i, limit);
    const word = body.slice(i, end);
    if (GIT_GLOBAL_VALUE.has(word)) {
      let j = end;
      while (j < limit && /\s/.test(body[j]!)) j++;
      if (j >= limit) return undefined;
      i = optionsEnd = wordEnd(body, j, limit);
      continue;
    }
    if (GIT_GLOBAL_FLAG.test(word)) {
      i = optionsEnd = end;
      continue;
    }
    if (optionsEnd === undefined) return undefined;
    return { skip: { start: headEnd, end: optionsEnd, headEnd }, subEnd: end };
  }
  return undefined;
}

// Content length when the unit is cut: a git command loses its global options to a
// two-column ` …`; everything else counts its own source.
function cutContentLength(unit: Unit): number {
  const length = unit.contentEnd - unit.start;
  return unit.skip ? length - (unit.skip.end - unit.skip.start) + 2 : length;
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

function keepAt(unit: Unit, level: number): number {
  return Math.max(level, unit.floor);
}

function totalWidth(units: Unit[], level: number): number {
  let total = 0;
  for (const unit of units) total += unitWidth(unit, keepAt(unit, level));
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
  if (!unit.skip) return [{ start: unit.start, end: safeCut(body, unit.start + keep), mark }];
  const headLength = unit.skip.headEnd - unit.start;
  const rest = keep - headLength - 2;
  return [
    { start: unit.start, end: unit.skip.headEnd, mark: ` ${CUT_MARK}` },
    { start: unit.skip.end, end: safeCut(body, unit.skip.end + rest), mark },
  ];
}

function buildUnits(body: string, heads: readonly FitHead[]): Unit[] {
  const units: Unit[] = [];
  const first = heads[0]!.start;
  if (first > 0) {
    const text = body.slice(0, first);
    const contentEnd = first - (TRAILING_CONNECTOR.exec(text)?.[0].length ?? 0);
    const space = text.search(/\s/);
    const lead = space > 0 && space < 8 && space < contentEnd ? space + 1 : Math.min(3, contentEnd);
    // A cut context keeps its opening word and its final path segment (`cd …/fix`),
    // or about ten chars when that segment is missing or very long.
    const slash = text.lastIndexOf("/", contentEnd - 1);
    const finalSegment = slash >= lead && contentEnd - slash <= 32 ? contentEnd - slash : 10; // agent-default (not a user rule): 2026-10-15
    units.push({ kind: "prefix", start: 0, end: first, contentEnd, floor: Math.min(contentEnd, lead + finalSegment), lead, last: false });
  }
  heads.forEach((head, index) => {
    const end = index + 1 < heads.length ? heads[index + 1]!.start : body.length;
    const text = body.slice(head.start, end);
    const last = index === heads.length - 1;
    const contentEnd = end - (last ? (/\s*$/.exec(text)?.[0].length ?? 0) : (TRAILING_CONNECTOR.exec(text)?.[0].length ?? 0));
    const unit: Unit = { kind: "command", start: head.start, end, contentEnd, floor: head.end - head.start, lead: 0, last };
    if (body.slice(head.start, head.end) === "git") {
      const git = gitSkip(body, head.end, contentEnd);
      if (git) {
        unit.skip = git.skip;
        // keep `git … <subcommand>` at the least
        unit.floor = head.end - head.start + 2 + (git.subEnd - git.skip!.end);
      }
    }
    units.push(unit);
  });
  return units;
}

/**
 * Plan a by-command fit of a compound bash body into `budget` columns (§9.8). Returns
 * undefined when the body fits, when it has fewer than two crowned heads, or when even
 * bare heads overflow; the caller then keeps the single middle cut.
 */
export function fitCompoundCommand(body: string, heads: readonly FitHead[], budget: number): FitPiece[] | undefined {
  if (heads.length < 2 || body.length <= budget) return undefined;
  const units = buildUnits(body, heads);
  if (totalWidth(units, 0) > budget) return undefined;
  // Water-filling: the highest common keep level that fits. Short commands render whole
  // below it; long ones are cut back to it.
  let low = 0;
  let high = Math.max(...units.map(cutContentLength));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (totalWidth(units, mid) <= budget) low = mid;
    else high = mid - 1;
  }
  const keeps = units.map((unit) => keepAt(unit, low));
  // Hand leftover columns to cut units, left to right, so the row ends flush.
  let spare = budget - totalWidth(units, low);
  for (let progress = true; spare > 0 && progress;) {
    progress = false;
    units.forEach((unit, index) => {
      const now = unitWidth(unit, keeps[index]!);
      if (spare <= 0 || now >= fullWidth(unit)) return;
      const next = unitWidth(unit, keeps[index]! + 1);
      if (next - now > spare) return;
      keeps[index]!++;
      spare -= next - now;
      progress = true;
    });
  }
  return units.flatMap((unit, index) => pieces(body, unit, keeps[index]!));
}
