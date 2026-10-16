// Bash body ink and line fitting (design language §9.3, §9.4, §9.8): crowns bold in the
// row's discriminator tone, everything else at the one supporting grey, and a body that
// overflows its budget fitted by command or wrapped at command boundaries. Shared by the
// top-level bash row (index.ts) and the composed ledger (ledger.ts).
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ink, type Tone } from "../_lib/style.ts";
import { bashCrownedHeads, type BashHead } from "./bash-crowns.ts";
import { fitCompoundCommand, wrapCompoundCommand, type FitPiece } from "./compound-fit.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

// Emission splices the crowns into dim runs: everything between crowned head words
// (arguments, operators, marks, quoted scripts, demoted glue) dims in maximal spans, and
// each crowned word takes the discriminator ink (§9.3; §9.2's error tint on failed rows).
export function inkBashBody(theme: Theme | undefined, tone: Tone, body: string): string {
  return inkPieces(theme, tone, body, bashCrownedHeads(body), [{ start: 0, end: body.length }]);
}

// The kept ranges ink with the crowns computed on the whole body, so the shell grammar is
// never re-parsed on text that has lost its closing quotes; each cut wears a dim `…`.
function inkPieces(theme: Theme | undefined, tone: Tone, body: string, crowns: readonly BashHead[], pieces: readonly FitPiece[]): string {
  let out = "";
  for (const piece of pieces) {
    let cursor = piece.start;
    for (const crown of crowns) {
      if (crown.start < piece.start || crown.end > piece.end) continue;
      if (crown.start > cursor) out += ink(theme, "dim", body.slice(cursor, crown.start));
      out += ink(theme, tone, `${BOLD}${body.slice(crown.start, crown.end)}${BOLD_OFF}`);
      cursor = crown.end;
    }
    if (cursor < piece.end) out += ink(theme, "dim", body.slice(cursor, piece.end));
    if (piece.mark) out += ink(theme, "dim", piece.mark);
  }
  return out;
}

/** A bash body laid out in lines: the first beside the `$`, continuations at the command column. */
export type BashLines = { first: string; continuations: string[] };

/**
 * Fit a bash body (the text after `$ `) into `budget` columns (§9.8). A body that fits
 * renders whole. One that overflows fits by command; when that would starve a command
 * and `contBudget` is given, it wraps at command boundaries instead, continuation
 * lines taking `contBudget` columns each. A body nothing can fit is returned whole for
 * the caller's single middle cut.
 */
export function fitBashLines(theme: Theme | undefined, tone: Tone, body: string, budget: number, contBudget?: number): BashLines {
  const crowns = bashCrownedHeads(body);
  if (body.length <= budget) return { first: inkPieces(theme, tone, body, crowns, [{ start: 0, end: body.length }]), continuations: [] };
  const fit = fitCompoundCommand(body, crowns, budget);
  if (contBudget !== undefined && (!fit || fit.starved)) {
    const wrapped = wrapCompoundCommand(body, crowns, budget, contBudget);
    if (wrapped) {
      const [first, ...rest] = wrapped.map((pieces) => {
        const last = pieces[pieces.length - 1]!;
        if (!last.mark) last.end -= /\s*$/.exec(body.slice(last.start, last.end))![0].length;
        return inkPieces(theme, tone, body, crowns, pieces);
      });
      return { first: first!, continuations: rest };
    }
  }
  const pieces = fit ? fit.pieces : [{ start: 0, end: body.length }];
  return { first: inkPieces(theme, tone, body, crowns, pieces), continuations: [] };
}
