// The outcome headline a bash row leads with (design language §9.10, §9.10.1): records
// of consequence and check facts, merged, capped and inked. Parsing lives in records.ts
// and checks.ts; this module turns their facts into the headline cells.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SEP, ink } from "../_lib/style.ts";
import type { CheckFact, CheckTone } from "./checks.ts";
import type { RecordFact, RecordTone } from "./records.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

export type RecordCellData = { verb: string; data: string[]; tone: RecordTone | CheckTone; opaque: boolean };

// Facts chain in output order; consecutive same-verb facts merge their data
// (`pushed main, v0.5.9`) and exact duplicates collapse. Merging also requires the
// tones to agree (§9.10): a forced push never hides inside a routine one.
// Check facts (§9.10.1) share the headline: they chain with records in output order
// and merge under the same rule; a pass wears neutral ink, never green.
export function mergeHeadlineFacts(records: RecordFact[], checks: CheckFact[]): RecordCellData[] {
  const merged: RecordCellData[] = [];
  const facts = [...records, ...checks.map((fact) => ({ ...fact, opaque: false }))].sort((a, b) => a.at - b.at);
  for (const fact of facts) {
    const last = merged[merged.length - 1];
    if (last && last.verb === fact.verb && last.tone === fact.tone) {
      if (!last.data.includes(fact.datum)) last.data.push(fact.datum);
    } else {
      merged.push({ verb: fact.verb, data: [fact.datum], tone: fact.tone, opaque: fact.opaque });
    }
  }
  return merged;
}

export function recordCellText(cell: RecordCellData): string {
  return `${cell.verb} ${cell.data.join(", ")}`;
}

// Records may take at most roughly a third of the row (§9.10), so the command keeps
// its width: overflow drops whole facts, one datum of a merged cell at a time. A pass
// goes first (§9.10.1), then deletions, then the oldest; a failed check goes last.
// Terminal state wins, a mangled sha is worse than none, and a dim `+N` says facts
// were dropped; Ctrl+T shows them.
const RECORD_HEADLINE_SHARE = 1 / 3;
// A failure is the row's news and the only explanation of its warning bullet (§9.10.1),
// so a lone failed check may take this much before it goes.
const LONE_FAILURE_SHARE = 1 / 2; // agent-default (not a user rule): 2026-10-15
// A deletion tidies up after the change the row was for (§9.10): `committed a4f21c9 ·
// deleted branch docs` keeps the commit.
const DELETION = /^(?:deleted|removed)\b/;

/** Fit whole facts ahead of the command; keep failed checks longest (§9.10.1). */
export function fitHeadline(theme: Theme | undefined, all: RecordCellData[], available: number): string {
  // A fact longer than its cap alone can never show, so it goes before any choice:
  // the drop order below must not spend a fact that fits on one that never will.
  const cells = all.map((cell) => {
    const maxWidth = Math.floor(available * (cell.tone === "error" ? LONE_FAILURE_SHARE : RECORD_HEADLINE_SHARE));
    return { ...cell, data: cell.data.filter((datum) => `${cell.verb} ${datum}`.length <= maxWidth) };
  }).filter((cell) => cell.data.length > 0);
  const lone = () => cells.length === 1 && cells[0]!.data.length === 1;
  const cap = () => Math.floor(available * (lone() && cells[0]!.tone === "error" ? LONE_FAILURE_SHARE : RECORD_HEADLINE_SHARE));
  const width = () => cells.map(recordCellText).join(SEP).length;
  let dropped = all.reduce((sum, cell) => sum + cell.data.length, 0) - cells.reduce((sum, cell) => sum + cell.data.length, 0);
  // The count fits the cap too, but never costs the last fact its place.
  while (cells.length && width() + (dropped ? ` +${dropped}`.length : 0) > cap() && !(lone() && width() <= cap())) {
    const pass = cells.findIndex((cell) => cell.tone === "text");
    const deletion = cells.findIndex((cell) => cell.tone !== "error" && DELETION.test(cell.verb));
    const index = pass >= 0 ? pass : deletion >= 0 ? deletion : Math.max(0, cells.findIndex((cell) => cell.tone !== "error"));
    if (cells[index]!.data.length > 1) cells[index]!.data.shift();
    else cells.splice(index, 1);
    dropped++;
  }
  if (cells.length === 0) return "";
  const shown = cells.map((cell) => {
    if (!cell.opaque) return ink(theme, cell.tone, `${BOLD}${recordCellText(cell)}${BOLD_OFF}`);
    const verb = ink(theme, cell.tone, `${BOLD}${cell.verb}${BOLD_OFF}`);
    return `${verb}${ink(theme, "dim", ` ${cell.data.join(", ")}`)}`;
  }).join(ink(theme, "dim", SEP));
  const count = ` +${dropped}`;
  return dropped && width() + count.length <= cap() ? `${shown}${ink(theme, "dim", count)}` : shown;
}
