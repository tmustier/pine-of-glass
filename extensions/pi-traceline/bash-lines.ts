// Bash body ink and line fitting (design language §9.3, §9.4, §9.8): crowns bold in the
// row's discriminator tone, everything else at the one supporting grey, and a body that
// overflows its budget fitted by command or wrapped at command boundaries. Shared by the
// top-level bash row (index.ts) and the composed ledger (ledger.ts).
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ink, type Tone } from "../_lib/style.ts";
import { bashCrownedHeads, type BashHead } from "./bash-crowns.ts";
import { fitCompoundCommand, wrapCompoundCommand, type FitPiece } from "./compound-fit.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

// The kept ranges ink with the crowns computed on the whole body, so the shell grammar is
// never re-parsed on text that has lost its closing quotes. Everything between crowned
// head words dims in maximal spans, each crowned word takes the discriminator ink (§9.3;
// §9.2's error tint on failed rows), and each cut wears a dim `…`.
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

/**
 * A bash body laid out in lines: the first beside the `$`, continuations at the command
 * column. `overflow`: the body is wider than its first line, so it was cut or wrapped.
 */
export type BashLines = { first: string; continuations: string[]; overflow: boolean };

/**
 * Fit a bash body (the text after `$ `) into `budget` columns (§9.8). A body that fits
 * renders whole. One that overflows fits by command; when that would starve a command
 * and `contBudget` is given, it wraps at command boundaries instead, continuation
 * lines taking `contBudget` columns each. A body nothing can fit is returned whole for
 * the caller's single middle cut.
 */
export function fitBashLines(theme: Theme | undefined, tone: Tone, body: string, budget: number, contBudget?: number): BashLines {
  const crowns = bashCrownedHeads(body);
  const whole: FitPiece[] = [{ start: 0, end: body.length }];
  const fit = body.length > budget ? fitCompoundCommand(body, crowns, budget) : undefined;
  const wrapped = contBudget !== undefined && body.length > budget && (!fit || fit.starved)
    ? wrapCompoundCommand(body, crowns, budget, contBudget)
    : undefined;
  const [first, ...continuations] = (wrapped ?? [fit?.pieces ?? whole]).map((pieces) => inkPieces(theme, tone, body, crowns, pieces));
  return { first: first!, continuations, overflow: visibleWidth(body) > budget };
}
