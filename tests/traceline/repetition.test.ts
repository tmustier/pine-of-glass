// Repetition folding + preamble reclaim (issue #14, design language §9.4): a leading
// `set -…` hygiene run drops, the surviving `cd`/assignment context folds to a dim ⋯
// when it repeats the previous bash row's, consecutive same-file reads fold into one
// row, and collapsed Thinking... labels preserve reasoning lines. Comps are synthetic duck-type
// stand-ins; the contract suite proves the duck types against the real installed pi.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { internals } from "../../extensions/pi-traceline/index.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { assistantBefore, nativeBashLines } from "./runtime-fixtures.ts";

const {
  stripAnsi,
  oneLine,
  renderTraceRow,
  bashPreambleRun,
  foldBashPreamble,
  readRun,
  dedupeThinkingLabels,
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

function readComp(path: string, offset: number, limit: number, resultChars = 1_000): ToolRowLike {
  return {
    toolName: "read",
    args: { path, offset, limit },
    result: { content: [{ type: "text", text: "x".repeat(resultChars) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ${path}:${offset}-${offset + limit - 1}`] },
  } as ToolRowLike;
}

const proseBefore = (rows: ToolRowLike[]) => assistantBefore(rows, [{ type: "text", text: "now let me check" }]);
const collapsedThinkingBefore = (row: ToolRowLike) => assistantBefore([row], [{ type: "thinking", thinking: "hmm" }], true);
const connectorBefore = (rows: ToolRowLike[]) => assistantBefore(rows);

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
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
  const read = readComp(`${homedir()}/projects/demo/file.ts`, 1, 40);
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

test("consecutive reads of one file fold into a single row with combined ranges and size", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const r1 = readComp(path, 1, 200, 12_000);
  const r2 = readComp(path, 201, 200, 12_000);
  const r3 = readComp(path, 401, 200, 13_000);
  setTracelineChat({ children: [proseBefore([r1]), r1, connectorBefore([r2, r3]), r2, r3] });

  const run = readRun(r2);
  assert.ok(run, "middle page must see the run");
  assert.equal(run!.rows.length, 3);
  assert.equal(run!.index, 1);

  const first = renderTraceRow(r1, 120);
  assert.equal(first.length, 2, "first row carries the fold (with its leading blank)");
  const visible = stripAnsi(first[1]!);
  assert.ok(visible.includes("read ~/projects/demo/big-file.ts:1-200,201-400,401-600"), visible);
  assert.ok(visible.endsWith("3 calls · 37.0k ch"), `call count and combined size ride the suffix: ${visible}`);
  assert.ok(first[1]!.includes("\x1b[33m:1-200,201-400,401-600\x1b[0m"), "folded read ranges stay warning/yellow");
  assert.ok(first[1]!.includes("\x1b[33m37.0k ch"), "combined size keeps severity tinting (≥10k warning)");

  assert.deepEqual(renderTraceRow(r2, 120), [], "later pages render nothing");
  assert.deepEqual(renderTraceRow(r3, 120), [], "later pages render nothing");
});

test("a running last page keeps the fold live: running bullet, no premature size", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const r1 = readComp(path, 1, 200, 9_000);
  const r2 = { ...readComp(path, 201, 200), result: undefined, isPartial: true };
  setTracelineChat({ children: [r1, r2] });

  const folded = renderTraceRow(r1, 120);
  const line = folded[folded.length - 1]!;
  assert.ok(line.includes("\x1b[34m\u203a"), "bullet must reflect the in-flight last call");
  const visible = stripAnsi(line);
  assert.ok(visible.trimEnd().endsWith("2 calls · 9.0k ch"), `only landed results count: ${visible}`);
});

test("error pages never fold: the red row survives and breaks the run on both sides", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const err = {
    ...readComp(path, 201, 200),
    result: { content: [{ type: "text", text: "line 201 out of range" }], isError: true },
  };
  // ok · ERR · ok · ok — the error renders individually; only the trailing pair folds.
  const r1 = readComp(path, 1, 200);
  const r3 = readComp(path, 201, 200);
  const r4 = readComp(path, 401, 200);
  setTracelineChat({ children: [r1, err, r3, r4] });

  assert.equal(readRun(r1), undefined, "an error after a single ok page leaves it unfolded");
  assert.equal(readRun(err), undefined, "the error row itself never folds");
  const tail = readRun(r3);
  assert.ok(tail && tail.rows.length === 2, "ok pages after the error fold among themselves");

  const errLine = renderTraceRow(err, 120);
  assert.ok(errLine.length > 0, "the error row must render its own line");
  assert.ok(errLine.at(-1)!.includes("\x1b[31m›"), "the error row keeps its red bullet");
});

test("runs break on anything visible between the reads — and on a different file", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const other = `${homedir()}/projects/demo/other.ts`;

  const r1 = readComp(path, 1, 200);
  const r2 = readComp(path, 201, 200);
  setTracelineChat({ children: [r1, collapsedThinkingBefore(r2), r2] });
  assert.equal(readRun(r1), undefined, "a visible Thinking... line breaks the run");
  assert.equal(readRun(r2), undefined);

  const differentFileChildren = [readComp(path, 1, 200), readComp(other, 1, 200)] as const;
  setTracelineChat({ children: [...differentFileChildren] });
  const [p1, p2] = differentFileChildren;
  assert.equal(readRun(p1), undefined, "different files never fold");
  assert.equal(readRun(p2), undefined);

  // A single read renders exactly as before — folding is strictly n>1.
  const single = readComp(path, 1, 200);
  setTracelineChat({ children: [single] });
  assert.equal(readRun(single), undefined);
  const visible = stripAnsi(renderTraceRow(single, 120).at(-1)!);
  assert.ok(visible.includes("read ~/projects/demo/big-file.ts:1-200"), visible);
  assert.ok(!visible.includes("calls"), visible);
});

test("collapsed Thinking labels preserve reasoning lines and paragraph breaks", () => {
  const comp = {
    hiddenThinkingLabel: "Thinking...",
    lastMessage: { content: [{ type: "thinking", thinking: "\n  **first reasoning line**\nsecond reasoning line" }] },
  };
  const paragraphComp = {
    hiddenThinkingLabel: "Thinking...",
    lastMessage: { content: [{ type: "thinking", thinking: "first paragraph\n\nsecond paragraph" }] },
  };
  const adjacentBlocks = {
    hiddenThinkingLabel: "Thinking...",
    lastMessage: { content: [
      { type: "thinking", thinking: "first reasoning block" },
      { type: "thinking", thinking: "second reasoning block" },
    ] },
  };
  const noPreview = { hiddenThinkingLabel: "Thinking..." };
  const L = "\x1b[3mThinking...\x1b[23m";
  const P1 = "\x1b[3mThinking: first reasoning line\x1b[23m";
  const P2 = "\x1b[3mThinking: second reasoning line\x1b[23m";

  assert.deepEqual(dedupeThinkingLabels(comp, ["", L]), ["", P1, P2]);
  assert.deepEqual(
    dedupeThinkingLabels(paragraphComp, ["", L]),
    ["", "\x1b[3mThinking: first paragraph\x1b[23m", "", "\x1b[3mThinking: second paragraph\x1b[23m"],
    "two source newlines preserve one blank display line",
  );
  assert.deepEqual(
    dedupeThinkingLabels(
      { hiddenThinkingLabel: "Thinking...", lastMessage: { content: [{ type: "thinking", thinking: "first\n\n\nsecond" }] } },
      [L],
    ),
    ["\x1b[3mThinking: first\x1b[23m", "", "\x1b[3mThinking: second\x1b[23m"],
    "long blank runs collapse to one display line",
  );
  assert.deepEqual(
    dedupeThinkingLabels(adjacentBlocks, ["", L, "", L]),
    ["", "\x1b[3mThinking: first reasoning block\x1b[23m", "", "\x1b[3mThinking: second reasoning block\x1b[23m"],
    "distinct adjacent thinking blocks keep both previews",
  );
  assert.deepEqual(dedupeThinkingLabels(noPreview, ["", L, "", L]), ["", L], "missing traces still fold Pi's duplicate labels");
  assert.deepEqual(dedupeThinkingLabels(comp, ["just prose"]), ["just prose"]);

  // Synthetic continuation lines inherit style but not OSC zone marks.
  const marked = `\x1b]133;C\x07${L}`;
  const out = dedupeThinkingLabels(comp, [marked]);
  assert.equal(out.length, 2);
  assert.ok(out[0]!.startsWith("\x1b]133;C\x07"), `native zone mark must survive: ${JSON.stringify(out)}`);
  assert.equal((out.join("").match(/\x1b\]133;C\x07/g) ?? []).length, 1, "synthetic rows must not duplicate OSC marks");

  // A custom hiddenThinkingLabel is respected.
  const custom = { hiddenThinkingLabel: "Pondering…" };
  assert.deepEqual(dedupeThinkingLabels(custom, ["Pondering…", "", "Pondering…"]), ["Pondering…"]);

  const literalStar = dedupeThinkingLabels(
    { hiddenThinkingLabel: "Thinking...", lastMessage: { content: [{ type: "thinking", thinking: "2 * 3 = 6" }] } },
    [L],
  )[0]!;
  assert.equal(stripAnsi(literalStar).trim(), "Thinking: 2 * 3 = 6", "markdown rendering must preserve genuine stars");

  const long = dedupeThinkingLabels(
    { hiddenThinkingLabel: "Thinking...", lastMessage: { content: [{ type: "thinking", thinking: "a very long reasoning preview" }] } },
    [L],
    18,
  )[0]!;
  assert.ok(stripAnsi(long).length <= 18, `preview must respect row width: ${stripAnsi(long)}`);
  assert.ok(stripAnsi(long).startsWith("Thinking:"), stripAnsi(long));
});
