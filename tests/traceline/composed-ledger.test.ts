// Composed calls, the ledger (design language §9.14): shown by default and folded per
// §9.9, with outcome facts in its suffix, fitted bash lines, live-only size cells, the
// reveal cap and its config, and the live events that repair streamed previews.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { ComposedHarness, ENOENT, line, lines, rawLine, toggleLedger } from "./composed-harness.ts";

let h: ComposedHarness;

beforeEach(() => { h = new ComposedHarness(); });
afterEach(async () => { await h.dispose(); });

test("the ledger shows by default: every call in order, indented under the parent, in its tool's grammar", async () => {
  const row = h.composedRow([
    { name: "read", args: { path: `${h.cwd}/docs/a.md`, offset: 1, limit: 40 }, durationMs: 23 },
    { name: "read", args: { path: `${h.cwd}/docs/missing.md` }, status: "error", error: ENOENT, durationMs: 7 },
    { name: "bash", args: { command: "cd /tmp && find docs -type f | head -3" }, durationMs: 540 },
    { name: "mcp__monaco__get_account", args: { account_id: "acc-1" }, durationMs: 1_914 },
    { name: "write", args: { path: "/tmp/out.json", content: "…" }, status: "cancelled" },
  ], { cwd: h.cwd });
  await h.mount([row]);
  const [parent, ...ledger] = lines(row);
  assert.match(parent!, /^ {2}▏ ▾ codemode 5 calls · /);
  assert.equal(ledger.length, 5);
  assert.match(ledger[0]!, /^ {2}▏ {3}› read \.\/docs\/a\.md:1-40 *$/, "sub-100ms durations are not facts");
  assert.match(ledger[1]!, /^ {2}▏ {3}› read \.\/docs\/missing\.md {2,}ENOENT: no such .*'\/x\/README\.md'$/, "the failure fact sits in the suffix, middle-cut to its cap");
  assert.match(ledger[2]!, /^ {2}▏ {3}› \$ cd \/tmp && find docs -type f \| head -3 {2,}0\.5s$/);
  assert.match(ledger[3]!, /^ {2}▏ {3}› monaco\/get_account \{"account_id":"acc-1"\} {2,}1\.9s$/);
  assert.match(ledger[4]!, /^ {2}▏ {3}› write \/tmp\/out\.json {2,}cancelled$/);
  // One right edge for the whole fact column.
  const edges = new Set(ledger.filter((text) => !text.endsWith(":1-40")).map((text) => text.length));
  assert.ok(ledger[1]!.length <= 120);
  assert.equal(edges.size, 1, `ledger facts share one edge: ${[...edges]}`);
  const rawLedger = row.render(120).slice(-5);
  assert.match(rawLedger[1]!, /\x1b\[31m›/, "error bullet");
  assert.match(rawLedger[1]!, /\x1b\[31mENOENT/, "the failure fact is error ink");
  assert.match(rawLedger[4]!, /\x1b\[90m›/, "cancelled bullet is dim");
  // The parent's ▾ refolds; a second click on ▸ reveals again.
  toggleLedger(row);
  assert.equal(lines(row).length, 1);
  assert.match(line(row), /^ {2}▏ ▸ codemode/);
  toggleLedger(row);
  assert.equal(lines(row).length, 6);
});

test("the ledger folds the boring (§9.9): sibling reads, paged reads and identical calls", async () => {
  const row = h.composedRow([
    { name: "read", args: { path: `${h.cwd}/calendar/world-dates.baseline.json` } },
    { name: "read", args: { path: `${h.cwd}/calendar/world-leaks.baseline.json` } },
    { name: "read", args: { path: `${h.cwd}/tender-desk/presentation.ts`, offset: 1, limit: 200 } },
    { name: "read", args: { path: `${h.cwd}/tender-desk/presentation.ts`, offset: 201, limit: 200 } },
    { name: "read", args: { path: `${h.cwd}/server/contract.ts` } },
    { name: "mcp__linear__save_issue", args: { id: "1" } },
    { name: "mcp__linear__save_issue", args: { id: "1" } },
    { name: "mcp__linear__save_issue", args: { id: "1" } },
    { name: "mcp__linear__save_issue", args: { id: "2" } },
  ], { cwd: h.cwd });
  await h.mount([row]);
  const ledger = lines(row).slice(1);
  assert.deepEqual(ledger.map((text) => text.trim().replace(/^▏\s+/, "")), [
    "› read ./calendar/ world-dates.baseline.json, world-leaks.baseline.json",
    "› read ./tender-desk/presentation.ts:1-200,201-400",
    "› read ./server/contract.ts",
    '› linear/save_issue {"id":"1"} ×3',
    '› linear/save_issue {"id":"2"}',
  ]);
});

test("a failed or ballooned read never folds and splits the run; a fold sums live sizes and drops its duration", async () => {
  const row = h.composedRow([
    { name: "read", args: { path: `${h.cwd}/docs/a.md` }, durationMs: 400 },
    { name: "read", args: { path: `${h.cwd}/docs/missing.md` }, status: "error", error: ENOENT, durationMs: 300 },
    { name: "read", args: { path: `${h.cwd}/docs/b.md` }, durationMs: 400 },
    { name: "read", args: { path: `${h.cwd}/docs/c.md` }, durationMs: 400 },
    { name: "read", args: { path: `${h.cwd}/docs/big.md` }, durationMs: 400 },
    { name: "read", args: { path: `${h.cwd}/docs/d.md` }, durationMs: 400 },
  ], { cwd: h.cwd });
  await h.mount([row]);
  const parentToolCallId = h.toolCalls.get(row)!.id;
  for (const [index, size] of [[3, 6_000], [4, 6_000], [5, 14_000], [6, 200]] as const) {
    await h.emit({
      type: "tool_execution_end", toolCallId: `${parentToolCallId}/${index}`, parentToolCallId,
      toolName: "read", result: { content: [{ type: "text", text: "y".repeat(size) }] }, isError: false,
    });
  }
  const ledger = lines(row).slice(1);
  assert.equal(ledger.length, 5, ledger.join("\n"));
  assert.match(ledger[0]!, /› read \.\/docs\/a\.md {2,}0\.4s$/);
  assert.match(ledger[1]!, /› read \.\/docs\/missing\.md {2,}ENOENT/);
  assert.match(ledger[2]!, /› read \.\/docs\/ b\.md, c\.md {2,}12\.0k ch$/, "summed live sizes, no summed duration");
  assert.match(ledger[3]!, /› read \.\/docs\/big\.md {2,}0\.4s · 14\.0k ch$/, "what ballooned keeps its own line");
  assert.match(ledger[4]!, /› read \.\/docs\/d\.md {2,}0\.4s · 0\.2k ch$/);
});

test("a ledger past the cap starts folded; the cap and the default are configurable", async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: "mcp__monaco__get_account", args: { account_id: `acc-${i}` } }));
  const wide = h.composedRow(many(13), { cwd: h.cwd });
  const fits = h.composedRow(many(12), { cwd: h.cwd });
  await h.mount([wide, fits]);
  assert.equal(lines(wide).length, 1, "13 distinct calls fold behind ▸");
  assert.match(line(wide), /^ {2}▏ ▸ codemode 13 calls/);
  assert.equal(lines(fits).length, 13, "12 lines is the default cap");
  toggleLedger(wide);
  assert.equal(lines(wide).length, 14, "the click reveals it anyway");
});

test("revealLedgers: false starts every ledger folded; ledgerMaxLines moves the cap", async () => {
  const row = h.composedRow(h.reads(["docs/a.md", "src/b.ts"]), { cwd: h.cwd });
  await h.mount([row], { revealLedgers: false });
  assert.equal(lines(row).length, 1);
  await h.dispose();
  h = new ComposedHarness();
  const two = h.composedRow(h.reads(["docs/a.md", "src/b.ts"]), { cwd: h.cwd });
  await h.mount([two], { ledgerMaxLines: 1 });
  assert.equal(lines(two).length, 1, "two lines exceed a cap of one");
});

test("a ledger bash line relativizes its cd and fits by unit, so the command survives the context", async () => {
  const worktree = `${h.cwd}/.worktrees/verification-presentation`;
  const command = `cd ${worktree} && rg -n "doorServices" --glob '{view*,rows*,door-services*}*' garage/frontends/quotation-agent/src/features/quote`;
  const row = h.composedRow([{ name: "bash", args: { command }, status: "error", error: `rg: garage/frontends: No such file or directory (os error 2)\n\nCommand exited with code 2` }], { cwd: h.cwd });
  await h.mount([row]);
  const [ledgerLine] = lines(row, 100).slice(1);
  assert.match(ledgerLine!, /› \$ cd …\/verification-presentation && rg -n "doorServices" --glob '\{view\*,rows\*,doo… {2,}exit 2$/, ledgerLine);
  const wide = lines(row, 200).slice(1)[0]!;
  assert.match(wide, /› \$ cd \.\/\.worktrees\/verification-presentation && rg -n "doorServices"/, "under cwd, the cd reads ./ and prints whole when it fits");
});

test("a lone search that exited 1 reads no matches; other exits restate the code", async () => {
  const fruitless = h.composedRow([{ name: "bash", args: { command: "rg -n TODO src/" }, status: "error", error: "Command exited with code 1" }], { cwd: h.cwd });
  const piped = h.composedRow([{ name: "bash", args: { command: "rg -n TODO src/ | head -3" }, status: "error", error: "Command exited with code 1" }], { cwd: h.cwd });
  await h.mount([fruitless, piped]);
  assert.match(lines(fruitless).at(-1)!, /› \$ rg -n TODO src\/ {2,}no matches$/);
  assert.match(lines(piped).at(-1)!, /› \$ rg -n TODO src\/ \| head -3 {2,}exit 1$/, "a pipeline's status is not the search's");
});

test("nested result sizes are live-only: captured from nested events, absent on a restored row", async () => {
  const live = h.composedRow(h.reads(["docs/a.md", "src/b.md"]), { cwd: h.cwd });
  const restored = h.composedRow(h.reads(["docs/a.md", "src/b.md"]), { cwd: h.cwd, restored: true });
  await h.mount([live, restored]);
  assert.ok(lines(live).slice(1).every((text) => !text.endsWith("ch")), "no sizes before live events");
  const parentToolCallId = h.toolCalls.get(live)!.id;
  await h.emit({
    type: "tool_execution_start", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "read", args: { path: `${h.cwd}/docs/a.md` },
  });
  await h.emit({
    type: "tool_execution_end", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "read", result: { content: [{ type: "text", text: "y".repeat(12_400) }] }, isError: false,
  });
  await h.emit({
    type: "tool_execution_end", toolCallId: `${parentToolCallId}/2`, parentToolCallId,
    toolName: "read", result: { content: [{ type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "note" }] }, isError: false,
  });
  const liveLedger = lines(live).slice(1);
  assert.match(liveLedger[0]!, / {2,}12\.4k ch$/);
  assert.match(liveLedger[1]!, / {2,}png$/, "an image result shows its what-fact, not a char count");
  const restoredLedger = lines(restored).slice(1);
  assert.equal(restoredLedger.length, 2, "the persisted nestedCalls record still yields the ledger");
  assert.ok(restoredLedger.every((text) => !text.endsWith("ch")), `no size cells without live evidence: ${restoredLedger}`);
  assert.equal(line(restored).includes("read ×2"), true);
});

test("a live nested error observed by event overrides an optimistic streamed status and supplies the full error", async () => {
  const row = h.composedRow([{ name: "bash", args: { command: "false" } }], { cwd: h.cwd });
  await h.mount([row]);
  assert.ok(!line(row).includes("✗"), "the streamed ledger initially reports success");
  const parentToolCallId = h.toolCalls.get(row)!.id;
  await h.emit({
    type: "tool_execution_end", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "bash", result: { content: [{ type: "text", text: `${"x".repeat(600)}\n\nCommand exited with code 1` }] }, isError: true,
  });
  assert.ok(line(row).includes("$ false ✗1"), line(row));
  assert.match(lines(row).at(-1)!, /› \$ false {2,}exit 1$/, "the live text, not codemode's capped preview, feeds the fact");
});

test("a running script renders from the streamed ledger in running ink", async () => {
  const row = h.composedRow([
    { name: "mcp__monaco__get_account", args: { account_id: "1" }, durationMs: 120 },
    { name: "mcp__monaco__get_account", args: { account_id: "2" }, status: "running" },
  ], { running: true });
  await h.mount([row]);
  const raw = rawLine(row);
  assert.match(stripAnsi(raw), /^ {2}▏ ▾ codemode 2 calls · monaco\/get_account ×2 *$/);
  assert.match(raw, /\x1b\[34m▾/, "running bullet");
  const running = row.render(120).at(-1)!;
  assert.match(running, /\x1b\[34m›/, "the in-flight nested call has a running bullet");
});

test("truncated argument previews recover their read path and range from persisted or live arguments", async () => {
  const args = { path: `${h.cwd}/${"deep/".repeat(40)}docs/recovered.md`, offset: 4, limit: 7 };
  const persisted = h.composedRow([{ name: "read", args }]);
  const live = h.composedRow([{ name: "read", args, status: "running" }], { running: true });
  await h.mount([persisted, live]);
  assert.match(lines(persisted)[1]!, /› read .*\/docs\/recovered\.md:4-10 *$/, "persisted typed arguments repair the completed row's cut preview");
  assert.ok(!lines(live)[1]!.includes("recovered.md"), "the cut preview has no path before its live start event");
  const parentToolCallId = h.toolCalls.get(live)!.id;
  await h.emit({
    type: "tool_execution_start", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "read", args,
  });
  assert.match(lines(live)[1]!, /› read .*\/docs\/recovered\.md:4-10 *$/, "the full live arguments repair the running row's cut preview");
});

