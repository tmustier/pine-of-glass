// Composed calls, the z0 row (design language §9.14): a codemode row states its effects,
// folds its nested calls by tool with per-member tone, marks nested failures and trimmed
// output, carries its failure fact, and names the slow child.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { createReadToolDefinition, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { ComposedHarness, ENOENT, line, lines, rawLine } from "./composed-harness.ts";

let h: ComposedHarness;

beforeEach(() => { h = new ComposedHarness(); });
afterEach(async () => { await h.dispose(); });

test("a codemode row is verb-led and effect-led: count, then members folded by tool", async () => {
  const row = h.composedRow([
    ...h.reads(["docs/a.md", "docs/b.md", "docs/c.md"]),
    { name: "bash", args: { command: "find docs -type f | head" } },
    { name: "mcp__monaco__get_account", args: { account_id: "1" } },
    { name: "mcp__monaco__get_account", args: { account_id: "2" } },
  ], { cwd: h.cwd });
  await h.mount([row]);
  const text = line(row);
  assert.match(text, /^ {2}▏ ▾ codemode 6 calls · read ×3 \.\/docs\/ · \$ find · monaco\/get_account ×2 {2,}0\.2k ch$/);
  assert.ok(!text.includes("Promise"), "the script source never reaches z0");
});

test("one distinct path keeps its basename; paged reads merge their ranges; mixed dirs carry none", async () => {
  const paged = h.composedRow([
    { name: "read", args: { path: `${h.cwd}/README.md`, offset: 1, limit: 200 } },
    { name: "read", args: { path: `${h.cwd}/README.md`, offset: 201, limit: 200 } },
  ], { cwd: h.cwd });
  const mixed = h.composedRow(h.reads(["docs/a.md", "src/b.ts"]), { cwd: h.cwd });
  const single = h.composedRow([{ name: "write", args: { path: "/tmp/out/report.json", content: "…" } }], { cwd: h.cwd });
  await h.mount([paged, mixed, single]);
  assert.ok(line(paged).includes("read ×2 ./README.md:1-200,201-400"), line(paged));
  assert.match(line(mixed), /codemode 2 calls · read ×2 {2,}/);
  assert.ok(line(single).includes("codemode 1 call · write /tmp/out/report.json"), line(single));
});

test("a script that called nothing says so, and a failed one says what it threw", async () => {
  const quiet = h.composedRow([], { output: "x".repeat(11_600) });
  const broken = h.composedRow([], { failed: true, output: "Script error:\nReferenceError: paths is not defined\n    at <anonymous>:1:7\n\nNo tool calls were made." });
  await h.mount([quiet, broken]);
  assert.match(line(quiet), /^ {2}▏ › codemode script only {2,}11\.6k ch$/);
  assert.match(line(broken), /^ {2}▏ › codemode script only {2,}ReferenceError: paths is not defined$/, line(broken));
  const raw = rawLine(broken);
  assert.match(raw, /\x1b\[31mReferenceError: paths is not defined/, "the failure fact is error ink");
});

test("a nested failure inside a completed script marks the member; the bullet stays green", async () => {
  const row = h.composedRow([
    ...h.reads(["docs/a.md", "docs/b.md"]),
    { name: "read", args: { path: `${h.cwd}/docs/missing.md` }, status: "error", error: ENOENT },
  ], { cwd: h.cwd });
  await h.mount([row]);
  assert.ok(line(row).includes("read ×3 ✗1 ./docs/"), line(row));
  const raw = rawLine(row);
  assert.match(raw, /\x1b\[32m▾/, "the composed call completed, so its bullet is success ink");
  assert.match(raw, /\x1b\[33m✗1/, "the nested failure is warning ink (partial state)");
  assert.match(raw, /\x1b\[1mread\x1b\[22m/, "a member with mixed outcomes keeps neutral bold");
});

test("a failed script tints its verb and the members that failed, not the ones that landed (§9.14)", async () => {
  const editError = "Could not find oldText in /x/presentation.ts";
  const row = h.composedRow([
    { name: "read", args: { path: `${h.cwd}/lib/quote-pack-pdf.ts` } },
    { name: "write", args: { path: `${h.cwd}/lib/customer-quote-presentation.ts`, content: "…" } },
    { name: "edit", args: { path: `${h.cwd}/lib/presentation.ts`, oldText: "a", newText: "b" }, status: "error", error: editError },
  ], { cwd: h.cwd, failed: true, output: `Script error:\nError: ${editError}\n    at <anonymous>:3:1\n\nTool calls made before the failure (they are not undone): read (ok), write (ok), edit (error)` });
  await h.mount([row]);
  const raw = rawLine(row);
  assert.match(raw, /\x1b\[31m▾/, "error bullet");
  assert.match(raw, /\x1b\[31m\x1b\[1mcodemode/, "error-tinted verb");
  assert.match(raw, /\x1b\[1mread\x1b\[22m\x1b\[90m · \x1b\[0m\x1b\[1mwrite\x1b\[22m/, "read and write stay neutral bold");
  assert.match(raw, /\x1b\[31m\x1b\[1medit\x1b\[22m\x1b\[0m \x1b\[33m✗1/, "the member that failed is red and counted");
  assert.match(stripAnsi(raw), /codemode 3 calls · read · write · edit ✗1 {2,}Error: Could not .*\/x\/presentation\.ts$/, "the fact takes the size cell's place");
  const ledger = lines(row).slice(1);
  assert.match(ledger[2]!, /^ {2}▏ {3}› edit \.\/lib\/presentation\.ts {2,}Could not find .*\/x\/presentation\.ts$/, "the ledger line carries the same fact");
});

test("trimmed output is a warning fact ahead of the size cell and lights the block's column", async () => {
  const trimmed = h.composedRow(h.reads(["docs/a.md"]), { cwd: h.cwd, trimmed: true, output: "x".repeat(40_100) });
  const tiny = h.composedRow(h.reads(["docs/b.md"]), { cwd: h.cwd, output: "ok" });
  await h.mount([trimmed, tiny]);
  assert.match(line(trimmed), / {2,}trimmed · 40\.2k ch$/, "the count is what reached the model: header, notice and cut output");
  assert.match(line(tiny), / {2,}0\.0k ch$/, "the live column shows the tiny neighbour's cell");
  const raw = rawLine(trimmed);
  assert.match(raw, /\x1b\[33mtrimmed/, "warning ink");
  // The trimmed cell and the plain cell share one right edge.
  assert.equal(line(trimmed).length, line(tiny).length);
});

test("wall time appears from 10s and names the member that explains it", async () => {
  const slow = h.composedRow([
    { name: "mcp__monaco__list_campaigns", args: { page_size: 100 }, durationMs: 1_900 },
    { name: "mcp__superhuman-mail__query_email_and_calendar", args: { question: "…" }, durationMs: 122_340 },
    { name: "bash", args: { command: "mkdir -p /tmp/x" }, durationMs: 3_900 },
  ], { wallSeconds: 122.4 });
  const quick = h.composedRow([{ name: "bash", args: { command: "ls" }, durationMs: 400 }], { wallSeconds: 0.5 });
  await h.mount([slow, quick]);
  const text = line(slow);
  assert.ok(text.includes("codemode 3 calls · 2m02s · "), text);
  assert.ok(text.includes("superhuman-mail/query_email_and_calendar 2m02s"), text);
  assert.ok(!text.includes("list_campaigns 1.9s"), "a member that does not explain the wall carries no duration");
  assert.ok(!line(quick).includes("0.5s"), line(quick));
});

test("composed rows never fold as repetitions; the block's truncation budget still holds", async () => {
  const a = h.composedRow(h.reads(["docs/a.md"]), { cwd: h.cwd });
  const b = h.composedRow(h.reads(["docs/a.md"]), { cwd: h.cwd });
  const wide = h.composedRow(h.reads(Array.from({ length: 30 }, (_, i) => `go-to-market/motions/lead-generation/file-${i}.md`)), { cwd: h.cwd, output: "x".repeat(20_000) });
  await h.mount([a, b, wide]);
  assert.equal(lines(a).length, 2);
  assert.equal(lines(b).length, 2, "the second row keeps its own line rather than folding into ×2");
  for (const width of [60, 80, 100]) {
    const text = line(wide, width);
    assert.ok(text.length <= width, `${width}: ${text.length}`);
    assert.match(text, / 20\.0k ch$/);
    for (const painted of lines(wide, width)) assert.ok(painted.length <= width, `${width}: ${painted}`);
  }
});

test("an ordinary tool row keeps its read grammar and result size", async () => {
  const id = "ordinary-read";
  const args = { path: `${homedir()}/projects/commercial/README.md` };
  const row = new ToolExecutionComponent("read", id, args, {}, createReadToolDefinition(h.project.dir), h.viewport.view, h.project.dir);
  h.toolCalls.set(row, { type: "toolCall", id, name: "read", arguments: args });
  row.updateResult({ content: [{ type: "text", text: "x".repeat(300) }], isError: false });
  await h.mount([row]);
  assert.match(line(row), /^ {2}▏ › read ~\/projects\/commercial\/README\.md {2,}0\.3k ch$/);
});
