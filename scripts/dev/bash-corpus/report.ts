#!/usr/bin/env node
// Replay the harvested bash corpus (see extract.mjs) through traceline's *real*
// one-line ink pipeline and report what wears the crown.
//
//   node scripts/dev/bash-corpus/report.ts                  # census to stdout + out/census.json
//   node scripts/dev/bash-corpus/report.ts --samples 25     # print rendered rows for eyeballing
//   node scripts/dev/bash-corpus/report.ts --dump out/crowns.jsonl   # per-row crowns, for diffing
//
// Crown detection parses the rendered ANSI (a marker theme with a distinctive
// text-tone code), so the same report runs against any version of the renderer —
// run it before and after a rule change and diff the censuses.
//
// Corpus caveat: real rows flatten pi's *rendered* invocation text; the rig flattens
// the raw command string instead, which matches it modulo pi's own line wrapping.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { internals } from "../../../extensions/pi-traceline/index.ts";

const { inkBashRow, flattenInvocationLines, stripAnsi } = internals;

const args = process.argv.slice(2);
function argValue(flag: string, fallback?: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = argValue("--corpus", join(here, "out", "commands.jsonl"))!;
const censusPath = argValue("--census", join(here, "out", "census.json"))!;
const dumpPath = argValue("--dump");
const samples = Number(argValue("--samples", "0"));
const seed = Number(argValue("--seed", "7"));

// Marker theme (same shape as the test suite's): text=255 makes crowns parseable
// out of rendered ANSI regardless of which renderer version produced them.
const THEME_CODES: Record<string, number> = { dim: 245, muted: 246, text: 255, success: 41, warning: 220, error: 196, accent: 214 };
(globalThis as any).__tracelineGetTheme = () => ({
  fg: (color: string, text: string) => `\x1b[38;5;${THEME_CODES[color] ?? 250}m${text}\x1b[39m`,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
});

const CROWN = /\x1b\[38;5;255m\x1b\[1m([^\x1b]*)\x1b\[22m/g;

function crownsOf(rendered: string): string[] {
  const words: string[] = [];
  let m: RegExpExecArray | null;
  CROWN.lastIndex = 0;
  while ((m = CROWN.exec(rendered))) {
    if (m[1] && m[1] !== "$") words.push(m[1]);
  }
  return words;
}

const commands: string[] = [];
for (const line of readFileSync(corpusPath, "utf8").split("\n")) {
  if (!line) continue;
  try {
    const cmd = JSON.parse(line).cmd;
    if (typeof cmd === "string") commands.push(cmd);
  } catch {
    /* skip */
  }
}

const census = new Map<string, number>();
const perRow = new Map<number, number>();
const dump: string[] = [];
const rendered: string[] = [];
for (const cmd of commands) {
  const body = flattenInvocationLines(cmd.split("\n")) ?? "";
  const row = inkBashRow(undefined, `$ ${body}`);
  const crowns = crownsOf(row);
  perRow.set(crowns.length, (perRow.get(crowns.length) ?? 0) + 1);
  for (const word of crowns) census.set(word, (census.get(word) ?? 0) + 1);
  if (dumpPath) dump.push(JSON.stringify({ crowns }));
  if (samples > 0) rendered.push(row);
}

const totalCrowns = [...census.values()].reduce((a, b) => a + b, 0);
const top = [...census.entries()].sort((a, b) => b[1] - a[1]);
console.log(`corpus: ${commands.length} invocations`);
console.log(`crowns: ${totalCrowns} total (${(totalCrowns / commands.length).toFixed(2)}/row)`);
console.log(`crowns per row: ${[...perRow.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(`top 40 crowned words:`);
for (const [word, count] of top.slice(0, 40)) console.log(`  ${String(count).padStart(6)}  ${word}`);

mkdirSync(dirname(censusPath), { recursive: true });
writeFileSync(
  censusPath,
  JSON.stringify(
    {
      invocations: commands.length,
      totalCrowns,
      crownsPerRow: Object.fromEntries([...perRow.entries()].sort((a, b) => a[0] - b[0])),
      words: Object.fromEntries(top),
    },
    null,
    2,
  ) + "\n",
);
console.log(`census -> ${censusPath}`);
if (dumpPath) {
  writeFileSync(dumpPath, dump.join("\n") + "\n");
  console.log(`per-row crowns -> ${dumpPath}`);
}

if (samples > 0) {
  // Deterministic sample (mulberry32) so before/after runs show the same rows.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  console.log(`\n--- ${samples} sampled rows (seed ${seed}) ---`);
  for (let i = 0; i < samples; i++) {
    const row = rendered[Math.floor(rand() * rendered.length)]!;
    console.log(stripAnsi(row).length > 220 ? `${row.slice(0, 2200)}\x1b[0m…` : row);
  }
}
