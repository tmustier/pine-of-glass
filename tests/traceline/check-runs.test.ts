// Check facts per run (design language §9.10.1): agents rerun checks in loops, before
// and after an edit, and as red-then-green comparisons, and a sum across those runs is
// a number no run printed. These tests pin one fact per run, the summaries that prove
// a pass, and how a crowded headline keeps the newest fact and any failure.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-traceline/index.ts";
import { checkFacts } from "../../extensions/pi-traceline/checks.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { assistantBefore, nativeBashLines } from "./runtime-fixtures.ts";

const { stripAnsi, oneLine, recordCells, setTracelineChat, setTracelineThemeGetter } = internals;

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
});

function bash(command: string, output: string): ToolRowLike {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: output }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => nativeBashLines(command) },
  } as ToolRowLike;
}

function facts(command: string, output: string): string[] {
  return checkFacts(bash(command, output)).map((fact) => `${fact.verb} ${fact.datum}`);
}

const vitestRun = (tests: string, total: number) => ` Test Files  1 passed (1)\n      Tests  ${tests} (${total})\n   Duration  1.2s\n`;

test("each run states its own fact; reruns never add up, different suites run once do (§9.10.1)", () => {
  const loop = "for i in 1 2 3; do npx vitest run a.test.ts; done";
  const three = vitestRun("17 passed", 17).repeat(3);
  assert.deepEqual(facts(loop, three), ["passed 17 tests", "passed 17 tests", "passed 17 tests"]);
  assert.deepEqual(recordCells(bash(loop, three)), ["passed 17 tests"], "identical reruns collapse; no `51 tests`");

  const comparison = "npx vitest run a.test.ts; git stash; npx vitest run a.test.ts";
  const redGreen = vitestRun("1 failed | 1 passed", 2) + "Saved working directory\n" + vitestRun("2 passed", 2);
  assert.deepEqual(recordCells(bash(comparison, redGreen)), ["failed 1 of 2 tests", "passed 2 tests"], "a comparison reads in output order");

  const labelled = "for tz in UTC Asia/Tokyo; do echo -n \"$tz \"; TZ=$tz npx vitest run 2>&1 | grep 'Tests '; done";
  assert.deepEqual(facts(labelled, "UTC          Tests  5 passed (5)\nAsia/Tokyo   Tests  1 failed | 4 passed (5)\n"), ["passed 5 tests", "failed 1 of 5 tests"]);

  const verify = "npx vitest run && npx tsc --noEmit -p . && node --test legacy/ 2>&1 | grep -E '^ℹ (pass|fail)'";
  const suites = " Test Files  3 passed (3)\n      Tests  8 passed (8)\nℹ pass 3\nℹ fail 0\n";
  assert.deepEqual(facts(verify, suites), ["passed 11 tests"], "different runners once each are one check of several suites");
  const mixed = " Test Files  3 passed (3)\n      Tests  8 passed (8)\nℹ pass 2\nℹ fail 1\n";
  assert.deepEqual(facts(verify, mixed), ["failed 1 of 11 tests"]);
  const rerun = vitestRun("1 failed | 7 passed", 8) + vitestRun("8 passed", 8) + "ℹ pass 3\nℹ fail 0\n";
  assert.deepEqual(facts(verify, rerun), ["failed 1 of 8 tests", "passed 8 tests", "passed 3 tests"], "a rerun keeps every run separate");

  const cargo = "cargo test && cargo test --release";
  const finished = "    Finished `test` profile\ntest result: ok. 10 passed; 0 failed; 0 ignored\ntest result: ok. 3 passed; 0 failed; 0 ignored\n";
  assert.deepEqual(facts(cargo, finished + finished), ["passed 13 tests", "passed 13 tests"], "one cargo invocation's targets are one run");
});

test("a pass needs a summary that proves zero failures (§9.10.1)", () => {
  const fileFailed = " Test Files  1 failed | 4 passed (5)\n      Tests  34 passed (34)\n";
  assert.deepEqual(facts("npm test 2>&1 | tail -20", fileFailed), ["failed 1 of 5 test files"], "a test file that failed to load is not a pass");
  assert.deepEqual(facts("npx vitest run a.test.ts", " Test Files  1 failed (1)\n      Tests  no tests\n"), ["failed 1 of 1 test file"]);
  const unhandled = " Test Files  1 passed (1)\n      Tests  2 passed (2)\n     Errors  1 error\n";
  assert.deepEqual(facts("npx vitest run", unhandled), ["found 1 unhandled error"]);
  const jest = "Test Suites: 1 failed, 3 passed, 4 total\nTests:       40 passed, 40 total\n";
  assert.deepEqual(facts("npx jest", jest), ["failed 1 of 4 test files"]);

  assert.deepEqual(facts("node --test 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\\n' ' '", "ℹ pass 7 ℹ fail 0 \n"), ["passed 7 tests"], "joined node counts");
  assert.deepEqual(facts("node --test | grep '^ℹ fail'", "ℹ fail 2\n"), ["failed 2 tests"], "no total when only failures survived the pipe");
  assert.deepEqual(facts("node --test | head -8", "ℹ tests 425\nℹ suites 0\nℹ pass 419\n"), [], "a fail count cut by head proves nothing");
  assert.deepEqual(facts("npm test", "# tests 98\n# pass 70\n# fail 12\n# cancelled 16\n"), ["failed 28 of 98 tests"], "cancelled tests fail the run");
});

test("type, lint and format runs are separate facts too (§9.10.1)", () => {
  const twice = "Found 3 errors in 2 files.\n\nFound 1 error in a.ts:4\n";
  assert.deepEqual(facts("npx tsc -p a; npx tsc -p b", twice), ["found 3 type errors", "found 1 type error"]);
  const eslint = "\u2716 2 problems (0 errors, 2 warnings)\n\u2716 1 problem (1 error, 0 warnings)\n";
  assert.deepEqual(facts("npx eslint a; npx eslint b", eslint), ["found 2 lint warnings", "found 1 lint error"]);
});

test("a crowded headline drops passes first, keeps the newest datum, and keeps a lone failure (§9.10.1)", () => {
  const command = "for p in a b c d e f; do npx vitest run --project $p 2>&1 | grep -E 'Tests '; done";
  const output = [15, 11, 13, 46, 226, 1731].map((n) => `      Tests  ${n} passed (${n})`).join("\n");
  const row = bash(command, output);
  setTracelineChat({ children: [assistantBefore([row]), row] });
  const narrow = stripAnsi(oneLine(row, 80));
  assert.match(narrow, /› passed 1731 tests \$/, narrow);
  assert.match(stripAnsi(oneLine(row, 200)), /› passed (\d+ tests, )+1731 tests \$/, "wide rows keep more of the chain");

  const landed = bash("git commit -m 'Add receipt' && npx vitest run && node --test legacy/",
    "[main 96c35aa] Add receipt\n 3 files changed\n Test Files  3 passed (3)\n      Tests  8 passed (8)\nℹ pass 3\nℹ fail 0\n");
  setTracelineChat({ children: [assistantBefore([landed]), landed] });
  assert.match(stripAnsi(oneLine(landed, 200)), /› committed 96c35aa · passed 11 tests \$/);
  const cramped = stripAnsi(oneLine(landed, 90));
  assert.match(cramped, /› committed 96c35aa \$/, `a pass gives way to a record: ${cramped}`);

  const files = bash("export PATH=/opt/node/bin:$PATH; npm run typecheck | head; npx vitest run 2>&1 | tail -4", " Test Files  5 failed | 17 passed (22)\n      Tests  63 passed (63)\n");
  setTracelineChat({ children: [assistantBefore([files]), files] });
  const failure = stripAnsi(oneLine(files, 80));
  assert.match(failure, /› failed 5 of 22 test files \$/, failure);
});
