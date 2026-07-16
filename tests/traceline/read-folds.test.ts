// Read folding (issue #14, design language §9.9): consecutive reads fold into one
// entity. Same-file pages merge their ranges; sibling files in one directory fold into
// a dir row that wraps at file boundaries; a file whose combined result reaches warning
// severity keeps its own row and splits the run, as an error row does. Comps are
// synthetic duck-type stand-ins; the contract suite proves the duck types against the
// real installed pi.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";

import { internals } from "../../extensions/pi-traceline/index.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { assistantBefore, completedReadRow, wholeFileReadRow } from "./runtime-fixtures.ts";

const { stripAnsi, renderTraceRow, readRun, setTracelineChat, setTracelineThemeGetter } = internals;

const proseBefore = (rows: ToolRowLike[]) => assistantBefore(rows, [{ type: "text", text: "now let me check" }]);
const collapsedThinkingBefore = (row: ToolRowLike) => assistantBefore([row], [{ type: "thinking", thinking: "hmm" }], true);
const connectorBefore = (rows: ToolRowLike[]) => assistantBefore(rows);

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
});

test("consecutive reads of one file fold into a single row with combined ranges and size", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const r1 = completedReadRow(path, 1, 200, 12_000);
  const r2 = completedReadRow(path, 201, 200, 12_000);
  const r3 = completedReadRow(path, 401, 200, 13_000);
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
  const r1 = completedReadRow(path, 1, 200, 9_000);
  const r2 = { ...completedReadRow(path, 201, 200), result: undefined, isPartial: true };
  setTracelineChat({ children: [r1, r2] });

  const folded = renderTraceRow(r1, 120);
  const line = folded[folded.length - 1]!;
  assert.ok(line.includes("\x1b[34m\u203a"), "bullet must reflect the in-flight last call");
  const visible = stripAnsi(line);
  assert.ok(visible.trimEnd().endsWith("2 calls · 9.0k ch"), `only landed results count: ${visible}`);
});

test("a running earlier sibling keeps the fold live after a later sibling lands", () => {
  const dir = `${homedir()}/projects/demo`;
  const running = { ...wholeFileReadRow(`${dir}/a.ts`), result: undefined, isPartial: true };
  const completed = wholeFileReadRow(`${dir}/b.ts`);
  setTracelineChat({ children: [running, completed] });

  const line = renderTraceRow(running, 120).at(-1)!;
  assert.ok(line.includes("\x1b[34m\u203a"), "any in-flight call keeps the folded bullet blue");
  assert.ok(!line.includes("\x1b[32m\u203a"), "a completed last call must not turn the fold green");
  const visible = stripAnsi(line);
  assert.ok(visible.trimEnd().endsWith("2 calls · 1.0k ch"), `only landed results count: ${visible}`);
});

test("error pages never fold: the red row survives and breaks the run on both sides", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const err = {
    ...completedReadRow(path, 201, 200),
    result: { content: [{ type: "text", text: "line 201 out of range" }], isError: true },
  };
  // ok · ERR · ok · ok — the error renders individually; only the trailing pair folds.
  const r1 = completedReadRow(path, 1, 200);
  const r3 = completedReadRow(path, 201, 200);
  const r4 = completedReadRow(path, 401, 200);
  setTracelineChat({ children: [r1, err, r3, r4] });

  assert.equal(readRun(r1), undefined, "an error after a single ok page leaves it unfolded");
  assert.equal(readRun(err), undefined, "the error row itself never folds");
  const tail = readRun(r3);
  assert.ok(tail && tail.rows.length === 2, "ok pages after the error fold among themselves");

  const errLine = renderTraceRow(err, 120);
  assert.ok(errLine.length > 0, "the error row must render its own line");
  assert.ok(errLine.at(-1)!.includes("\x1b[31m›"), "the error row keeps its red bullet");
});

test("runs break on anything visible between the reads — and on a different directory", () => {
  const path = `${homedir()}/projects/demo/big-file.ts`;
  const elsewhere = `${homedir()}/projects/other-place/b.ts`;

  const r1 = completedReadRow(path, 1, 200);
  const r2 = completedReadRow(path, 201, 200);
  setTracelineChat({ children: [r1, collapsedThinkingBefore(r2), r2] });
  assert.equal(readRun(r1), undefined, "a visible Thinking... line breaks the run");
  assert.equal(readRun(r2), undefined);

  const differentDirChildren = [completedReadRow(path, 1, 200), completedReadRow(elsewhere, 1, 200)] as const;
  setTracelineChat({ children: [...differentDirChildren] });
  const [p1, p2] = differentDirChildren;
  assert.equal(readRun(p1), undefined, "different directories never fold");
  assert.equal(readRun(p2), undefined);

  // A single read renders exactly as before — folding is strictly n>1.
  const single = completedReadRow(path, 1, 200);
  setTracelineChat({ children: [single] });
  assert.equal(readRun(single), undefined);
  const visible = stripAnsi(renderTraceRow(single, 120).at(-1)!);
  assert.ok(visible.includes("read ~/projects/demo/big-file.ts:1-200"), visible);
  assert.ok(!visible.includes("calls"), visible);
});

test("sibling reads in one directory fold into a dir row listing basenames", () => {
  const a = completedReadRow(`${homedir()}/projects/demo/a.ts`, 1, 100, 3_000);
  const b = completedReadRow(`${homedir()}/projects/demo/b.ts`, 1, 50, 2_000);
  setTracelineChat({ children: [proseBefore([a, b]), a, b] });

  const folded = renderTraceRow(a, 120);
  assert.equal(folded.length, 2, "first row carries the fold (with its leading blank)");
  const visible = stripAnsi(folded[1]!);
  assert.ok(visible.includes("read ~/projects/demo/ a.ts:1-100, b.ts:1-50"), visible);
  assert.ok(visible.endsWith("2 calls · 5.0k ch"), `call count and combined size ride the suffix: ${visible}`);
  assert.ok(folded[1]!.includes("\x1b[33m:1-100\x1b[0m"), "per-file ranges stay warning/yellow");
  assert.deepEqual(renderTraceRow(b, 120), [], "the later sibling renders nothing");
});

test("adjacent pages of one file merge their ranges inside a dir fold", () => {
  const a1 = completedReadRow(`${homedir()}/projects/demo/a.ts`, 1, 100, 2_000);
  const a2 = completedReadRow(`${homedir()}/projects/demo/a.ts`, 101, 100, 2_000);
  const b = completedReadRow(`${homedir()}/projects/demo/b.ts`, 1, 50, 1_000);
  setTracelineChat({ children: [a1, a2, b] });

  const run = readRun(b);
  assert.ok(run, "the last sibling must see the run");
  assert.equal(run!.rows.length, 3);
  assert.equal(run!.index, 2);
  const visible = stripAnsi(renderTraceRow(a1, 120).at(-1)!);
  assert.ok(visible.includes("read ~/projects/demo/ a.ts:1-100,101-200, b.ts:1-50"), visible);
  assert.ok(visible.endsWith("3 calls · 5.0k ch"), visible);
});

test("a ballooned file keeps its own row and splits the dir fold", () => {
  const dir = `${homedir()}/projects/demo`;
  const a = completedReadRow(`${dir}/a.ts`, 1, 100, 2_000);
  const big1 = completedReadRow(`${dir}/big.ts`, 1, 200, 9_000);
  const big2 = completedReadRow(`${dir}/big.ts`, 201, 200, 9_000);
  const c = completedReadRow(`${dir}/c.ts`, 1, 100, 2_000);
  setTracelineChat({ children: [a, big1, big2, c] });

  assert.equal(readRun(a), undefined, "a lone sub-warning read beside a breakout renders alone");
  assert.equal(readRun(c), undefined);
  const breakout = readRun(big1);
  assert.ok(breakout && breakout.rows.length === 2, "the ballooned file still folds its own pages");
  const line = renderTraceRow(big1, 120).at(-1)!;
  const visible = stripAnsi(line);
  assert.ok(visible.includes("read ~/projects/demo/big.ts:1-200,201-400"), visible);
  assert.ok(visible.endsWith("2 calls · 18.0k ch"), visible);
  assert.ok(line.includes("\x1b[33m18.0k ch"), "combined size keeps severity tint (≥10k warning)");

  // The sub-warning neighbours render their own rows in place, unfolded.
  const aVisible = stripAnsi(renderTraceRow(a, 120).at(-1)!);
  assert.ok(aVisible.includes("a.ts:1-100"), aVisible);
  assert.ok(!aVisible.includes("calls"), aVisible);
});

test("a long dir fold wraps at file boundaries onto rail-only continuation lines", () => {
  const dir = `${homedir()}/projects/demo`;
  const names = ["alpha.test.ts", "bravo.test.ts", "charlie.test.ts", "delta.test.ts", "echo.test.ts"];
  const rows = names.map((name) => wholeFileReadRow(`${dir}/${name}`));
  setTracelineChat({ children: [...rows] });

  const width = 72;
  const lines = renderTraceRow(rows[0]!, width);
  assert.equal(lines[0], "", "the fold keeps its leading blank");
  const [first, ...rest] = lines.slice(1).map(stripAnsi);
  assert.ok(rest.length >= 1, `the list wraps: ${JSON.stringify([first, ...rest])}`);
  assert.match(first!, /^ {2}\u258f \u203a read ~\/projects\/demo\/ alpha\.test\.ts,\s+5 calls · 5\.0k ch$/, first);
  for (const cont of rest) {
    assert.match(cont, /^ {2}\u258f {8}\S/, `rail-only continuation, content aligned under the dir cell: ${cont}`);
    assert.ok(!cont.includes("\u203a"), `one entity, one bullet: ${cont}`);
  }
  assert.equal(rest[0]!.indexOf("bravo"), first!.indexOf("~/projects"), "continuation cells share the dir cell's left edge");
  for (const line of [first!, ...rest]) {
    assert.ok(visibleWidth(line) <= width, `no line exceeds the width: ${line}`);
  }
  const joined = [first!, ...rest].join("\n");
  for (const name of names) assert.ok(joined.includes(name), `no basename is cut: ${name}`);
  for (const row of rows.slice(1)) assert.deepEqual(renderTraceRow(row, width), [], "later siblings render nothing");
});

test("dir folding counts terminal cells so wide basenames wrap without cuts", () => {
  const dir = `${homedir()}/projects/demo`;
  const names = ["界界界界界-a.ts", "界界界界界-b.ts", "界界界界界-c.ts", "界界界界界-d.ts"];
  const rows = names.map((name) => wholeFileReadRow(`${dir}/${name}`));
  setTracelineChat({ children: [...rows] });

  const width = 60;
  const lines = renderTraceRow(rows[0]!, width);
  const joined = lines.map(stripAnsi).join("\n");
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `no line exceeds the width: ${stripAnsi(line)}`);
  for (const name of names) assert.ok(joined.includes(name), `wide basename stays whole: ${name}`);
  assert.ok(!joined.includes("\u2026"), `no fitted basename needs truncation: ${joined}`);
});
