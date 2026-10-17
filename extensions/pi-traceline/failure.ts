// Failure facts (design language §9.2.1): why a failed call failed, read from the result
// the model received, and inked as the row's leading suffix cell.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ink, middleTruncate } from "../_lib/style.ts";
import { bashCrownedHeads } from "./bash-crowns.ts";
import { bashTopLevelSegments, classifyBashSegment } from "./bash-preamble.ts";

const FAILURE_FACT_COLS = 40; // agent-default (not a user rule): 2026-10-20
const FAILURE_FACT_SHARE = 1 / 3;

export type FailureFact = {
  text: string;
  /** Tool status lines are already short; free text needs fitting. */
  parsed: boolean;
};

const SEARCH_HEADS = new Set(["rg", "grep", "egrep", "fgrep"]);
const QUOTED_OR_ESCAPED = /'[^']*'|"(?:[^"\\]|\\.)*"|\\./g;

/** Read the failure's status or diagnostic, without borrowing incidental output (§9.2.1). */
export function failureFact(toolName: string, errorText: string, command?: string): FailureFact | undefined {
  const thrown = toolName === "codemode" ? /^Script error:\n\s*(.+)/m.exec(errorText)?.[1]!.trim() : undefined;
  if (thrown !== undefined) {
    if (thrown.startsWith("Script timed out:")) return { text: "timeout", parsed: true };
    if (thrown.startsWith("Script aborted:")) return { text: "aborted", parsed: true };
    if (thrown.startsWith("Script sandbox failed:")) return { text: "sandbox failed", parsed: true };
    return { text: thrown, parsed: false };
  }
  const lines = errorText.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  if (toolName !== "bash") return { text: last, parsed: false };

  const exit = /^Command exited with code (\d+)$/.exec(last);
  if (exit) {
    // Silence and one unpiped search make exit 1 unambiguously "nothing matched".
    let silentMiss = false;
    if (exit[1] === "1" && lines.length === 1 && command !== undefined) {
      const body = command.split("\n").map((line) => line.trim()).filter(Boolean).join(" \u21b5 ");
      const real = bashTopLevelSegments(body).filter((segment) => classifyBashSegment(segment.text) === "real");
      const heads = bashCrownedHeads(body);
      silentMiss = real.length === 1 && heads.length === 1 && SEARCH_HEADS.has(body.slice(heads[0]!.start, heads[0]!.end))
        && !/(^|[^|])\|([^|]|$)/.test(real[0]!.text.replace(QUOTED_OR_ESCAPED, ""));
    }
    return { text: silentMiss ? "no matches" : `exit ${exit[1]}`, parsed: true };
  }
  const timeout = /^Command timed out after (\S+) seconds$/.exec(last);
  if (timeout) return { text: `timeout ${timeout[1]}s`, parsed: true };
  if (last === "Command aborted") return { text: "aborted", parsed: true };
  if (last === "Command terminated without an exit code") return { text: "no exit code", parsed: true };
  return { text: last, parsed: false };
}

/** The fact as a suffix cell: error ink, free text middle-cut to its share of the row
 * so one verbose error cannot push the block's bodies aside. */
export function failureCell(theme: Theme | undefined, fact: FailureFact, available: number): string {
  const inked = ink(theme, "error", fact.text);
  if (fact.parsed) return inked;
  const width = Math.max(8, Math.min(FAILURE_FACT_COLS, Math.floor(available * FAILURE_FACT_SHARE)));
  return middleTruncate(inked, width, theme);
}
