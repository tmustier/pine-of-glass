// Failure facts (design language §9.2.1): why a call failed, read from the result the
// model received. Plain text in, one short fact out; ink and placement live with the
// suffix builders in index.ts and nested-rows.ts.
import { bashCrownedHeads } from "./bash-crowns.ts";
import { bashTopLevelSegments, classifyBashSegment } from "./bash-preamble.ts";

/** A free-text fact middle-truncates to this many columns (agent default, not a user rule: 2026-10-20). */
const FAILURE_FACT_COLS = 40;
/** ...or to this share of the row, whichever is less: §9.10's headline share. */
const FAILURE_FACT_SHARE = 1 / 3;

/** The columns a free-text failure fact may take in a row `available` columns wide. */
export function failureFactWidth(available: number): number {
  return Number.isFinite(available) ? Math.max(8, Math.min(FAILURE_FACT_COLS, Math.floor(available * FAILURE_FACT_SHARE))) : FAILURE_FACT_COLS;
}

export type FailureFact = {
  text: string;
  /** Parsed from a status line the tool prints, so already short; free text is cut by the renderer. */
  parsed: boolean;
};

// Pi's bash tool closes a failed result with one of these status lines.
const BASH_EXIT = /^Command exited with code (\d+)$/;
const BASH_TIMEOUT = /^Command timed out after (\S+) seconds$/;
const BASH_ABORTED = /^Command aborted$/;
const BASH_NO_EXIT = /^Command terminated without an exit code$/;

// Codemode labels its own failure; the next line is the thrown error's first line.
const SCRIPT_ERROR = /^Script error:\n/m;
const SCRIPT_TIMEOUT = /^Script timed out:/m;
const SCRIPT_ABORTED = /^Script aborted:/m;
const SCRIPT_SANDBOX = /^Script sandbox failed:/m;

// Both tools document exit 1 as "nothing matched" and 2 as an error.
const SEARCH_HEADS = new Set(["rg", "grep", "egrep", "fgrep"]);

function nonEmptyLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

// A single `|` outside quotes: a pipeline's status belongs to its last command, not
// the search. `||` sequences and is caught by the segment split instead.
function hasTopLevelPipe(body: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") i++;
    else if (ch === "|") {
      if (body[i + 1] === "|") i++;
      else return true;
    }
  }
  return false;
}

// A command whose only real segment crowns one search head, with no pipe, behind at
// most a situating preamble (§9.4), so the exit status demonstrably belongs to the
// search. A failed `cd` exits 1 too, which is why the caller also requires silence:
// rg and grep print nothing when nothing matched, and `cd` complains.
function isLoneSearch(command: string | undefined): boolean {
  if (command === undefined) return false;
  const flattened = command.split("\n").map((line) => line.trim()).filter(Boolean).join(" \u21b5 ");
  const real = bashTopLevelSegments(flattened).filter((segment) => classifyBashSegment(segment.text) === "real");
  if (real.length !== 1 || hasTopLevelPipe(real[0]!.text)) return false;
  const heads = bashCrownedHeads(flattened);
  return heads.length === 1 && SEARCH_HEADS.has(flattened.slice(heads[0]!.start, heads[0]!.end));
}

function formatTimeout(seconds: string): string {
  const value = Number(seconds);
  return Number.isFinite(value) ? `timeout ${value}s` : "timeout";
}

function bashFailure(errorText: string, command: string | undefined): FailureFact | undefined {
  const lines = nonEmptyLines(errorText);
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const exit = BASH_EXIT.exec(last);
  if (exit) {
    if (exit[1] === "1" && lines.length === 1 && isLoneSearch(command)) return { text: "no matches", parsed: true };
    return { text: `exit ${exit[1]}`, parsed: true };
  }
  const timeout = BASH_TIMEOUT.exec(last);
  if (timeout) return { text: formatTimeout(timeout[1]!), parsed: true };
  if (BASH_ABORTED.test(last)) return { text: "aborted", parsed: true };
  if (BASH_NO_EXIT.test(last)) return { text: "no exit code", parsed: true };
  return { text: last, parsed: false };
}

function scriptFailure(errorText: string): FailureFact | undefined {
  const label = SCRIPT_ERROR.exec(errorText);
  if (label) {
    const first = nonEmptyLines(errorText.slice(label.index + label[0].length))[0];
    if (first === undefined) return undefined;
    if (SCRIPT_TIMEOUT.test(first)) return { text: "timeout", parsed: true };
    if (SCRIPT_ABORTED.test(first)) return { text: "aborted", parsed: true };
    if (SCRIPT_SANDBOX.test(first)) return { text: "sandbox failed", parsed: true };
    return { text: first, parsed: false };
  }
  const last = nonEmptyLines(errorText).at(-1);
  return last === undefined ? undefined : { text: last, parsed: false };
}

/**
 * The failure fact for a failed call's error text (§9.2.1): bash restates pi's status
 * line, a composed call quotes the thrown error's first line, and any other tool
 * quotes the last line of its error, where diagnostics put their diagnosis.
 */
export function failureFact(toolName: string, errorText: string, command?: string): FailureFact | undefined {
  if (toolName === "bash") return bashFailure(errorText, command);
  if (toolName === "codemode") return scriptFailure(errorText);
  const last = nonEmptyLines(errorText).at(-1);
  return last === undefined ? undefined : { text: last, parsed: false };
}
