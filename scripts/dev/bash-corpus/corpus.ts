// Harvested bash results (extract-results.mjs), read once and replayed through traceline's
// records parser exactly as a row renders them. Shared by records.ts and draft-vocabulary.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isJsonObject } from "../../../extensions/_lib/boundary.ts";
import { recordFacts, type RecordFact } from "../../../extensions/pi-traceline/records.ts";

export type Harvested = { cmd: string; text: string; isError: boolean };

/** Every distinct command+result: forked sessions repeat their parent's calls. */
export function readHarvest(path: string): Harvested[] {
  const seen = new Set<string>();
  const rows: Harvested[] = [];
  // A full harvest (extract-results.mjs --all) outgrows one string: decode line by line.
  const bytes = readFileSync(path);
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline < 0 ? bytes.length : newline;
    const line = bytes.toString("utf8", start, end);
    start = end + 1;
    if (!line) continue;
    const value: unknown = JSON.parse(line);
    assert(isJsonObject(value), "Expected a harvested bash result");
    const { cmd, text, isError } = value;
    assert(typeof cmd === "string" && typeof text === "string" && typeof isError === "boolean", "Invalid harvested bash result");
    const row = { cmd, text, isError };
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/** The records a row earns from the active vocabulary. */
export function replayFacts(row: Harvested): RecordFact[] {
  // extract-results.mjs joins text blocks with a trailing newline, as resultText does.
  return recordFacts({
    toolName: "bash",
    args: { command: row.cmd },
    result: { content: [{ type: "text", text: row.text.replace(/\n$/, "") }], isError: row.isError },
  });
}
