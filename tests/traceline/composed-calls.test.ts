// Composed calls (design language §9.14): a codemode row states its effects, folds its
// nested calls by tool, marks nested failures and trimmed output, names the slow child,
// and reveals a per-call ledger whose live-only size cells come from nested events.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { internals } from "../../extensions/pi-traceline/index.ts";
import { isLedgerRevealed, resetRevealedFolds, setLedgerRevealed } from "../../extensions/pi-traceline/click.ts";
import { clearNestedCaptures, composedFactsOf, recordNestedEnd, recordNestedStart } from "../../extensions/pi-traceline/nested-calls.ts";
import { splitToolName } from "../../extensions/pi-traceline/nested-rows.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { assistantBefore, composedRow, type NestedFixture } from "./runtime-fixtures.ts";

const { renderTraceRow, stripAnsi, setTracelineChat, setTracelineThemeGetter, resetRenderCache } = internals;

const cwd = `${homedir()}/projects/commercial`;
const ENOENT = "ENOENT: no such file or directory, access '/x/README.md'";

function mount(rows: ToolRowLike[]): void {
  setTracelineChat({ children: [assistantBefore(rows, [], true), ...rows] } as never);
}

function line(row: ToolRowLike, width = 120): string {
  const lines = renderTraceRow(row, width).map(stripAnsi).filter((text) => text.length > 0);
  return lines[0] ?? "";
}

function lines(row: ToolRowLike, width = 120): string[] {
  return renderTraceRow(row, width).map(stripAnsi).filter((text) => text.length > 0);
}

const reads = (paths: string[]): NestedFixture[] => paths.map((path) => ({ name: "read", args: { path: `${cwd}/${path}` } }));

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
  resetRevealedFolds();
  clearNestedCaptures();
  resetRenderCache();
});

test("a codemode row is verb-led and effect-led: count, then members folded by tool", () => {
  const row = composedRow([
    ...reads(["docs/a.md", "docs/b.md", "docs/c.md"]),
    { name: "bash", args: { command: "find docs -type f | head" } },
    { name: "mcp__monaco__get_account", args: { account_id: "1" } },
    { name: "mcp__monaco__get_account", args: { account_id: "2" } },
  ], { cwd });
  mount([row]);
  const text = line(row);
  assert.match(text, /^ {2}▏ ▸ codemode 6 calls · read ×3 \.\/docs\/ · \$ find · monaco\/get_account ×2 {2,}0\.2k ch$/);
  assert.ok(!text.includes("Promise"), "the script source never reaches z0");
});

test("one distinct path keeps its basename; paged reads merge their ranges; mixed dirs carry none", () => {
  const paged = composedRow([
    { name: "read", args: { path: `${cwd}/README.md`, offset: 1, limit: 200 } },
    { name: "read", args: { path: `${cwd}/README.md`, offset: 201, limit: 200 } },
  ], { cwd });
  const mixed = composedRow(reads(["docs/a.md", "src/b.ts"]), { cwd });
  const single = composedRow([{ name: "write", args: { path: "/tmp/out/report.json", content: "…" } }], { cwd });
  mount([paged, mixed, single]);
  assert.ok(line(paged).includes("read ×2 ./README.md:1-200,201-400"), line(paged));
  assert.match(line(mixed), /codemode 2 calls · read ×2 {2,}/);
  assert.ok(line(single).includes("codemode 1 call · write /tmp/out/report.json"), line(single));
});

test("a script that called nothing says so", () => {
  const row = composedRow([], { output: "x".repeat(11_600) });
  mount([row]);
  assert.match(line(row), /^ {2}▏ › codemode script only {2,}11\.6k ch$/);
});

test("a nested failure inside a completed script marks the member; the bullet stays green", () => {
  const row = composedRow([
    ...reads(["docs/a.md", "docs/b.md"]),
    { name: "read", args: { path: `${cwd}/docs/missing.md` }, status: "error", error: ENOENT },
  ], { cwd });
  mount([row]);
  assert.ok(line(row).includes("read ×3 ✗1 ./docs/"), line(row));
  const raw = renderTraceRow(row, 120).find((text) => text.trim().length > 0)!;
  assert.match(raw, /\x1b\[32m▸/, "the composed call completed, so its bullet is success ink");
  assert.match(raw, /\x1b\[33m✗1/, "the nested failure is warning ink (partial state)");
});

test("a failed script tints its discriminators and keeps the member marks", () => {
  const row = composedRow([
    { name: "read", args: { path: `${cwd}/docs/missing.md` }, status: "error", error: ENOENT },
  ], { cwd, failed: true, output: "Script error:\nError: ENOENT" });
  mount([row]);
  const raw = renderTraceRow(row, 120).find((text) => text.trim().length > 0)!;
  assert.match(raw, /\x1b\[31m▸/, "error bullet");
  assert.match(raw, /\x1b\[31m\x1b\[1mcodemode/, "error-tinted verb");
  assert.ok(stripAnsi(raw).includes("read ✗1 ./docs/missing.md"));
});

test("trimmed output is a warning fact ahead of the size cell and lights the block's column", () => {
  const trimmed = composedRow(reads(["docs/a.md"]), { cwd, trimmed: true, output: "x".repeat(40_100) });
  const tiny = composedRow(reads(["docs/b.md"]), { cwd, output: "ok" });
  mount([trimmed, tiny]);
  assert.match(line(trimmed), / {2,}trimmed · 40\.2k ch$/, "the count is what reached the model: header, notice and cut output");
  assert.match(line(tiny), / {2,}0\.0k ch$/, "the live column shows the tiny neighbour's cell");
  const raw = renderTraceRow(trimmed, 120).find((text) => text.trim().length > 0)!;
  assert.match(raw, /\x1b\[33mtrimmed/, "warning ink");
  // The trimmed cell and the plain cell share one right edge.
  assert.equal(line(trimmed).length, line(tiny).length);
});

test("wall time appears from 10s and names the member that explains it", () => {
  const slow = composedRow([
    { name: "mcp__monaco__list_campaigns", args: { page_size: 100 }, durationMs: 1_900 },
    { name: "mcp__superhuman-mail__query_email_and_calendar", args: { question: "…" }, durationMs: 122_340 },
    { name: "bash", args: { command: "mkdir -p /tmp/x" }, durationMs: 3_900 },
  ], { wallSeconds: 122.4 });
  const quick = composedRow([{ name: "bash", args: { command: "ls" }, durationMs: 400 }], { wallSeconds: 0.5 });
  mount([slow, quick]);
  const text = line(slow);
  assert.ok(text.includes("codemode 3 calls · 2m02s · "), text);
  assert.ok(text.includes("superhuman-mail/query_email_and_calendar 2m02s"), text);
  assert.ok(!text.includes("list_campaigns 1.9s"), "a member that does not explain the wall carries no duration");
  assert.ok(!line(quick).includes("0.5s"), line(quick));
});

test("a namespaced tool keeps the path grammar: dim prefix, bold discriminator", () => {
  assert.deepEqual(splitToolName("mcp__monaco__get_account"), { prefix: "monaco/", tool: "get_account" });
  assert.deepEqual(splitToolName("mcp__superhuman-mail__list_threads"), { prefix: "superhuman-mail/", tool: "list_threads" });
  assert.deepEqual(splitToolName("linear_search_issues"), { prefix: "", tool: "linear_search_issues" });
});

test("the revealed ledger lists every call in order, indented under the parent, in its tool's grammar", () => {
  const row = composedRow([
    { name: "read", args: { path: `${cwd}/docs/a.md`, offset: 1, limit: 40 }, durationMs: 23 },
    { name: "read", args: { path: `${cwd}/docs/missing.md` }, status: "error", error: ENOENT, durationMs: 7 },
    { name: "bash", args: { command: "cd /tmp && find docs -type f | head -3" }, durationMs: 540 },
    { name: "mcp__monaco__get_account", args: { account_id: "acc-1" }, durationMs: 1_914 },
    { name: "write", args: { path: "/tmp/out.json", content: "…" }, status: "cancelled" },
  ], { cwd });
  mount([row]);
  assert.equal(lines(row).length, 1, "folded by default");
  setLedgerRevealed(row, true);
  assert.equal(isLedgerRevealed(row), true);
  const [parent, ...ledger] = lines(row);
  assert.match(parent!, /^ {2}▏ ▾ codemode 5 calls · /);
  assert.equal(ledger.length, 5);
  assert.match(ledger[0]!, /^ {2}▏ {3}› read \.\/docs\/a\.md:1-40 *$/, "sub-100ms durations are not facts");
  assert.match(ledger[1]!, /^ {2}▏ {3}› read \.\/docs\/missing\.md · ENOENT: no such file or directory, access '\/x\/R…$/, "the error cell is capped so the path survives");
  assert.match(ledger[2]!, /^ {2}▏ {3}› \$ cd \/tmp && find docs -type f \| head -3 {2,}0\.5s$/);
  assert.match(ledger[3]!, /^ {2}▏ {3}› monaco\/get_account \{"account_id":"acc-1"\} {2,}1\.9s$/);
  assert.match(ledger[4]!, /^ {2}▏ {3}› write \/tmp\/out\.json · cancelled *$/);
  // One right edge for the duration column.
  const edges = new Set(ledger.filter((text) => /\ds$/.test(text)).map((text) => text.length));
  assert.equal(edges.size, 1, `ledger durations share one edge: ${[...edges]}`);
  const rawLedger = renderTraceRow(row, 120).slice(-5);
  assert.match(rawLedger[1]!, /\x1b\[31m›/, "error bullet");
  assert.match(rawLedger[4]!, /\x1b\[90m›/, "cancelled bullet is dim");
  setLedgerRevealed(row, false);
  assert.equal(lines(row).length, 1);
});

test("nested result sizes are live-only: captured from nested events, absent on a restored row", () => {
  const live = composedRow(reads(["docs/a.md", "docs/b.md"]), { cwd });
  const restored = composedRow(reads(["docs/a.md", "docs/b.md"]), { cwd, restored: true });
  mount([live, restored]);
  const facts = composedFactsOf(live)!;
  recordNestedStart(facts.calls[0]!.id, "read", { path: `${cwd}/docs/a.md` });
  recordNestedEnd(facts.calls[0]!.id, "read", { content: [{ type: "text", text: "y".repeat(12_400) }] }, false);
  recordNestedEnd(facts.calls[1]!.id, "read", { content: [{ type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "note" }] }, false);
  resetRenderCache();
  setLedgerRevealed(live, true);
  setLedgerRevealed(restored, true);
  const liveLedger = lines(live).slice(1);
  assert.match(liveLedger[0]!, / {2,}12\.4k ch$/);
  assert.match(liveLedger[1]!, / {2,}png$/, "an image result shows its what-fact, not a char count");
  const restoredLedger = lines(restored).slice(1);
  assert.equal(restoredLedger.length, 2, "the persisted nestedCalls record still yields the ledger");
  assert.ok(restoredLedger.every((text) => !text.endsWith("ch")), `no size cells without live evidence: ${restoredLedger}`);
  assert.equal(line(restored).includes("read ×2 ./docs/"), true);
});

test("a live nested error observed by event overrides an optimistic streamed status", () => {
  const row = composedRow([{ name: "bash", args: { command: "false" } }], { cwd });
  mount([row]);
  const id = composedFactsOf(row)!.calls[0]!.id;
  recordNestedEnd(id, "bash", { content: [{ type: "text", text: "exit 1" }] }, true);
  resetRenderCache();
  assert.ok(line(row).includes("$ false ✗1") || line(row).includes("$ ✗1"), line(row));
});

test("a running script renders from the streamed ledger in running ink", () => {
  const row = composedRow([
    { name: "mcp__monaco__get_account", args: { account_id: "1" }, durationMs: 120 },
    { name: "mcp__monaco__get_account", args: { account_id: "2" }, status: "running" },
  ], { running: true });
  mount([row]);
  const raw = renderTraceRow(row, 120).find((text) => text.trim().length > 0)!;
  assert.match(stripAnsi(raw), /^ {2}▏ ▸ codemode 2 calls · monaco\/get_account ×2 *$/);
  assert.match(raw, /\x1b\[34m▸/, "running bullet");
  setLedgerRevealed(row, true);
  const running = renderTraceRow(row, 120).at(-1)!;
  assert.match(running, /\x1b\[34m›/, "the in-flight nested call has a running bullet");
});

test("composed rows never fold as repetitions; the block's truncation budget still holds", () => {
  const a = composedRow(reads(["docs/a.md"]), { cwd });
  const b = composedRow(reads(["docs/a.md"]), { cwd });
  mount([a, b]);
  assert.equal(lines(a).length, 1);
  assert.equal(lines(b).length, 1, "the second row keeps its own line rather than folding into ×2");
  const wide = composedRow(reads(Array.from({ length: 30 }, (_, i) => `go-to-market/motions/lead-generation/file-${i}.md`)), { cwd, output: "x".repeat(20_000) });
  mount([wide]);
  for (const width of [60, 80, 100]) {
    const text = line(wide, width);
    assert.ok(text.length <= width, `${width}: ${text.length}`);
    assert.match(text, / 20\.0k ch$/);
  }
});

test("an ordinary tool row is untouched", () => {
  const row = {
    toolName: "read",
    args: { path: `${cwd}/README.md` },
    result: { content: [{ type: "text", text: "x".repeat(300) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ${cwd}/README.md`] },
  } as ToolRowLike;
  mount([row]);
  assert.equal(composedFactsOf(row), undefined);
  assert.match(line(row), /^ {2}▏ › read ~\/projects\/commercial\/README\.md {2,}0\.3k ch$/);
});
