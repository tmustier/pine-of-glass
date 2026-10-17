#!/usr/bin/env node
// Draft a record vocabulary entry (design language §9.10) for one command from real
// harvested results (extract-results.mjs), with a model, and check the draft the way
// traceline will: it parses and every example holds, every example is copied from a
// real result, and a replay of the corpus shows where it fires. A failed check goes
// back to the model, at most --attempts times. Nothing is installed: review the draft,
// then add it to ~/.pi/agent/pi-traceline.json, a project's .pi/pi-traceline.json, or
// extensions/pi-traceline/vocabulary.ts.
//
//   node scripts/dev/bash-corpus/draft-vocabulary.ts --list                    # frequent commands no entry covers
//   node scripts/dev/bash-corpus/draft-vocabulary.ts --command "gh pr ready"   # draft, check, write out/drafts/<id>.json
//   node scripts/dev/bash-corpus/draft-vocabulary.ts --check draft.json        # check a draft without a model
//
// The model sees up to --samples real results for the command, cut to whole lines.
// They are tool results from your own sessions, sent to the model you name.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../../extensions/_lib/ansi.ts";
import { isJsonObject, type JsonFields } from "../../../extensions/_lib/boundary.ts";
import { readShell } from "../../../extensions/pi-traceline/record-shell.ts";
import { BUILT_IN_ENTRIES, parseVocabulary, useVocabulary } from "../../../extensions/pi-traceline/records.ts";
import { BUILT_IN_VOCABULARY } from "../../../extensions/pi-traceline/vocabulary.ts";
import { readHarvest, replayFacts, type Harvested } from "./corpus.ts";

const args = process.argv.slice(2);
function argValue(flag: string, fallback = ""): string {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
}
const here = dirname(fileURLToPath(import.meta.url));
const rows = readHarvest(argValue("--results", join(here, "out", "results.jsonl"))).map((row) => ({ ...row, text: stripAnsi(row.text) }));

// --- which rows run a command ---------------------------------------------------------

const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
/** The command paths a row runs: each command's head and up to two subcommand words (`gh pr ready`). */
function commandPaths(cmd: string): string[] {
  const script = readShell(cmd);
  return [...script.commands, ...script.nested].flatMap(({ head, args: words }) => {
    if (!head.literal) return [];
    const path = [head.text];
    for (const { text } of words) {
      if (path.length === 3 || !SUBCOMMAND.test(text)) break;
      path.push(text);
    }
    return [path.join(" ")];
  });
}
/** A sampling filter only: the drafted entry's own matching decides its records. */
const runs = (row: Harvested, path: string) => commandPaths(row.cmd).some((p) => p === path || p.startsWith(`${path} `));

// --- list: frequent commands no entry covers ------------------------------------------

// agent-default (not a user rule): 2026-10-18. Commands that only read, move files, run
// checks (§9.10.1) or steer the shell never complete a change a record could name, so the
// list leaves them out, as it does a bare `git` (usually `git -C dir …`) and loop variables.
const NOT_RECORDS = [
  ..."cd ls cat echo printf rg grep sed awk head tail find wc jq sort uniq cut tr xargs test sleep mkdir rm cp mv touch chmod pwd which file stat du df ps kill open diff tee date env export set source true false curl wget python python3 node bash sh zsh exit break continue mktemp lsof nl".split(" "),
  ..."status diff log show rev-parse grep ls-files ls-remote merge-base remote config worktree-list".split(" ").map((sub) => `git ${sub.replace("-list", " list")}`),
  ..."pr-view pr-checks pr-list pr-diff issue-view issue-list run-view run-list run-watch api search repo-view".split(" ").map((sub) => `gh ${sub.replace("-", " ")}`),
  "npm test", "npm run",
];
const skipped = (path: string) => /^\S+ in$|^(?:git|gh|npm)$/.test(path) || NOT_RECORDS.some((done) => path === done || path.startsWith(`${done} `));

function list(top: number): void {
  const covered = BUILT_IN_ENTRIES.flatMap(({ commands }) => commands.map((path) => path.join(" ")));
  const counts = new Map<string, { rows: number; errors: number }>();
  for (const row of rows) {
    for (const path of new Set(commandPaths(row.cmd))) {
      if (skipped(path) || covered.some((done) => path === done || path.startsWith(`${done} `))) continue;
      const count = counts.get(path) ?? { rows: 0, errors: 0 };
      count.rows++;
      if (row.isError) count.errors++;
      counts.set(path, count);
    }
  }
  console.log(`rows=${rows.length}; most frequent commands no entry covers:`);
  for (const [path, { rows: count, errors }] of [...counts].sort((a, b) => b[1].rows - a[1].rows).slice(0, top)) {
    console.log(`${String(count).padStart(7)}  ${path}${errors ? `  (${errors} failed)` : ""}`);
  }
}

// --- check: the way traceline will -----------------------------------------------------

const lines = (text: string) => text.replace(/\n$/, "").split("\n");
/** Whether `excerpt` is a contiguous run of whole lines of `text`. */
function excerptOf(excerpt: string, text: string): boolean {
  const want = lines(excerpt);
  const have = lines(text);
  return have.some((_, start) => want.every((line, i) => have[start + i] === line));
}

type Checked = { problems: string[]; report: string[] };

function check(value: unknown, path: string): Checked {
  const { entries, problems } = parseVocabulary([value]);
  const examples = isJsonObject(value) && Array.isArray(value.examples) ? value.examples : [];
  examples.forEach((example: unknown, index) => {
    if (!isJsonObject(example) || typeof example.command !== "string" || typeof example.output !== "string") return;
    const { command, output, error } = example;
    const same = rows.filter((row) => row.cmd === command);
    if (same.length === 0) problems.push(`example ${index + 1}: its command is not copied from a real result`);
    else if (!same.some((row) => row.isError === (error === true) && excerptOf(output, row.text))) {
      problems.push(`example ${index + 1}: its output is not whole lines copied from a real result of that command with error ${error === true}`);
    }
  });
  const [entry] = entries;
  if (!entry || problems.length > 0) return { problems, report: [] };

  useVocabulary([entry]);
  const ran = rows.filter((row) => runs(row, path));
  const records = new Map<string, number>();
  let recorded = 0;
  let failed = 0;
  let elsewhere = 0;
  const quiet: string[] = [];
  for (const row of rows) {
    const facts = replayFacts(row);
    if (facts.length === 0) {
      if (quiet.length < 3 && runs(row, path)) quiet.push(lines(row.text).find(Boolean)?.slice(0, 100) ?? "(empty)");
      continue;
    }
    recorded++;
    if (row.isError) failed++;
    if (!runs(row, path)) elsewhere++;
    for (const { verb, datum } of facts) records.set(`${verb} ${datum}`, (records.get(`${verb} ${datum}`) ?? 0) + 1);
  }
  useVocabulary(BUILT_IN_ENTRIES);
  const share = ran.length ? ` (${Math.round((100 * recorded) / ran.length)}%)` : "";
  const report = [
    `${entry.id}: parses, ${entry.examples.length} examples hold, every example is copied from a real result`,
    `replay: fires on ${recorded} of ${ran.length} real results that run ${path}${share}; ${failed} of them failed${elsewhere ? `; ${elsewhere} run it in a form the sampler did not see` : ""}`,
    ...[...records].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([record, count]) => `${String(count).padStart(7)}  ${record}`),
    ...quiet.map((line) => `   none  ${line}`),
  ];
  if (BUILT_IN_ENTRIES.some(({ id }) => id === entry.id)) report.push(`replaces the built-in ${entry.id}`);
  return { problems, report };
}

// --- draft: the model proposes, the check decides ---------------------------------------

const SYSTEM = `You draft one entry for Traceline's record vocabulary. Traceline renders a coding agent's tool calls. When a bash command completes a consequential change to named state that the session will refer to later (a deploy, a release, a resource created or deleted, a pull request marked ready), and the command's own output proves it happened, the row leads with a short verb-first record such as "pushed main" or "opened PR #88". Records must be rare and proven.

Write the entry as one JSON object:
- id: lowercase and dotted, such as "gh.pr.ready"
- commands: the command paths it covers, such as ["gh pr ready"]
- requires (optional): options of which at least one must be present
- unless (optional): options that rule an invocation out, such as a dry run or an option that stops short of the change. List the short form too (["--no-commit", "-n"]), and only options the command really has.
- records: rules, each {"output", "verb", "datum"}, optionally "tone": "warning" for a riskier outcome and "opaque": true for hashes and ids. "output" is a JavaScript regular expression source, matched with the g and m flags against the whole output, so ^ and $ mark line edges. It must match only the line that proves completion and capture the name with named groups. "verb" is lowercase and past tense and carries every word of the outcome ("marked ready", "created repository"). "datum" is only the name the session will use for the thing, as a template over the groups: "PR #{number}", a branch, a sha, "{owner}/{repo}". Never a URL.
- examples: each {"command", "output", "error", "records"}. Copy "command" and "error" exactly from one real result below, and copy "output" as whole lines from that same result, never a shortened or edited line and never a line marked as not shown. "records" lists exactly the records this entry yields for that example, each as "verb datum". Include at least one example that yields a record, and near misses that must yield nothing: failures, no-ops, dry runs, and lines that announce work before it completes.

Output proves completion. A line that announces work, help text, a usage error or an echo of the command is not proof. Never record dry runs or commands that only read. If the command changes no named state, or no result below proves completion, reply {"skip": "<reason>"}.

Reply with the JSON object only.`;

function excerpt(text: string): string {
  // agent-default (not a user rule): 2026-10-18. 15 head and 5 tail lines, lines up to 300 columns.
  const all = lines(text).map((line) => (line.length > 300 ? "⟪long line not shown⟫" : line));
  return all.length <= 20 ? all.join("\n") : [...all.slice(0, 15), `⟪${all.length - 20} lines not shown⟫`, ...all.slice(-5)].join("\n");
}

function prompt(path: string, max: number): string {
  // Variety over volume: the shortest command for each way the output opens, failures included.
  const byOpening = new Map<string, Harvested>();
  for (const row of rows.filter((candidate) => runs(candidate, path)).sort((a, b) => a.cmd.length - b.cmd.length)) {
    const opening = `${row.isError} ${lines(row.text).slice(0, 2).join(" ").replace(/[0-9a-f]{7,}|\d+/g, "#")}`;
    if (!byOpening.has(opening)) byOpening.set(opening, row);
  }
  const picked = [...byOpening.values()].slice(0, max);
  const reference = BUILT_IN_VOCABULARY.filter(({ id }) => ["git.commit", "gh.pr.create", "npm.publish"].includes(id));
  return [
    `Command: ${path}`,
    `Built-in entries, for the format:\n${JSON.stringify(reference, null, 1)}`,
    `Real results (${picked.length} of ${rows.filter((row) => runs(row, path)).length} that run it):`,
    ...picked.map((row, i) => `### result ${i + 1}\ncommand: ${JSON.stringify(row.cmd)}\nerror: ${row.isError}\noutput:\n\`\`\`\n${excerpt(row.text)}\n\`\`\``),
  ].join("\n\n");
}

/** The model's reply, read at the boundary: a command it declines, or an entry to check. */
type Reply = { skip: string } | { entry: JsonFields } | { unreadable: string };

function readReply(message: AssistantMessage): Reply {
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  try {
    const value: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (isJsonObject(value)) return typeof value.skip === "string" ? { skip: value.skip } : { entry: value };
  } catch {
    // Not JSON: the model is told so below.
  }
  return { unreadable: text.slice(0, 300) };
}

async function draft(path: string): Promise<number> {
  const [provider, ...id] = argValue("--model", "openai-codex/gpt-6-luna").split("/");
  const runtime = await ModelRuntime.create();
  const model = runtime.getModel(provider!, id.join("/"));
  if (!model) throw new Error(`unknown model ${provider}/${id.join("/")}`);
  const out = argValue("--out", join(here, "out", "drafts", `${path.replace(/\W+/g, ".")}.json`));
  // agent-default (not a user rule): 2026-10-18. Three tries, 24 sampled results.
  const attempts = Number(argValue("--attempts", "3"));
  const messages: Message[] = [{ role: "user", content: prompt(path, Number(argValue("--samples", "24"))), timestamp: Date.now() }];
  let cost = 0;
  let rejected: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const answer = await runtime.completeSimple(model, { systemPrompt: SYSTEM, messages }, { reasoning: "medium" });
    if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage ?? answer.stopReason);
    cost += answer.usage.cost.total;
    messages.push(answer);
    const read = readReply(answer);
    console.log(`attempt ${attempt}: ${model.provider}/${model.id}, $${cost.toFixed(4)} so far`);
    if ("skip" in read) {
      console.log(`skipped: ${read.skip}`);
      return 0;
    }
    const { problems, report } = "entry" in read ? check(read.entry, path) : { problems: ["the reply is not one JSON object"], report: [] };
    if (problems.length === 0 && "entry" in read) {
      console.log([...report, `wrote ${write(out, read.entry)}`].join("\n"));
      return 0;
    }
    rejected = "entry" in read ? read.entry : read.unreadable;
    console.log(problems.map((problem) => `  ${problem}`).join("\n"));
    messages.push({ role: "user", content: `The entry did not pass:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nReply with a corrected JSON object only.`, timestamp: Date.now() });
  }
  console.log(`no entry passed after ${attempts} attempts; the last draft is in ${write(out.replace(/\.json$/, ".rejected.json"), rejected)}`);
  return 1;
}

function write(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ vocabulary: [value] }, null, 2)}\n`);
  return path;
}

if (args.includes("--list")) {
  list(Number(argValue("--top", "25")));
} else if (argValue("--check")) {
  const file: unknown = JSON.parse(readFileSync(argValue("--check"), "utf8"));
  const value = isJsonObject(file) && Array.isArray(file.vocabulary) ? file.vocabulary[0] : file;
  const commands = isJsonObject(value) && Array.isArray(value.commands) ? value.commands : [];
  const { problems, report } = check(value, argValue("--command", typeof commands[0] === "string" ? commands[0] : ""));
  console.log([...problems, ...report].join("\n"));
  process.exitCode = problems.length ? 1 : 0;
} else if (argValue("--command")) {
  process.exitCode = await draft(argValue("--command"));
} else {
  console.log("usage: draft-vocabulary.ts --list | --command \"<command>\" | --check <draft.json>");
  process.exitCode = 2;
}
