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
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../../extensions/_lib/ansi.ts";
import { LINE_BREAK_MARK } from "../../../extensions/pi-traceline/bash-preamble.ts";
import { fitBashLines } from "../../../extensions/pi-traceline/bash-lines.ts";

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
// SAFETY: this marker theme implements the fg/bold/bg methods used by the bash ink pipeline.
const theme = {
  fg: (color: string, text: string) => `\x1b[38;5;${THEME_CODES[color] ?? 250}m${text}\x1b[39m`,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
} as Theme;

const CROWN = /\x1b\[38;5;255m\x1b\[1m([^\x1b]*)\x1b\[22m/g;

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
  const body = cmd.split("\n").map(stripAnsi).map((line) => line.trim()).filter(Boolean).join(` ${LINE_BREAK_MARK} `);
  const row = `$ ${fitBashLines(theme, "text", body, Number.POSITIVE_INFINITY).first}`;
  const crowns: string[] = [];
  CROWN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CROWN.exec(row))) {
    if (match[1] && match[1] !== "$") crowns.push(match[1]);
  }
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
  console.log(`\n--- ${samples} sampled rows (seed ${seed}) ---`);
  for (let i = 0; i < samples; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const random = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const row = rendered[Math.floor(random * rendered.length)]!;
    console.log(stripAnsi(row).length > 220 ? `${row.slice(0, 2200)}\x1b[0m…` : row);
  }
}
