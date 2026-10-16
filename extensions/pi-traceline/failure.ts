import { bashCrownedHeads } from "./bash-crowns.ts";
import { bashTopLevelSegments, classifyBashSegment } from "./bash-preamble.ts";

const FAILURE_FACT_COLS = 40; // agent-default (not a user rule): 2026-10-20
const FAILURE_FACT_SHARE = 1 / 3;

export function failureFactWidth(available: number): number {
  return Math.max(8, Math.min(FAILURE_FACT_COLS, Math.floor(available * FAILURE_FACT_SHARE)));
}

export type FailureFact = {
  text: string;
  /** Tool status lines are already short; free text needs fitting. */
  parsed: boolean;
};

/** Read the failure's status or diagnostic, without borrowing incidental output (§9.2.1). */
export function failureFact(toolName: string, errorText: string, command?: string): FailureFact | undefined {
  if (toolName === "codemode") {
    const label = /^Script error:\n/m.exec(errorText);
    if (label) {
      const first = errorText.slice(label.index + label[0].length).trim().split("\n")[0].trim();
      if (!first) return undefined;
      if (first.startsWith("Script timed out:")) return { text: "timeout", parsed: true };
      if (first.startsWith("Script aborted:")) return { text: "aborted", parsed: true };
      if (first.startsWith("Script sandbox failed:")) return { text: "sandbox failed", parsed: true };
      return { text: first, parsed: false };
    }
  }
  const lines = errorText.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  if (toolName !== "bash") return { text: last, parsed: false };

  const exit = /^Command exited with code (\d+)$/.exec(last);
  if (!exit) {
    const timeout = /^Command timed out after (\S+) seconds$/.exec(last);
    if (timeout) {
      const seconds = Number(timeout[1]);
      return { text: Number.isFinite(seconds) ? `timeout ${seconds}s` : "timeout", parsed: true };
    }
    if (last === "Command aborted") return { text: "aborted", parsed: true };
    if (last === "Command terminated without an exit code") return { text: "no exit code", parsed: true };
    return { text: last, parsed: false };
  }
  const fact: FailureFact = { text: `exit ${exit[1]}`, parsed: true };
  if (exit[1] !== "1" || lines.length !== 1 || command === undefined) return fact;

  // Silence and one unpiped search make exit 1 unambiguously "nothing matched".
  const body = command.split("\n").map((line) => line.trim()).filter(Boolean).join(" \u21b5 ");
  const real = bashTopLevelSegments(body).filter((segment) => classifyBashSegment(segment.text) === "real");
  const heads = bashCrownedHeads(body);
  if (real.length !== 1 || heads.length !== 1 || !["rg", "grep", "egrep", "fgrep"].includes(body.slice(heads[0]!.start, heads[0]!.end))) return fact;
  let quote: "'" | '"' | undefined;
  const search = real[0]!.text;
  for (let i = 0; i < search.length; i++) {
    const ch = search[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") i++;
    else if (ch === "|") {
      if (search[i + 1] === "|") i++;
      else return fact;
    }
  }
  return { text: "no matches", parsed: true };
}
