// Repetition folding + preamble reclaim (issue #14, design language §9.4): a leading
// `set -…` hygiene run drops and the surviving `cd`/assignment context folds to a dim ⋯
// when it repeats the previous bash row's. Read folding lives in read-folds.test.ts.
// Comps are synthetic duck-type stand-ins; the contract suite proves the duck types
// against the real installed pi.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { internals } from "../../extensions/pi-traceline/index.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { assistantBefore, completedReadRow, nativeBashLines } from "./runtime-fixtures.ts";

const {
  stripAnsi,
  oneLine,
  bashPreambleRun,
  foldBashPreamble,
  renderTraceRow,
  repetitionRun,
  setTracelineChat,
  setTracelineThemeGetter,
} = internals;

const DIM = "\x1b[90m"; // raw-ANSI fallback for the family dim tone (no theme in tests)
const FOLD_MARK = "\u22ef";
const NL = "\u21b5"; // the flattened line-break mark

// pi's bash renderer returns one array element per visual line; traceline flattens them
// with a dim ↵. A synthetic command with `\n` reproduces that multi-line render, so
// preamble runs written across real breaks (`set …\ncd …\ncmd`) exercise the flatten.
function bashComp(command: string): ToolRowLike {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: "ok" }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => nativeBashLines(command) },
  } as ToolRowLike;
}

function mcpComp(id: string, resultChars: number, isError = false): ToolRowLike {
  return {
    toolName: "mcp",
    args: { tool: "linear_save_issue", args: { id } },
    result: { content: [{ type: "text", text: "x".repeat(resultChars) }], isError },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => ["mcp call linear_save_issue"] },
  } as ToolRowLike;
}

const proseBefore = (rows: ToolRowLike[]) => assistantBefore(rows, [{ type: "text", text: "now let me check" }]);
const collapsedThinkingBefore = (row: ToolRowLike) => assistantBefore([row], [{ type: "thinking", thinking: "hmm" }], true);

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
});

test("identical compact invocations in one assistant step fold with a count and combined size", () => {
  const a = mcpComp("NEXSELL-1", 700);
  const b = mcpComp("NEXSELL-2", 800);
  const c = mcpComp("NEXSELL-3", 900);
  setTracelineChat({ children: [assistantBefore([a, b, c]), a, b, c] });

  const run = repetitionRun(b);
  assert.ok(run, "a middle call must see its assistant-step fold");
  assert.equal(run!.rows.length, 3);
  assert.equal(run!.index, 1);

  const first = renderTraceRow(a, 100);
  const visible = stripAnsi(first.at(-1)!);
  assert.ok(visible.includes("mcp call linear_save_issue ×3"), visible);
  assert.ok(visible.endsWith("2.4k ch"), `landed result sizes sum: ${visible}`);
  assert.deepEqual(renderTraceRow(b, 100), [], "later repeated calls render nothing");
  assert.deepEqual(renderTraceRow(c, 100), [], "the first call carries the fold");
});

test("identical invocations in separate assistant steps stay separate", () => {
  const a = mcpComp("NEXSELL-1", 200);
  const b = mcpComp("NEXSELL-2", 300);
  setTracelineChat({ children: [assistantBefore([a]), a, assistantBefore([b]), b] });

  assert.equal(repetitionRun(a), undefined);
  assert.equal(repetitionRun(b), undefined);
  assert.ok(!stripAnsi(renderTraceRow(a, 100).at(-1)!).includes("×"));
  assert.ok(!stripAnsi(renderTraceRow(b, 100).at(-1)!).includes("×"));
});

test("an expanded row splits a same-step repetition fold", () => {
  const a = mcpComp("NEXSELL-1", 100);
  const expanded = { ...mcpComp("NEXSELL-2", 100), expanded: true } as ToolRowLike;
  const c = mcpComp("NEXSELL-3", 100);
  setTracelineChat({ children: [assistantBefore([a, expanded, c]), a, expanded, c] });

  assert.equal(repetitionRun(a), undefined, "a fold cannot cross a native expanded row");
  assert.equal(repetitionRun(expanded), undefined);
  assert.equal(repetitionRun(c), undefined);
});

test("a failed member makes the folded repetition visibly fail", () => {
  const ok = mcpComp("NEXSELL-1", 100);
  const failed = mcpComp("NEXSELL-2", 100, true);
  setTracelineChat({ children: [assistantBefore([ok, failed]), ok, failed] });

  const line = renderTraceRow(ok, 100).at(-1)!;
  assert.ok(line.includes("\x1b[31m›"), "the folded bullet is red when any call failed");
  assert.ok(line.includes("\x1b[31m\x1b[1mmcp"), "the folded invocation keeps error emphasis");
  assert.ok(stripAnsi(line).includes("×2"));
});

test("leading set drops on first appearance; repeated context folds to a dim ⋯", () => {
  const first = bashComp("set -euo pipefail\ncd /tmp/pog-demo\nnpm test");
  const second = bashComp("set -euo pipefail\ncd /tmp/pog-demo\nnpm run typecheck");
  setTracelineChat({ children: [proseBefore([first, second]), first, second] });

  const firstVisible = stripAnsi(oneLine(first, 120));
  const secondVisible = stripAnsi(oneLine(second, 120));

  // Lever B: the set -… hygiene drops even on the first row; context prints once.
  assert.ok(!firstVisible.includes("set -euo pipefail"), `set hygiene drops: ${firstVisible}`);
  assert.ok(firstVisible.includes("cd /tmp/pog-demo"), firstVisible);
  assert.ok(firstVisible.includes("npm test"), firstVisible);

  // Lever A: the repeated context folds to ⋯, absorbing set + cd + both separators.
  assert.ok(secondVisible.includes(`$ ${FOLD_MARK} npm run typecheck`), secondVisible);
  assert.ok(!secondVisible.includes("cd /tmp"), `repeated context must not re-print: ${secondVisible}`);
  assert.ok(!secondVisible.includes("set -"), `folded row carries no set: ${secondVisible}`);
  assert.ok(oneLine(second, 120).includes(`${DIM}${FOLD_MARK}`), "the ⋯ must open a dim run");
});

test("the ⋯ absorbs its trailing separator, and context folds across separator styles", () => {
  // Inline `cd … && cmd` first, newline-form second: both establish `cd /tmp/z`.
  const a = bashComp("cd /tmp/z && ls");
  const b = bashComp("set -e\ncd /tmp/z\nnpm test");
  setTracelineChat({ children: [a, b] });

  const av = stripAnsi(oneLine(a, 120));
  const bv = stripAnsi(oneLine(b, 120));
  assert.ok(av.includes("cd /tmp/z && ls"), `the first context prints in full: ${av}`);
  assert.ok(bv.includes(`$ ${FOLD_MARK} npm test`), `context folds whatever separator wrote it: ${bv}`);
  assert.ok(!bv.includes("&&"), `the ⋯ absorbs the separator, no dangling &&: ${bv}`);
  assert.ok(!bv.includes(NL), `no dangling ↵ after the ⋯: ${bv}`);
});

test("folding scans past interleaved reads but never across visible prose", () => {
  const a = bashComp("cd /tmp/pog-demo && ls");
  const read = completedReadRow(`${homedir()}/projects/demo/file.ts`, 1, 40);
  const b = bashComp("cd /tmp/pog-demo && cat out.txt");
  const c = bashComp("cd /tmp/pog-demo && rm out.txt");
  setTracelineChat({ children: [a, read, b, proseBefore([c]), c] });

  assert.ok(stripAnsi(oneLine(b, 120)).includes(`$ ${FOLD_MARK} cat out.txt`), "a read between bash rows keeps the group");
  const cv = stripAnsi(oneLine(c, 120));
  assert.ok(cv.includes("cd /tmp/pog-demo"), `visible prose opens a new paragraph — no fold: ${cv}`);
  assert.ok(!cv.includes(FOLD_MARK), `⋯ must not point across prose: ${cv}`);

  // A collapsed Thinking... line keeps the couplet in-group (it is not prose).
  const d = bashComp("cd /tmp/one && ls");
  const e = bashComp("cd /tmp/one && pwd");
  setTracelineChat({ children: [d, collapsedThinkingBefore(e), e] });
  assert.ok(stripAnsi(oneLine(e, 120)).includes(`$ ${FOLD_MARK} pwd`), "a collapsed Thinking... line does not break the fold");
});

test("a different directory prints; an all-hygiene row keeps its head", () => {
  const a = bashComp("cd /tmp/one && ls");
  const b = bashComp("cd /tmp/two && ls");
  setTracelineChat({ children: [a, b] });
  const bv = stripAnsi(oneLine(b, 120));
  assert.ok(bv.includes("cd /tmp/two"), `a different directory is information, not repetition: ${bv}`);
  assert.ok(!bv.includes(FOLD_MARK), bv);

  // A row that is nothing but hygiene keeps its head — no row goes dark (§9.4).
  const setOnly = bashComp("set -e");
  setTracelineChat({ children: [setOnly] });
  assert.ok(stripAnsi(oneLine(setOnly, 120)).includes("set -e"), "an all-hygiene row keeps its head");
});

test("bashPreambleRun classifies the leading run; foldBashPreamble reclaims it", () => {
  const bash = { toolName: "bash" };

  // No preamble: the whole body is the command.
  const plain = bashPreambleRun("uv run x");
  assert.equal(plain.contextText, "");
  assert.equal(plain.firstRealStart, 0);

  // set + cd + real: set is hygiene, cd is context, the run ends at the real head.
  const full = bashPreambleRun(`set -euo pipefail ${NL} cd ~/x ${NL} uv run y`);
  assert.equal(full.contextText, "cd ~/x");
  assert.ok(full.firstRealStart! > 0);
  // Lever B strips just the leading set, keeping the cd context and the command.
  assert.equal(
    foldBashPreamble(bash, `$ set -euo pipefail ${NL} cd ~/x ${NL} uv run y`),
    `$ cd ~/x ${NL} uv run y`,
  );

  // All hygiene: nothing to point a ⋯ at and nothing safe to drop — the row is kept.
  const hygiene = bashPreambleRun("set -e");
  assert.equal(hygiene.contextText, "");
  assert.equal(hygiene.firstRealStart, undefined);
  assert.equal(hygiene.dropStart, undefined);
  assert.equal(foldBashPreamble(bash, "$ set -e"), "$ set -e");

  // A bare assignment is setup (context); an env-prefixed command is the command.
  assert.equal(bashPreambleRun(`WORK=$(cat /tmp/x) ${NL} magick foo`).contextText, "WORK=$(cat /tmp/x)");
  assert.equal(bashPreambleRun("FOO=bar cmd").contextText, "");

  // Non-`$ ` lines pass through untouched.
  assert.equal(foldBashPreamble({}, "read ~/x.ts:1-2"), "read ~/x.ts:1-2");
});

test("segment splitting is quote-aware: an && inside a quoted directory never splits", () => {
  const quotedDir = '"/tmp/a && b"';
  const a = bashComp(`cd ${quotedDir} && ls`);
  const b = bashComp(`cd ${quotedDir} && npm test`);
  setTracelineChat({ children: [a, b] });

  const visible = stripAnsi(oneLine(b, 120));
  assert.ok(visible.includes(`$ ${FOLD_MARK} npm test`), visible);
  assert.ok(!visible.includes('b"'), `the quoted directory must not leak past the cut: ${visible}`);

  // Unit edge: the split keeps the quoted `&&` inside the cd segment.
  assert.equal(bashPreambleRun('cd "/tmp/a && b" && npm test').contextText, 'cd "/tmp/a && b"');
});
