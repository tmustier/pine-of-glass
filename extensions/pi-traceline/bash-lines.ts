// Bash body ink and line fitting (design language §9.3, §9.4, §9.8): crowns bold in the
// row's discriminator tone, everything else at the one supporting grey, and a body that
// overflows its budget fitted by command or wrapped at command boundaries. Shared by the
// top-level bash row (index.ts) and the composed ledger (ledger.ts).
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ink, tildify, type Tone } from "../_lib/style.ts";
import { bashCrownedHeads } from "./bash-crowns.ts";
import { fitCompoundCommand, wrapCompoundCommand, type FitHead, type FitPiece } from "./compound-fit.ts";
import { commandKey, readShell } from "./record-shell.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

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
 * the caller's single middle cut. `earned`: keys of the commands that earned the row's
 * records, which are never cut below the floor.
 */
export function fitBashLines(theme: Theme | undefined, tone: Tone, body: string, budget: number, contBudget?: number, earned: readonly string[] = []): BashLines {
  const crowns = bashCrownedHeads(body);
  const whole: FitPiece[] = [{ start: 0, end: body.length }];
  let heads: FitHead[] = crowns;
  if (body.length > budget && earned.length > 0) {
    // Display-only normalization: raw record identities and the tildified body must
    // agree. Restore newlines and blank a folded preamble without moving offsets.
    const script = readShell(body.replaceAll("\u21b5", "\n").replace(/^\u22ef(?=\s)/, " "));
    const identities = new Set(earned.map(tildify));
    heads = [...crowns];
    for (const command of [...script.commands, ...script.nested]) {
      if (!identities.has(tildify(commandKey(command)))) continue;
      const { start, end } = command.head;
      const commandEnd = command.args.at(-1)?.end ?? end;
      // A fitting boundary is not a crown. Start protection at the producer, not
      // at an earlier rg or env whose slice happens to contain it. A conservative
      // crown inside this command (unquoted `PR_URL=$(gh …)` crowns `pr`) is replaced
      // only for fitting; the ink below still uses the original whole-body crowns.
      heads = heads.filter((head) => head.start < start || head.start >= commandEnd);
      heads.push({ start, end, earned: true });
    }
    heads.sort((a, b) => a.start - b.start);
  }
  const fit = body.length > budget ? fitCompoundCommand(body, heads, budget) : undefined;
  const wrapped = contBudget !== undefined && body.length > budget && (!fit || fit.starved)
    ? wrapCompoundCommand(body, heads, budget, contBudget)
    : undefined;
  // The kept ranges ink with the crowns computed on the whole body, so the shell grammar is
  // never re-parsed on text that has lost its closing quotes. Everything between crowned
  // head words dims in maximal spans, each crowned word takes the discriminator ink (§9.3;
  // §9.2's error tint on failed rows), and each cut wears a dim `…`.
  const [first, ...continuations] = (wrapped ?? [fit?.pieces ?? whole]).map((pieces) => {
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
  });
  return { first: first!, continuations, overflow: visibleWidth(body) > budget };
}
