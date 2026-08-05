// Records of consequence (design language §9.10): bash rows that change shared
// state — commit, push, PR merge/close/create, issue close, release/publish —
// graduate to verb-led outcome rows: the record leads and the command trails as
// provenance behind its `$`, parsed from the *success evidence the tool reported*.
// The explicit command target may fill in only targetless verified state output.
// These tests pin the exact evidence shapes, the headline placement, and the
// fact-toned ink.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-traceline/index.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";

const { recordCells, recordHeadline, toolFactSuffix, oneLine, stripAnsi, setTracelineChat, setTracelineThemeGetter } = internals;

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
});

function bash(command: string, output: string, options: { error?: boolean } = {}): ToolRowLike {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: output }], isError: options.error === true },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`$ ${command}`] },
  } as ToolRowLike;
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
  const stateChecked = bash(
    'gh pr merge 826 --squash --subject "stills: reorder investor logos (#826)" 2>&1 | tail -1; sleep 5; gh pr view 826 --json state -q .state',
    "MERGED\n",
  );
  assert.deepEqual(recordCells(stateChecked), ["merged PR #826"]);
  const stateCheckedWithSha = bash(
    'gh pr merge 89 --squash --subject "Reorder investor logos (#89)" 2>&1 | tail -1; sleep 5; gh pr view 89 --json state,mergeCommit -q \'.state + " " + .mergeCommit.oid\'',
    "MERGED 4bc400a9e5f3449df65ff96c32d008de0e89d011\n",
  );
  assert.deepEqual(recordCells(stateCheckedWithSha), ["merged PR #89"]);
  const stateCheckedWithJsonEquals = bash("gh pr merge 90 --squash && gh pr view 90 --json=state -q .state", "MERGED\n");
  assert.deepEqual(recordCells(stateCheckedWithJsonEquals), ["merged PR #90"]);
  const prUrl = "https://github.com/tmustier/pine-of-glass/pull/91";
  const stateCheckedWithUrl = bash(`gh pr merge ${prUrl} --squash && gh pr view ${prUrl} --json state -q .state`, "MERGED\n");
  assert.deepEqual(recordCells(stateCheckedWithUrl), ["merged PR #91"]);
  const closedPr = bash("gh pr close 12", "✓ Closed pull request tmustier/pine-of-glass#12 (stale)\n");
  assert.deepEqual(recordCells(closedPr), ["closed PR #12"]);
  const opened = bash("gh pr create --fill", "https://github.com/tmustier/pine-of-glass/pull/88\n");
  assert.deepEqual(recordCells(opened), ["opened PR #88"]);
  const closedIssue = bash("gh issue close 12", "✓ Closed issue tmustier/pine-of-glass#12 (rail glyphs)\n");
  assert.deepEqual(recordCells(closedIssue), ["closed #12"]);
  const released = bash("gh release create v0.5.9 --notes x", "https://github.com/tmustier/pine-of-glass/releases/tag/v0.5.9\n");
  assert.deepEqual(recordCells(released), ["released v0.5.9"]);
});

test("silent terminal gh merges yield a merged fact", () => {
  const direct = bash("gh pr merge 120 --squash --delete-branch\n", "(no output)");
  assert.deepEqual(recordCells(direct), ["merged PR #120"]);

  const fromWorktree = bash("cd /tmp/pr-137 && gh pr merge 137 --merge", "(no output)");
  assert.deepEqual(recordCells(fromWorktree), ["merged PR #137"]);

  const url = "https://github.com/tmustier/pine-of-glass/pull/138";
  const withRepo = bash(`gh pr merge --repo tmustier/pine-of-glass ${url} --squash`, "(no output)");
  assert.deepEqual(recordCells(withRepo), ["merged PR #138"]);
});

test("silent merge inference stays attributable to one merge", () => {
  const cases = [
    bash("gh pr merge 120 --auto", "(no output)"),
    bash("gh pr merge 120 --disable-auto", "(no output)"),
    bash("gh pr merge 120 --squash 2>&1 | tail -1", "(no output)"),
    bash("gh pr merge 120 --squash; git status --short", "(no output)"),
    bash("gh pr merge --squash", "(no output)"),
    bash("gh pr merge 120 --squash", "(no output)", { error: true }),
    bash("gh pr merge 120 --squash", "! Pull request tmustier/pine-of-glass#120 was already merged\n"),
  ];
  for (const comp of cases) assert.deepEqual(recordCells(comp), []);
});

test("same-row gh state verification accepts JSON output", () => {
  const merged = bash(
    "gh pr merge 126 --squash && gh pr view 126 --json state,mergedAt,mergeCommit,url",
    '{"mergeCommit":{"oid":"56692804b905502aaa151bb16f6a506d37e32884"},"mergedAt":"2026-08-05T11:16:46Z","state":"MERGED","url":"https://github.com/Nexcade/website/pull/126"}\n',
  );
  assert.deepEqual(recordCells(merged), ["merged PR #126"]);

  const open = bash(
    "gh pr merge 127 --squash && gh pr view 127 --json state",
    '{"state":"OPEN"}\n',
  );
  assert.deepEqual(recordCells(open), []);
});

test("npm publish porcelain yields a published fact", () => {
  const comp = bash("npm publish", "npm notice Publishing to https://registry.npmjs.org/\n+ pine-of-glass@0.5.10\n");
  assert.deepEqual(recordCells(comp), ["published 0.5.10"]);
});

test("facts require both the command gate and result evidence", () => {
  // Porcelain-shaped text without the command: no facts.
  const cat = bash("cat CHANGELOG.md", "[main a4f21c9] docs: x\n   1c75c2a..50cf33f  main -> main\n");
  assert.deepEqual(recordCells(cat), []);
  // Command without porcelain (quoted phrase in a message): no facts.
  const quoted = bash('git commit -m "mention git push here"', "nothing committed\n");
  assert.deepEqual(recordCells(quoted), []);
  // A targetless state word is only proof when the same row explicitly checked PR state.
  const mergeWithoutStateCheck = bash("gh pr merge 826 --squash", "MERGED\n");
  assert.deepEqual(recordCells(mergeWithoutStateCheck), []);
  const mergeTargetOnlyInSubject = bash(
    'gh pr merge --squash --subject "stills: reorder investor logos (#826)"; gh pr view 826 --json state -q .state',
    "MERGED\n",
  );
  assert.deepEqual(recordCells(mergeTargetOnlyInSubject), []);
  const mismatchedStateCheck = bash("gh pr merge 826 --squash; gh pr view 827 --json state -q .state", "MERGED\n");
  assert.deepEqual(recordCells(mismatchedStateCheck), []);
  const stateCheckBeforeMerge = bash("gh pr view 826 --json state -q .state; gh pr merge 826 --squash", "MERGED\n");
  assert.deepEqual(recordCells(stateCheckBeforeMerge), []);
  const failureBranchStateCheck = bash("gh pr merge 826 --squash || gh pr view 826 --json state -q .state", "MERGED\n");
  assert.deepEqual(recordCells(failureBranchStateCheck), []);
  const noisyStateOutput = bash("gh pr merge 826 --squash; gh pr view 826 --json state -q .state", "warning: already merged\nMERGED\n");
  assert.deepEqual(recordCells(noisyStateOutput), []);
  const branchTarget = bash("gh pr merge feature/logos --squash; gh pr view feature/logos --json state -q .state", "MERGED\n");
  assert.deepEqual(recordCells(branchTarget), []);
  const jqNoise = bash("gh pr merge 826 --squash; gh pr view 826 --json state -q '.state + \" #827\"'", "MERGED #827\n");
  assert.deepEqual(recordCells(jqNoise), []);
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
  assert.equal(stripAnsi(recordHeadline(comp, 120)), "committed a4f21c9 · pushed main");
  // Tight row (~76 available at 80 cols → cap 25): the oldest fact drops whole.
  assert.equal(stripAnsi(recordHeadline(comp, 76)), "pushed main");
  // Too tight for anything: no half-facts.
  assert.equal(stripAnsi(recordHeadline(comp, 20)), "");
});

test("records lead the row; the command trails behind its `$` (§9.10)", () => {
  const output = `[main a4f21c9] x\n${PUSH_OK}${"x".repeat(300)}`;
  const comp = bash("git commit -m x && git push", output);
  // No record in the suffix, and a 0.4k confirmation earns no size cell (§9.7).
  assert.equal(stripAnsi(toolFactSuffix(comp, 200)), "");
  const line = stripAnsi(oneLine(comp, 120));
  assert.ok(line.includes("committed a4f21c9 · pushed main $ git commit -m x && git push"), line);
  assert.ok(!line.includes(" ch"), line);
  // On a tighter row the cap (about a third, §9.10) drops the oldest fact whole,
  // and the command keeps its width.
  const tight = stripAnsi(oneLine(comp, 100));
  assert.ok(tight.includes("pushed main $ git commit -m x && git push"), tight);
  assert.ok(!tight.includes("committed"), tight);
});

test("a ballooning record output re-earns its size cell at warning severity (§9.10)", () => {
  const comp = bash("git push", `${PUSH_OK}${"y".repeat(12_000)}`);
  assert.match(stripAnsi(toolFactSuffix(comp, 200)), /^12\.[01]k ch$/);
  const line = stripAnsi(oneLine(comp, 100));
  assert.ok(line.includes("pushed main $ git push"), line);
  assert.ok(/12\.[01]k ch$/.test(line.trimEnd()), line);
});

test("a record-less bash row keeps `$ command` at the left edge", () => {
  const comp = bash("git status --short", " M index.ts\n");
  const line = stripAnsi(oneLine(comp, 100));
  assert.match(line, /› \$ git status --short/);
});

test("records wear the ink of what they state (§9.10)", () => {
  const comp = bash("git commit -m x && git push", `[main a4f21c9] x\n${PUSH_OK}`);
  const raw = recordHeadline(comp, 200);
  // No theme in tests, so ink resolves to raw ANSI: success 32, warning 33, dim 90.
  // The committed verb is success-toned bold; the sha is opaque audit data — dim,
  // outside both the tone and the bold span.
  assert.match(raw, /\x1b\[32m\x1b\[1mcommitted\x1b\[22m\x1b\[0m/);
  assert.match(raw, /\x1b\[90m a4f21c9\x1b\[0m/);
  assert.doesNotMatch(raw, /\x1b\[1mcommitted a4f21c9/);
  // Meaningful data joins the verb's span: one chunk, one colour.
  assert.match(raw, /\x1b\[32m\x1b\[1mpushed main\x1b\[22m\x1b\[0m/);
});

test("a forced push tints warning; tones never merge across (§9.10)", () => {
  const forced = bash("git push --force", "To github.com:o/r.git\n + 1c75c2a...50cf33f main -> main (forced update)\n");
  assert.match(recordHeadline(forced, 200), /\x1b\[33m\x1b\[1mpushed main\x1b\[22m\x1b\[0m/);
  // A forced ref and a routine tag in one push stay separate cells: a forced push
  // never hides inside a routine one.
  const mixed = bash(
    "git push --force --follow-tags",
    "To github.com:o/r.git\n + 1c75c2a...50cf33f main -> main (forced update)\n * [new tag]         v0.5.9 -> v0.5.9\n",
  );
  assert.deepEqual(recordCells(mixed), ["pushed main", "pushed v0.5.9"]);
});

test("the tone is per-fact, not per-row: failed rows keep surviving facts green (§9.10)", () => {
  // Committed, demonstrably not landed: red discriminators, green fact.
  const failed = bash("git commit -m x && git push", "[main a4f21c9] x\n ! [rejected] main -> main\n", { error: true });
  assert.match(recordHeadline(failed, 200), /\x1b\[32m\x1b\[1mcommitted\x1b\[22m/);
});

test("facts cache against result identity", () => {
  const comp = bash("git commit -m x", "[main a4f21c9] x\n");
  assert.deepEqual(recordCells(comp), ["committed a4f21c9"]);
  // Same result object: cached (mutating the text without replacing result is not a
  // transition pi performs; identity is the honest cache key).
  assert.deepEqual(recordCells(comp), ["committed a4f21c9"]);
  // New result object: recomputed.
  comp.result = { content: [{ type: "text", text: "[main b5e32d0] y\n" }], isError: false };
  assert.deepEqual(recordCells(comp), ["committed b5e32d0"]);
});
