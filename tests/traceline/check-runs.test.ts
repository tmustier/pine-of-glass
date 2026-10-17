import { test } from "node:test";
import assert from "node:assert/strict";

import { AssistantMessageComponent, createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import piTraceline from "../../extensions/pi-traceline/index.ts";
import { checkFacts } from "../../extensions/pi-traceline/checks.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, RecordedUi } from "../harness/extension-host.ts";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";

function facts(command: string, output: string): string[] {
  return checkFacts({
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: output }], isError: false },
    isPartial: false,
  }).map((fact) => `${fact.verb} ${fact.datum}`);
}

const vitestRun = (tests: string, total: number) => ` Test Files  1 passed (1)\n      Tests  ${tests} (${total})\n   Duration  1.2s\n`;

test("each run states its own fact; reruns never add up, different suites run once do (§9.10.1)", () => {
  const loop = "for i in 1 2 3; do npx vitest run a.test.ts; done";
  const three = vitestRun("17 passed", 17).repeat(3);
  assert.deepEqual(facts(loop, three), ["passed 17 tests", "passed 17 tests", "passed 17 tests"]);

  const comparison = "npx vitest run a.test.ts; git stash; npx vitest run a.test.ts";
  const redGreen = vitestRun("1 failed | 1 passed", 2) + "Saved working directory\n" + vitestRun("2 passed", 2);
  assert.deepEqual(facts(comparison, redGreen), ["failed 1 of 2 tests", "passed 2 tests"], "a comparison reads in output order");

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

test("headlines collapse identical reruns and keep the newest datum, records and failures when crowded (§9.10.1)", async () => {
  initTheme(undefined, false);
  const project = new IsolatedProject();
  const { view } = mouseViewport();
  const chat = new Container();
  view.addChild(chat);

  function row(command: string, output: string): ToolExecutionComponent {
    const id = `check-${chat.children.length}`;
    const args = { command };
    const comp = new ToolExecutionComponent("bash", id, args, {}, createBashToolDefinition(project.dir), view, project.dir);
    comp.updateResult({ content: [{ type: "text", text: output }], isError: false });
    chat.addChild(new AssistantMessageComponent(assistantMessage([
      { type: "toolCall", id, name: "bash", arguments: args },
    ]), true));
    chat.addChild(comp);
    return comp;
  }
  const repeated = row("for i in 1 2 3; do npx vitest run a.test.ts; done", vitestRun("17 passed", 17).repeat(3));
  const comparison = row("npx vitest run a.test.ts; git stash; npx vitest run a.test.ts",
    vitestRun("1 failed | 1 passed", 2) + "Saved working directory\n" + vitestRun("2 passed", 2));
  const crowded = row("for p in a b c d e f; do npx vitest run --project $p 2>&1 | grep -E 'Tests '; done",
    [15, 11, 13, 46, 226, 1731].map((n) => `      Tests  ${n} passed (${n})`).join("\n"));
  const landed = row("git commit -m 'Add receipt' && npx vitest run && node --test legacy/",
    "[main 96c35aa] Add receipt\n 3 files changed\n Test Files  3 passed (3)\n      Tests  8 passed (8)\nℹ pass 3\nℹ fail 0\n");
  const files = row("export PATH=/opt/node/bin:$PATH; npm run typecheck | head; npx vitest run 2>&1 | tail -4",
    " Test Files  5 failed | 17 passed (22)\n      Tests  63 passed (63)\n");
  const host = await hostExtension(piTraceline, { project, ui: new RecordedUi(undefined, view) });
  const painted = (comp: ToolExecutionComponent, width: number) => stripAnsi(comp.render(width).join("\n"));
  try {
    assert.match(painted(repeated, 200), /› passed 17 tests \$/, "identical reruns collapse; no `51 tests`");
    assert.match(painted(comparison, 200), /› failed 1 of 2 tests · passed 2 tests \$/, "a comparison reads in output order");
    assert.match(painted(crowded, 80), /› passed 1731 tests \+5 \$/, "a crowded row counts the runs it dropped");
    assert.match(painted(crowded, 200), /› passed (\d+ tests, )+1731 tests \+\d+ \$/, "wide rows keep more of the chain");
    assert.match(painted(landed, 200), /› committed 96c35aa · passed 11 tests \$/);
    assert.match(painted(landed, 90), /› committed 96c35aa \+1 \$/, "a pass gives way to a record");
    assert.match(painted(files, 80), /› failed 5 of 22 test files \$/);
  } finally {
    await host.dispose();
    project.dispose();
  }
});
