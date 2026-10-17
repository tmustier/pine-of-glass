import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const scripts = new URL("../../scripts/dev/bash-corpus/", import.meta.url);

test("corpus extraction and replay distinguish failed and successful silent commands", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pog-record-corpus-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  const results = join(dir, "results.jsonl");
  const census = join(dir, "census.json");
  mkdirSync(sessions);
  const entries = [true, false, false].flatMap((isError, i) => [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `${i}`, name: "bash", arguments: { command: "gh pr merge 87" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: `${i}`, content: [{ type: "text", text: "(no output)" }], isError } },
  ]);
  writeFileSync(join(sessions, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));

  const extract = spawnSync(process.execPath, [new URL("extract-results.mjs", scripts).pathname, "--sessions", sessions, "--out", results], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const replay = spawnSync(process.execPath, [new URL("records.ts", scripts).pathname, "--results", results, "--census", census], { encoding: "utf8" });
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(readFileSync(census, "utf8")), {
    rows: 2,
    recordRows: 1,
    records: { "merged [quiet]": 1 },
  });
});

test("corpus extraction keeps git, gh and npm calls, or every bash call with --all", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pog-record-corpus-all-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  mkdirSync(sessions);
  const entries = ["kubectl apply -f web.yaml", "git push"].flatMap((command, i) => [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `${i}`, name: "bash", arguments: { command } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: `${i}`, content: [{ type: "text", text: "ok" }], isError: false } },
  ]);
  writeFileSync(join(sessions, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const harvested = (...flags: string[]) => {
    const out = join(dir, `results${flags.join("")}.jsonl`);
    const run = spawnSync(process.execPath, [new URL("extract-results.mjs", scripts).pathname, "--sessions", sessions, "--out", out, ...flags], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line).cmd);
  };
  assert.deepEqual(harvested(), ["git push"]);
  assert.deepEqual(harvested("--all"), ["kubectl apply -f web.yaml", "git push"]);
});

// draft-vocabulary.ts without a model: --list and --check read the same corpus the
// model's drafts are checked against.
const READY = "✓ Pull request o/r#12 is marked as \"ready for review\"\n";
const draftCorpus = [
  { cmd: "gh pr ready 12", text: READY, isError: false },
  { cmd: "gh pr ready 12 && gh pr checks 12", text: `${READY}lint\tpass\t9s\thttps://github.com/o/r/actions/runs/1\n`, isError: false },
  { cmd: "gh pr ready 82 --undo", text: "✓ Pull request o/r#82 is converted to \"draft\"\n", isError: false },
  { cmd: "gh pr ready 99", text: "GraphQL: Could not resolve to a PullRequest with the number of 99.\n", isError: true },
  { cmd: "git push", text: "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n", isError: false },
  { cmd: "cat notes.md", text: "notes\n", isError: false },
];
const ready = {
  id: "gh.pr.ready",
  commands: ["gh pr ready"],
  unless: ["--undo"],
  records: [{ output: String.raw`^✓ Pull request \S*?#(?<number>\d+) is marked as "ready for review"$`, verb: "marked ready", datum: "PR #{number}" }],
  examples: [
    { command: "gh pr ready 12", output: READY, error: false, records: ["marked ready PR #12"] },
    { command: "gh pr ready 82 --undo", output: "✓ Pull request o/r#82 is converted to \"draft\"\n", error: false, records: [] },
    { command: "gh pr ready 99", output: "GraphQL: Could not resolve to a PullRequest with the number of 99.\n", error: true, records: [] },
  ],
};

function draftScript(t: { after: (fn: () => void) => void }, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pog-draft-vocabulary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const results = join(dir, "results.jsonl");
  writeFileSync(results, draftCorpus.map((row) => JSON.stringify(row)).join("\n"));
  const files = args.map((arg) => {
    if (!arg.startsWith("{")) return arg;
    const path = join(dir, `draft-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, arg);
    return path;
  });
  return spawnSync(process.execPath, [new URL("draft-vocabulary.ts", scripts).pathname, "--results", results, ...files], { encoding: "utf8" });
}

test("draft --list names frequent commands no entry covers, and leaves out reads and covered commands", (t) => {
  const listed = draftScript(t, "--list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split("\n"), [
    "rows=6; most frequent commands no entry covers:",
    "      4  gh pr ready  (1 failed)",
  ]);
});

test("draft --check accepts an entry whose examples hold and are copied from real results, and replays it", (t) => {
  const checked = draftScript(t, "--check", JSON.stringify({ vocabulary: [ready] }));
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.deepEqual(checked.stdout.trim().split("\n"), [
    "gh.pr.ready: parses, 3 examples hold, every example is copied from a real result",
    "replay: fires on 2 of 4 real results that run gh pr ready (50%); 0 of them failed",
    "      2  marked ready PR #12",
    "   none  ✓ Pull request o/r#82 is converted to \"draft\"",
    "   none  GraphQL: Could not resolve to a PullRequest with the number of 99.",
  ]);
});

test("draft --check rejects examples that are not copied from a real result", (t) => {
  const edited = { ...ready, examples: [{ ...ready.examples[0]!, output: READY.replace("#12", "#14"), records: ["marked ready PR #14"] }, ...ready.examples.slice(1)] };
  const partial = { ...ready, examples: [{ ...ready.examples[0]!, output: "✓ Pull request o/r#12 is marked as\n", records: [] }, ...ready.examples] };
  const invented = { ...ready, examples: [...ready.examples, { command: "gh pr ready 7", output: READY.replace("#12", "#7"), error: false, records: ["marked ready PR #7"] }] };
  const flipped = { ...ready, examples: [...ready.examples.slice(0, 2), { ...ready.examples[2]!, error: false }] };
  for (const [draft, problem] of [
    [edited, "example 1: its output is not whole lines copied from a real result of that command with error false"],
    [partial, "example 1: its output is not whole lines copied from a real result of that command with error false"],
    [invented, "example 4: its command is not copied from a real result"],
    [flipped, "example 3: its output is not whole lines copied from a real result of that command with error false"],
  ] as const) {
    const checked = draftScript(t, "--check", JSON.stringify(draft));
    assert.equal(checked.status, 1, checked.stdout);
    assert.deepEqual(checked.stdout.trim().split("\n"), [problem]);
  }
});
