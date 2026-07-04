// Records of consequence (design language §12.19/§12.28): bash rows that change shared
// state — commit, push, PR merge/close/create, issue close, release/publish — earn
// verb-first record facts in the suffix, parsed from the *success porcelain the tool
// reported*, never from the command's arguments. These tests pin the exact porcelain
// shapes and the fact-toned ink.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-traceline/index.ts";

const { recordCells, recordSuffix, toolFactSuffix, stripAnsi } = internals;

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  g.__tracelineChat = undefined;
  g.__tracelineGetTheme = undefined;
});

function bash(command: string, output: string, options: { error?: boolean } = {}) {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: output }], isError: options.error === true },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`$ ${command}`] },
  };
}

const PUSH_OK = `To https://github.com/tmustier/pine-of-glass.git\n   1c75c2a..50cf33f  main -> main\n`;

test("commit porcelain yields a committed fact", () => {
  const comp = bash('git add -A && git commit -m "fix: thing"', "[main a4f21c9] fix: thing\n 1 file changed, 2 insertions(+)\n");
  assert.deepEqual(recordCells(comp), ["committed a4f21c9"]);
});

test("commit variants: root-commit and detached HEAD", () => {
  const root = bash("git commit -m init", "[main (root-commit) abc1234] init\n");
  assert.deepEqual(recordCells(root), ["committed abc1234"]);
  const detached = bash("git commit -m wip", "[detached HEAD deadbee] wip\n");
  assert.deepEqual(recordCells(detached), ["committed deadbee"]);
});

test("commit + push chain yields both facts in output order", () => {
  const comp = bash(
    'git add -A && git -c user.email=6326440+tmustier@users.noreply.github.com commit -m "docs: x" && git push',
    `[main a4f21c9] docs: x\n 2 files changed\n${PUSH_OK}`,
  );
  assert.deepEqual(recordCells(comp), ["committed a4f21c9", "pushed main"]);
});

test("push shapes: forced update, new branch, new tag; rejected never matches", () => {
  const forced = bash("git push --force", "To github.com:o/r.git\n + 1c75c2a...50cf33f main -> main (forced update)\n");
  assert.deepEqual(recordCells(forced), ["pushed main"]);
  const branch = bash("git push -u origin feat", "To github.com:o/r.git\n * [new branch]      feat -> feat\n");
  assert.deepEqual(recordCells(branch), ["pushed feat"]);
  const tag = bash("git push origin v0.5.9", "To github.com:o/r.git\n * [new tag]         v0.5.9 -> v0.5.9\n");
  assert.deepEqual(recordCells(tag), ["pushed v0.5.9"]);
  const rejected = bash("git push", "To github.com:o/r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n", { error: true });
  assert.deepEqual(recordCells(rejected), []);
  const upToDate = bash("git push", "Everything up-to-date\n");
  assert.deepEqual(recordCells(upToDate), []);
});

test("consecutive same-verb facts merge their data", () => {
  const comp = bash(
    "git push --follow-tags",
    "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n * [new tag]         v0.5.9 -> v0.5.9\n",
  );
  assert.deepEqual(recordCells(comp), ["pushed main, v0.5.9"]);
});

test("failed push after good commit keeps only the committed fact", () => {
  const comp = bash(
    "git commit -m fix && git push",
    "[main a4f21c9] fix\nTo github.com:o/r.git\n ! [rejected]        main -> main (fetch first)\n",
    { error: true },
  );
  assert.deepEqual(recordCells(comp), ["committed a4f21c9"]);
});

test("gh porcelain: merge, close, create, issue close, release", () => {
  const merged = bash("gh pr merge 87 --squash --delete-branch", "✓ Squashed and merged pull request tmustier/pine-of-glass#87 (traceline: records)\n✓ Deleted branch git-records\n");
  assert.deepEqual(recordCells(merged), ["merged PR #87"]);
  const closedPr = bash("gh pr close 12", "✓ Closed pull request tmustier/pine-of-glass#12 (stale)\n");
  assert.deepEqual(recordCells(closedPr), ["closed PR #12"]);
  const opened = bash("gh pr create --fill", "https://github.com/tmustier/pine-of-glass/pull/88\n");
  assert.deepEqual(recordCells(opened), ["opened PR #88"]);
  const closedIssue = bash("gh issue close 12", "✓ Closed issue tmustier/pine-of-glass#12 (rail glyphs)\n");
  assert.deepEqual(recordCells(closedIssue), ["closed #12"]);
  const released = bash("gh release create v0.5.9 --notes x", "https://github.com/tmustier/pine-of-glass/releases/tag/v0.5.9\n");
  assert.deepEqual(recordCells(released), ["released v0.5.9"]);
});

test("npm publish porcelain yields a published fact", () => {
  const comp = bash("npm publish", "npm notice Publishing to https://registry.npmjs.org/\n+ pine-of-glass@0.5.10\n");
  assert.deepEqual(recordCells(comp), ["published 0.5.10"]);
});

test("facts require both the gate and the porcelain", () => {
  // Porcelain-shaped text without the command: no facts.
  const cat = bash("cat CHANGELOG.md", "[main a4f21c9] docs: x\n   1c75c2a..50cf33f  main -> main\n");
  assert.deepEqual(recordCells(cat), []);
  // Command without porcelain (quoted phrase in a message): no facts.
  const quoted = bash('git commit -m "mention git push here"', "nothing committed\n");
  assert.deepEqual(recordCells(quoted), []);
  // git tag success porcelain is silence: no facts.
  const tag = bash("git tag v9.9.9", "");
  assert.deepEqual(recordCells(tag), []);
  // Non-bash rows never carry records.
  const read = { ...bash("x", "y"), toolName: "read" };
  assert.deepEqual(recordCells(read), []);
});

test("overflow drops whole facts oldest first, never mangles", () => {
  const comp = bash(
    "git commit -m x && git push",
    `[main a4f21c9] x\n${PUSH_OK}`,
  );
  // Plenty of room: both facts.
  assert.equal(stripAnsi(recordSuffix(comp, 120)), "committed a4f21c9 · pushed main");
  // Tight row (~76 available at 80 cols → cap 25): the oldest fact drops whole.
  assert.equal(stripAnsi(recordSuffix(comp, 76)), "pushed main");
  // Too tight for anything: no half-facts.
  assert.equal(stripAnsi(recordSuffix(comp, 20)), "");
});

test("records join the fact suffix before the size cell", () => {
  const output = `[main a4f21c9] x\n${PUSH_OK}${"x".repeat(300)}`;
  const comp = bash("git commit -m x && git push", output);
  assert.equal(stripAnsi(toolFactSuffix(comp, 200)), "committed a4f21c9 · pushed main · 0.4k ch");
});

test("records wear the ink of what they state (§12.28)", () => {
  const comp = bash("git commit -m x && git push", `[main a4f21c9] x\n${PUSH_OK}`);
  const raw = recordSuffix(comp, 200);
  // No theme in tests, so ink resolves to raw ANSI: success 32, warning 33, dim 90.
  // The committed verb is success-toned bold; the sha is opaque audit data — dim,
  // outside both the tone and the bold span.
  assert.match(raw, /\x1b\[32m\x1b\[1mcommitted\x1b\[22m\x1b\[0m/);
  assert.match(raw, /\x1b\[90m a4f21c9\x1b\[0m/);
  assert.doesNotMatch(raw, /\x1b\[1mcommitted a4f21c9/);
  // Meaningful data joins the verb's span: one chunk, one colour.
  assert.match(raw, /\x1b\[32m\x1b\[1mpushed main\x1b\[22m\x1b\[0m/);
});

test("a forced push tints warning; tones never merge across (§12.28)", () => {
  const forced = bash("git push --force", "To github.com:o/r.git\n + 1c75c2a...50cf33f main -> main (forced update)\n");
  assert.match(recordSuffix(forced, 200), /\x1b\[33m\x1b\[1mpushed main\x1b\[22m\x1b\[0m/);
  // A forced ref and a routine tag in one push stay separate cells: a forced push
  // never hides inside a routine one.
  const mixed = bash(
    "git push --force --follow-tags",
    "To github.com:o/r.git\n + 1c75c2a...50cf33f main -> main (forced update)\n * [new tag]         v0.5.9 -> v0.5.9\n",
  );
  assert.deepEqual(recordCells(mixed), ["pushed main", "pushed v0.5.9"]);
});

test("the tone is per-fact, not per-row: failed rows keep surviving facts green (§12.28)", () => {
  // Committed, demonstrably not landed: red discriminators, green fact.
  const failed = bash("git commit -m x && git push", "[main a4f21c9] x\n ! [rejected] main -> main\n", { error: true });
  assert.match(recordSuffix(failed, 200), /\x1b\[32m\x1b\[1mcommitted\x1b\[22m/);
});

test("facts cache against result identity", () => {
  const comp = bash("git commit -m x", "[main a4f21c9] x\n");
  assert.deepEqual(recordCells(comp), ["committed a4f21c9"]);
  // Same result object: cached (mutating the text without replacing result is not a
  // transition pi performs; identity is the honest cache key).
  assert.deepEqual(recordCells(comp), ["committed a4f21c9"]);
  // New result object: recomputed.
  (comp as any).result = { content: [{ type: "text", text: "[main b5e32d0] y\n" }], isError: false };
  assert.deepEqual(recordCells(comp), ["committed b5e32d0"]);
});
