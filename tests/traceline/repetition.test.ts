// Repetition folding (issue #14): repeated `cd <dir> && ` preambles elide to a dim ⋯,
// consecutive same-file reads fold into one row, and doubled collapsed Thinking...
// labels coalesce. Comps are synthetic duck-type stand-ins; the contract suite proves
// the duck types (and the doubled-label seam itself) against the real installed pi.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { internals } from "../../extensions/pi-traceline/index.ts";

const {
  stripAnsi,
  oneLine,
  renderTraceRow,
  repeatsPreviousCdPreamble,
  elideCdPreamble,
  readRun,
  dedupeThinkingLabels,
} = internals;

const g = globalThis as Record<string, unknown>;

const DIM = "\x1b[90m"; // raw-ANSI fallback for the family dim tone (no theme in tests)
const FOLD_MARK = "\u22ef";

function bashComp(command: string, rendered?: string): Record<string, unknown> {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: "ok" }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [rendered ?? `$ ${command}`] },
  };
}

function readComp(path: string, offset: number, limit: number, resultChars = 1_000): Record<string, unknown> {
  return {
    toolName: "read",
    args: { path, offset, limit },
    result: { content: [{ type: "text", text: "x".repeat(resultChars) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ${path}:${offset}-${offset + limit - 1}`] },
  };
}

const prose = {
  setHideThinkingBlock: () => {},
  hideThinkingBlock: false,
  lastMessage: { content: [{ type: "text", text: "now let me check" }] },
};

const collapsedThinking = {
  setHideThinkingBlock: () => {},
  hideThinkingBlock: true,
  lastMessage: { content: [{ type: "thinking", thinking: "hmm" }] },
};

const connector = {
  setHideThinkingBlock: () => {},
  hideThinkingBlock: false,
  lastMessage: { content: [{ type: "toolCall" }] },
};

beforeEach(() => {
  g.__tracelineChat = undefined;
  g.__tracelineGetTheme = undefined;
});

test("repeated cd preamble elides to a dim ⋯; the first occurrence keeps the full path", () => {
  const first = bashComp("cd /tmp/pog-demo && npm test");
  const second = bashComp("cd /tmp/pog-demo && npm run typecheck");
  g.__tracelineChat = { children: [prose, first, second] };

  assert.equal(repeatsPreviousCdPreamble(first), false, "first occurrence is not a repeat");
  assert.equal(repeatsPreviousCdPreamble(second), true);

  const firstVisible = stripAnsi(oneLine(first, 120));
  const secondVisible = stripAnsi(oneLine(second, 120));
  assert.ok(firstVisible.includes("cd /tmp/pog-demo"), firstVisible);
  assert.ok(secondVisible.includes(`$ ${FOLD_MARK} && npm run typecheck`), secondVisible);
  assert.ok(!secondVisible.includes("cd /tmp"), `repeated preamble must not re-print: ${secondVisible}`);
  assert.ok(oneLine(second, 120).includes(`${DIM}${FOLD_MARK}\x1b[0m`), "the ⋯ must be dimmed");
});

test("elision scans past interleaved non-bash tools but never across visible prose", () => {
  const a = bashComp("cd /tmp/pog-demo && ls");
  const read = readComp(`${homedir()}/projects/demo/file.ts`, 1, 40);
  const b = bashComp("cd /tmp/pog-demo && cat out.txt");
  const c = bashComp("cd /tmp/pog-demo && rm out.txt");
  g.__tracelineChat = { children: [a, read, b, prose, c] };

  assert.equal(repeatsPreviousCdPreamble(b), true, "a read between bash rows does not break the group");
  assert.equal(repeatsPreviousCdPreamble(c), false, "visible prose opens a new paragraph — ⋯ must not point across it");
});

test("elision requires the same directory, a real `&&` tail, and a thinking line does not break it", () => {
  const a = bashComp("cd /tmp/one && ls");
  const b = bashComp("cd /tmp/two && ls");
  g.__tracelineChat = { children: [a, b] };
  assert.equal(repeatsPreviousCdPreamble(b), false, "different directory is information, not repetition");

  const cdOnlyPrev = bashComp("cd /tmp/one && ls");
  const cdOnly = bashComp("cd /tmp/one");
  g.__tracelineChat = { children: [cdOnlyPrev, cdOnly] };
  assert.equal(repeatsPreviousCdPreamble(cdOnly), false, "a bare cd has no tail to elide to");

  const c = bashComp("cd /tmp/one && ls");
  const d = bashComp("cd /tmp/one && pwd");
  g.__tracelineChat = { children: [c, collapsedThinking, d] };
  assert.equal(repeatsPreviousCdPreamble(d), true, "a collapsed Thinking... line keeps the couplet in-group");

  // Unit edges: lines that are not `$ cd … && …` pass through unchanged.
  assert.equal(elideCdPreamble("$ ls -la"), "$ ls -la");
  assert.equal(elideCdPreamble("read ~/x.ts:1-2"), "read ~/x.ts:1-2");
  assert.equal(elideCdPreamble("$ cd /tmp"), "$ cd /tmp", "a bare cd has no tail");
});

test("elision is quote-aware: an && inside a quoted directory never becomes the cut point", () => {
  const quotedDir = '"/tmp/a && b"';
  const a = bashComp(`cd ${quotedDir} && ls`);
  const b = bashComp(`cd ${quotedDir} && npm test`);
  g.__tracelineChat = { children: [a, b] };
  assert.equal(repeatsPreviousCdPreamble(b), true, "quoted dirs still detect as repeats");

  const visible = stripAnsi(oneLine(b, 120));
  assert.ok(visible.includes(`$ ${FOLD_MARK} && npm test`), visible);
  assert.ok(!visible.includes('b"'), `the quoted directory must not leak past the cut: ${visible}`);

  // Unit edge: the raw helper cuts after the quoted segment, not inside it.
  assert.equal(stripAnsi(elideCdPreamble('$ cd "/tmp/a && b" && npm test')), `$ ${FOLD_MARK} && npm test`);
});

test("consecutive reads of one file fold into a single row with combined ranges and size", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const r1 = readComp(path, 1, 200, 12_000);
  const r2 = readComp(path, 201, 200, 12_000);
  const r3 = readComp(path, 401, 200, 13_000);
  g.__tracelineChat = { children: [prose, r1, connector, r2, r3] };

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
  g.__tracelineChat = { children: [r1, r2] };

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
  g.__tracelineChat = { children: [r1, err, r3, r4] };

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

  g.__tracelineChat = { children: [readComp(path, 1, 200), collapsedThinking, readComp(path, 201, 200)] };
  const [r1, , r2] = (g.__tracelineChat as { children: unknown[] }).children;
  assert.equal(readRun(r1), undefined, "a visible Thinking... line breaks the run");
  assert.equal(readRun(r2), undefined);

  g.__tracelineChat = { children: [readComp(path, 1, 200), readComp(other, 1, 200)] };
  const [p1, p2] = (g.__tracelineChat as { children: unknown[] }).children;
  assert.equal(readRun(p1), undefined, "different files never fold");
  assert.equal(readRun(p2), undefined);

  // A single read renders exactly as before — folding is strictly n>1.
  g.__tracelineChat = { children: [readComp(path, 1, 200)] };
  const single = (g.__tracelineChat as { children: unknown[] }).children[0];
  assert.equal(readRun(single), undefined);
  const visible = stripAnsi(renderTraceRow(single, 120).at(-1)!);
  assert.ok(visible.includes("read ~/projects/demo/big-file.ts:1-200"), visible);
  assert.ok(!visible.includes("calls"), visible);
});

test("doubled Thinking... labels coalesce; distinct paragraphs and prose survive", () => {
  const comp = { hiddenThinkingLabel: "Thinking..." };
  const L = "\x1b[3mThinking...\x1b[23m";

  assert.deepEqual(dedupeThinkingLabels(comp, ["", L, "", L]), ["", L]);
  assert.deepEqual(dedupeThinkingLabels(comp, ["", L, "", L, "", L]), ["", L]);
  assert.deepEqual(dedupeThinkingLabels(comp, ["", L, "", "prose", "", L]), ["", L, "", "prose", "", L]);
  assert.deepEqual(dedupeThinkingLabels(comp, ["", L, "", L, "", "prose"]), ["", L, "", "prose"]);
  assert.deepEqual(dedupeThinkingLabels(comp, ["just prose"]), ["just prose"]);

  // OSC sequences on dropped lines (pi's zone marks live on the message's last line)
  // are transplanted, never lost.
  const marked = `\x1b]133;C\x07${L}`;
  const out = dedupeThinkingLabels(comp, ["", L, "", marked]);
  assert.equal(out.length, 2);
  assert.ok(out[1]!.startsWith("\x1b]133;C\x07"), `zone mark must survive the dedupe: ${JSON.stringify(out)}`);

  // A custom hiddenThinkingLabel is respected.
  const custom = { hiddenThinkingLabel: "Pondering…" };
  assert.deepEqual(dedupeThinkingLabels(custom, ["Pondering…", "", "Pondering…"]), ["Pondering…"]);
});
