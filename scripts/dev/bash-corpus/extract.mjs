#!/usr/bin/env node
// Harvest every bash tool invocation from local pi session logs into one corpus file.
//
//   node scripts/dev/bash-corpus/extract.mjs [--sessions ~/.pi/agent/sessions] [--out out/commands.jsonl]
//
// Output: one JSON object per line, {"cmd": "<raw command string>"}, in session order.
// The corpus is an input to report.ts, which replays it through traceline's real
// bash ink pipeline. Nothing here depends on pi: it is plain JSONL scraping.

import { createReadStream, mkdirSync, readdirSync, statSync, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const here = dirname(fileURLToPath(import.meta.url));
const sessionsRoot = argValue("--sessions", join(homedir(), ".pi", "agent", "sessions"));
const outPath = argValue("--out", join(here, "out", "commands.jsonl"));

function* sessionFiles(root) {
  let dirs;
  try {
    dirs = readdirSync(root);
  } catch {
    return;
  }
  for (const dir of dirs) {
    const full = join(root, dir);
    let entries;
    try {
      if (!statSync(full).isDirectory()) continue;
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) yield join(full, entry);
    }
  }
}

mkdirSync(dirname(outPath), { recursive: true });
const out = createWriteStream(outPath);
let files = 0;
let commands = 0;

for (const file of sessionFiles(sessionsRoot)) {
  files++;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap prefilter: bash toolCalls are rare relative to log volume.
    if (!line.includes('"toolCall"') || !line.includes('"bash"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "message") continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type !== "toolCall" || item?.name !== "bash") continue;
      const cmd = item?.arguments?.command;
      if (typeof cmd === "string" && cmd.trim().length > 0) {
        out.write(JSON.stringify({ cmd }) + "\n");
        commands++;
      }
    }
  }
}

out.end();
console.log(`sessions=${files} commands=${commands} -> ${outPath}`);
