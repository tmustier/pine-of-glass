#!/usr/bin/env node
// Replay harvested bash results (see extract-results.mjs) through traceline's live
// records parser (design language §9.10) and report how often each record fires and
// from which evidence.
//
//   node scripts/dev/bash-corpus/records.ts                      # census to stdout + out/records-census.json
//   node scripts/dev/bash-corpus/records.ts --samples 5          # plus up to 5 example rows per record
//   node scripts/dev/bash-corpus/records.ts --dump out/records.jsonl   # per-row records, for diffing
//
// Comparing a rule change: run with distinct --census/--dump paths before and after
// the edit, then join the dumps on `row` to find records gained and lost.

import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "../../../extensions/_lib/boundary.ts";
import { recordFacts } from "../../../extensions/pi-traceline/records.ts";

const args = process.argv.slice(2);
function argValue(flag: string, fallback = ""): string {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const here = dirname(fileURLToPath(import.meta.url));
const resultsPath = argValue("--results", join(here, "out", "results.jsonl"));
const censusPath = argValue("--census", join(here, "out", "records-census.json"));
const dumpPath = argValue("--dump");
const samples = Number(argValue("--samples", "0"));

type Harvested = { cmd: string; text: string; isError: boolean };

// Forked sessions repeat their parent's calls; count each command+result once.
const seen = new Set<string>();
const rows: Harvested[] = [];
for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
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

const byRecord = new Map<string, { rows: number; examples: string[] }>();
const dump: string[] = [];
let recordRows = 0;
rows.forEach((row, index) => {
  // extract-results.mjs joins text blocks with a trailing newline, as resultText does.
  const facts = recordFacts({
    toolName: "bash",
    args: { command: row.cmd },
    result: { content: [{ type: "text", text: row.text.replace(/\n$/, "") }], isError: row.isError },
  });
  if (facts.length === 0) return;
  recordRows++;
  dump.push(JSON.stringify({ row: index, records: facts.map((fact) => `${fact.verb} ${fact.datum} [${fact.evidence}]`) }));
  const counted = new Set<string>();
  for (const fact of facts) {
    const key = `${fact.verb} [${fact.evidence}]`;
    if (counted.has(key)) continue;
    counted.add(key);
    const entry = byRecord.get(key) ?? { rows: 0, examples: [] };
    entry.rows++;
    if (entry.examples.length < samples) {
      entry.examples.push(`${fact.verb} ${fact.datum} $ ${row.cmd.replace(/\s*\n\s*/g, " \u21b5 ").slice(0, 160)}`);
    }
    byRecord.set(key, entry);
  }
});

const census = {
  rows: rows.length,
  recordRows,
  records: Object.fromEntries([...byRecord].sort((a, b) => b[1].rows - a[1].rows).map(([key, { rows }]) => [key, rows])),
};
console.log(`rows=${census.rows} with records=${recordRows} (${((100 * recordRows) / Math.max(1, rows.length)).toFixed(1)}%)`);
for (const [key, { rows: count, examples }] of [...byRecord].sort((a, b) => b[1].rows - a[1].rows)) {
  console.log(`${String(count).padStart(7)}  ${key}`);
  for (const example of examples) console.log(`           ${example}`);
}
mkdirSync(dirname(censusPath), { recursive: true });
writeFileSync(censusPath, `${JSON.stringify(census, null, 2)}\n`);
if (dumpPath) writeFileSync(dumpPath, `${dump.join("\n")}\n`);
