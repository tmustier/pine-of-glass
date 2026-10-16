// Compound bash rows (design language §9.4, §9.8, §9.10.1): agents now chain several
// commands per call, and a single middle cut kept the opening `cd` and the closing
// filter while hiding the commands between them. These tests pin the by-command fit,
// the cwd-relative and nested `cd` context, and check facts parsed from runner output.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { internals } from "../../extensions/pi-traceline/index.ts";
import { fitCompoundCommand, type FitPiece } from "../../extensions/pi-traceline/compound-fit.ts";
import { checkFacts } from "../../extensions/pi-traceline/checks.ts";
import { relativizeContextCd } from "../../extensions/pi-traceline/bash-preamble.ts";
import { bashCrownedHeads } from "../../extensions/pi-traceline/bash-crowns.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { assistantBefore, nativeBashLines } from "./runtime-fixtures.ts";

const { stripAnsi, oneLine, recordCells, setTracelineChat, setTracelineThemeGetter } = internals;

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
});

function bash(command: string, output = "ok", options: { cwd?: string; error?: boolean } = {}): ToolRowLike {
  return {
    toolName: "bash",
    args: { command },
    cwd: options.cwd,
    result: { content: [{ type: "text", text: output }], isError: options.error === true },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => nativeBashLines(command) },
  } as ToolRowLike;
}

function render(body: string, pieces: FitPiece[]): string {
  return pieces.map((piece) => `${body.slice(piece.start, piece.end)}${piece.mark ?? ""}`).join("");
}

function fit(body: string, budget: number): string | undefined {
  const pieces = fitCompoundCommand(body, bashCrownedHeads(body), budget);
  return pieces ? render(body, pieces) : undefined;
}

const SCREENSHOT_BODY =
  'cd ~/projects/pinet/.worktrees/review-1068/slack-bridge && git add -A && (pnpm lint 2>&1 | grep -v "npm notice" | tail -15) && (pnpm typecheck 2>&1 | tail -4) && npx prettier --check slack-bridge/host-runner.ts slack-bridge/join-profile.ts 2>&1 | tail -3';

test("a compound row that overflows keeps every crowned head and fills its budget (§9.8)", () => {
  for (const budget of [70, 90, 120]) {
    const shown = fit(SCREENSHOT_BODY, budget);
    assert.ok(shown, `budget ${budget} should fit by command`);
    for (const head of ["git add", "pnpm lint", "pnpm typecheck", "npx prettier"]) {
      assert.ok(shown.includes(head.split(" ")[0]!), `${head} head must survive at ${budget}: ${shown}`);
    }
    assert.ok(shown.length <= budget, `${shown.length} > ${budget}: ${shown}`);
    assert.ok(shown.length >= budget - 3, `row should end near flush: ${shown.length} of ${budget}`);
  }
  // Short commands stay whole while long ones are cut back (water-filling).
  assert.match(fit(SCREENSHOT_BODY, 120)!, /git add -A && /);
});

test("a compound row's context keeps its final directory; git keeps its subcommand (§9.8)", () => {
  const shown = fit(SCREENSHOT_BODY, 80)!;
  assert.match(shown, /^cd …[^ ]*slack-bridge && /, shown);
  const commit = 'git -c user.name="Thomas Mustier" -c user.email=6326440+tmustier@users.noreply.github.com commit -m "Drop the reviewer rollback" && git log --oneline -1';
  const fitted = fit(commit, 60)!;
  assert.match(fitted, /^git … commit -m /, fitted);
  assert.match(fitted, /git log/, fitted);
});

test("rows that fit, single commands and impossible budgets keep the old path (§9.8)", () => {
  assert.equal(fit("git status && git diff", 80), undefined, "a fitting row is untouched");
  assert.equal(fit(`python3 -c '${"x".repeat(200)}' | tail -2`, 60), undefined, "one crowned head keeps the middle cut");
  assert.equal(fit(SCREENSHOT_BODY, 20), undefined, "bare heads that overflow fall back");
});

test("rendered compound rows keep every command visible inside the block grid", () => {
  const comp = bash(SCREENSHOT_BODY.replace("~", homedir()), "x".repeat(700));
  const line = stripAnsi(oneLine(comp, 110));
  for (const head of ["git", "pnpm lint", "pnpm typecheck", "npx"]) assert.ok(line.includes(head.split(" ").at(-1)!), line);
  assert.ok(line.endsWith("0.7k ch"), line);
  assert.equal(line.length, 110 - 2, "row honours the two-column right inset");
});

test("leading cd prints relative to the row cwd (§9.4)", () => {
  assert.equal(relativizeContextCd("cd ~/repo/.worktrees/fix && npm test", "~/repo"), "cd ./.worktrees/fix && npm test");
  assert.equal(relativizeContextCd("cd ~/repo && npm test", "~/repo"), "cd . && npm test");
  assert.equal(relativizeContextCd("cd ~/other && npm test", "~/repo"), "cd ~/other && npm test");
  assert.equal(relativizeContextCd("npm test && cd ~/repo/x", "~/repo"), "npm test && cd ~/repo/x", "interior cd keeps its text");
  const comp = bash(`cd ${homedir()}/repo/.worktrees/fix && npm test`, "ok", { cwd: `${homedir()}/repo` });
  setTracelineChat({ children: [assistantBefore([comp]), comp] });
  assert.match(stripAnsi(oneLine(comp, 120)), /\$ cd \.\/\.worktrees\/fix && npm test/);
});

test("a leading cd through a symlink still prints relative to the resolved cwd (§9.4, §9.5)", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "traceline-cd-")));
  const cwd = join(scratch, "repo"), alias = join(scratch, "alias");
  try {
    mkdirSync(join(cwd, "packages/pricing"), { recursive: true });
    const command = `cd ${alias}/packages/pricing && npx vitest run`;
    const missing = bash(command, "ok", { cwd });
    setTracelineChat({ children: [assistantBefore([missing]), missing] });
    assert.ok(stripAnsi(oneLine(missing, 240)).includes(command));
    symlinkSync(cwd, alias);
    for (const [target, shown] of [
      [`${alias}/packages/pricing`, "./packages/pricing"],
      [alias, "."],
      [scratch, scratch],
      [`${alias}/gone/later`, "./gone/later"],
    ]) {
      const row = bash(`cd ${target} && ls`, "ok", { cwd });
      setTracelineChat({ children: [assistantBefore([row]), row] });
      assert.equal(stripAnsi(oneLine(row, 240)), `  ▏ › $ cd ${shown} && ls`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a cd below the previous row's cd folds the shared part into ⋯ (§9.4)", () => {
  const cwd = `${homedir()}/projects/pinet`;
  const parent = bash(`cd ${cwd}/.worktrees/review-1068 && git status`, "ok", { cwd });
  const child = bash(`cd ${cwd}/.worktrees/review-1068/slack-bridge && pnpm lint`, "ok", { cwd });
  const back = bash(`cd ${cwd}/.worktrees/review-1068 && git diff`, "ok", { cwd });
  setTracelineChat({ children: [assistantBefore([parent, child, back]), parent, child, back] });
  assert.match(stripAnsi(oneLine(child, 120)), /\$ cd ⋯\/slack-bridge && pnpm lint/);
  assert.match(stripAnsi(oneLine(back, 120)), /\$ cd \.\/\.worktrees\/review-1068 && git diff/, "a parent dir is not folded");
});

const VITEST_PASS = " Test Files  89 passed (89)\n      Tests  1731 passed (1731)\n   Duration  21.4s\n";
const VITEST_FAIL = " Test Files  1 failed | 88 passed (89)\n      Tests  2 failed | 1729 passed (1731)\n";

test("test summaries become check facts; a pass is neutral, a failure is news (§9.10.1)", () => {
  const pass = bash('pnpm test 2>&1 | grep -E "Test Files|Tests"', VITEST_PASS);
  assert.deepEqual(checkFacts(pass).map((f) => [f.verb, f.datum, f.tone]), [["passed", "1731 tests", "text"]]);
  const fail = bash("pnpm test | tail -5", VITEST_FAIL);
  assert.deepEqual(checkFacts(fail).map((f) => [f.verb, f.datum, f.tone]), [["failed", "2 of 1731 tests", "error"]]);
  const jest = bash("npx jest", "Tests:       1 failed, 40 passed, 41 total\n");
  assert.equal(checkFacts(jest)[0]?.datum, "1 of 41 tests");
  const pytest = bash("uv run pytest -q", "........\n12 passed, 1 skipped in 0.52s\n");
  assert.equal(checkFacts(pytest)[0]?.datum, "12 tests");
  const nodeTest = bash("npm test", "ℹ tests 29\nℹ pass 28\nℹ fail 1\n");
  assert.equal(checkFacts(nodeTest)[0]?.datum, "1 of 29 tests");
  const cargo = bash("cargo test", "test result: ok. 10 passed; 0 failed; 0 ignored\ntest result: ok. 3 passed; 0 failed; 0 ignored\n");
  assert.equal(checkFacts(cargo)[0]?.datum, "13 tests");
});

test("type, lint and format checks report counts; silence is not a pass (§9.10.1)", () => {
  const tsc = bash("pnpm typecheck", "src/a.ts(3,5): error TS2322: nope\nsrc/b.ts(9,1): error TS2345: nope\n");
  assert.deepEqual(checkFacts(tsc).map((f) => `${f.verb} ${f.datum}`), ["found type errors"], "diagnostics alone give no count");
  const summary = bash("npx tsc --noEmit | tail -1", "Found 3 errors in 2 files.\n");
  assert.deepEqual(checkFacts(summary).map((f) => `${f.verb} ${f.datum}`), ["found 3 type errors"]);
  assert.deepEqual(checkFacts(bash("npx tsc --noEmit", "")), [], "a quiet tsc earns nothing");
  const oxlint = bash("npx oxlint .", "Found 0 warnings and 0 errors.\nFinished in 40ms\n");
  assert.deepEqual(checkFacts(oxlint).map((f) => `${f.verb} ${f.datum}`), ["passed lint"]);
  const eslint = bash("npx eslint .", "\u2716 5 problems (3 errors, 2 warnings)\n");
  assert.deepEqual(checkFacts(eslint).map((f) => [f.datum, f.tone]), [["3 lint errors", "error"]]);
  const prettier = bash("npx prettier --check .", "[warn] a.ts\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n");
  assert.deepEqual(checkFacts(prettier).map((f) => [f.datum, f.tone]), [["1 unformatted file", "warning"]]);
  assert.deepEqual(checkFacts(bash("cat test-log.txt", VITEST_FAIL)), [], "a command that names no checker earns nothing");
});

test("check facts lead the row, keep the size cell, and a failed check under exit 0 warns (§9.2, §9.10.1)", () => {
  const output = `${"x".repeat(400)}\n${VITEST_PASS}`;
  const pass = bash(`cd ${homedir()}/repo && pnpm test 2>&1 | tail -30`, output);
  const line = stripAnsi(oneLine(pass, 120));
  assert.match(line, /› passed 1731 tests \$ cd ~\/repo && pnpm test/, line);
  assert.match(line, /0\.5k ch$/, "a check row keeps its size cell");

  const fail = bash("pnpm test | tail -5", VITEST_FAIL);
  const failLine = oneLine(fail, 120);
  assert.match(stripAnsi(failLine), /› failed 2 of 1731 tests \$ pnpm test/);
  assert.match(failLine, /\x1b\[33m›/, "exit 0 with a failed check wears a warning bullet");

  const lint = bash("pnpm lint && pnpm test", `Found 0 warnings and 0 errors.\n${VITEST_PASS}`);
  assert.deepEqual(recordCells(lint), ["passed lint, 1731 tests"]);
});

test("a headline over its cap drops other facts before a failed check (§9.10.1)", () => {
  const output = "bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
    "Checking formatting...\n[warn] package.json\n[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n";
  const row = bash("cd pkg && (tsc --noEmit -p . 2>&1 | tail -15) ; npx prettier --check math.test.mjs package.json 2>&1 | tail -3", output);
  const narrow = stripAnsi(oneLine(row, 100));
  assert.match(narrow, /› found type errors \$/, narrow);
  assert.doesNotMatch(narrow, /unformatted/, "the warning gives way to the failure");
  assert.match(stripAnsi(oneLine(row, 200)), /› found type errors · found 1 unformatted file \$/, "both fit when there is room");
});
