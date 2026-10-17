#!/usr/bin/env node
// Harvest bash calls *with their results* from local pi session logs, for judging
// traceline's records (design language §9.10) against real porcelain.
//
//   node scripts/dev/bash-corpus/extract-results.mjs [--sessions ~/.pi/agent/sessions] [--out out/results.jsonl] [--all]
//
// Output: one JSON object per line, {"cmd", "text", "isError"}, for every bash call
// whose command mentions git, gh or npm (the built-in vocabulary), or with --all every
// bash call, for drafting entries for other tools (draft-vocabulary.ts). The file holds raw
// session output, so it lives in the git-ignored out/ directory and is never committed.
// records.ts replays it through the live records parser.

import { createReadStream, mkdirSync, readdirSync, statSync, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resultText } from "../../../extensions/pi-traceline/records.ts";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const here = dirname(fileURLToPath(import.meta.url));
const sessionsRoot = argValue("--sessions", join(homedir(), ".pi", "agent", "sessions"));
const outPath = argValue("--out", join(here, "out", "results.jsonl"));
const VOCABULARY = /\b(?:git|gh|npm)\b/;
const every = args.includes("--all");

function* sessionFiles(root) {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* sessionFiles(full);
    else if (entry.endsWith(".jsonl")) yield full;
  }
}

mkdirSync(dirname(outPath), { recursive: true });
const out = createWriteStream(outPath);
let files = 0;
let rows = 0;

for (const file of sessionFiles(sessionsRoot)) {
  files++;
  const pending = new Map(); // toolCallId -> command
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const isCall = line.includes('"toolCall"') && line.includes('"bash"');
    const isResult = line.includes('"toolResult"') && pending.size > 0;
    if (!isCall && !isResult) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event?.type === "message" ? event.message : undefined;
    if (!message) continue;
    if (message.role === "toolResult") {
      const cmd = pending.get(message.toolCallId);
      if (cmd === undefined) continue;
      pending.delete(message.toolCallId);
      out.write(`${JSON.stringify({ cmd, text: resultText({ result: message }), isError: message.isError === true })}\n`);
      rows++;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const item of message.content) {
      const cmd = item?.type === "toolCall" && item?.name === "bash" ? item?.arguments?.command : undefined;
      if (typeof cmd === "string" && (every || VOCABULARY.test(cmd))) pending.set(item.id, cmd);
    }
  }
}

out.end();
console.log(`sessions=${files} rows=${rows} -> ${outPath}`);
