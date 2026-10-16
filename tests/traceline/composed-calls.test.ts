// Composed calls (design language §9.14): a codemode row states its effects, folds its
// nested calls by tool, marks nested failures and trimmed output, names the slow child,
// and reveals a per-call ledger whose live-only size cells come from nested events.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { AssistantMessageComponent, createReadToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";

import piTraceline from "../../extensions/pi-traceline/index.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, RecordedUi, type HostedExtension } from "../harness/extension-host.ts";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";
import { composedCall, type NestedFixture, type ComposedOptions } from "./runtime-fixtures.ts";

let project: IsolatedProject;
let viewport: ReturnType<typeof mouseViewport>;
let chat: Container;
let hosted: HostedExtension | undefined;
let toolCalls: Map<ToolExecutionComponent, ToolCall>;
let cwd: string;
const ENOENT = "ENOENT: no such file or directory, access '/x/README.md'";

// Pi's streamed preview and persisted arguments are distinct records. The contract
// suite runs codemode itself; these rows exercise their visible SDK component output.
function composedRow(nested: NestedFixture[], options: ComposedOptions = {}): ToolExecutionComponent {
  const id = `composed-${toolCalls.size}`;
  const { args, result } = composedCall(id, nested, options);
  const row = new ToolExecutionComponent("codemode", id, args, {}, undefined, viewport.view, options.cwd ?? project.dir);
  toolCalls.set(row, { type: "toolCall", id, name: "codemode", arguments: args });
  row.updateResult(result, options.running === true);
  return row;
}

async function mount(rows: ToolExecutionComponent[]): Promise<void> {
  chat.addChild(new AssistantMessageComponent(assistantMessage(rows.map((row) => toolCalls.get(row)!)), true));
  for (const row of rows) chat.addChild(row);
  hosted = await hostExtension(piTraceline, { project, ui: new RecordedUi(undefined, viewport.view) });
}

function line(row: ToolExecutionComponent, width = 120): string {
  return lines(row, width)[0] ?? "";
}

function lines(row: ToolExecutionComponent, width = 120): string[] {
  return row.render(width).map(stripAnsi).filter((text) => text.length > 0);
}

function toggleLedger(row: ToolExecutionComponent, width = 120): void {
  const painted = row.render(width);
  const y = painted.findIndex((text) => stripAnsi(text).trim().length > 0);
  assert.equal(row.handleMouse({
    type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
    width, height: painted.length, shift: false, alt: false, ctrl: false,
  })?.handled, true);
}

const reads = (paths: string[]): NestedFixture[] => paths.map((path) => ({ name: "read", args: { path: `${cwd}/${path}` } }));

beforeEach(() => {
  initTheme(undefined, false);
  project = new IsolatedProject();
  cwd = project.dir;
  viewport = mouseViewport();
  chat = new Container();
  viewport.view.addChild(chat);
  toolCalls = new Map();
});

afterEach(async () => {
  try { await hosted?.dispose(); }
  finally { hosted = undefined; project.dispose(); }
});

test("a codemode row is verb-led and effect-led: count, then members folded by tool", async () => {
  const row = composedRow([
    ...reads(["docs/a.md", "docs/b.md", "docs/c.md"]),
    { name: "bash", args: { command: "find docs -type f | head" } },
    { name: "mcp__monaco__get_account", args: { account_id: "1" } },
    { name: "mcp__monaco__get_account", args: { account_id: "2" } },
  ], { cwd });
  await mount([row]);
  const text = line(row);
  assert.match(text, /^ {2}▏ ▸ codemode 6 calls · read ×3 \.\/docs\/ · \$ find · monaco\/get_account ×2 {2,}0\.2k ch$/);
  assert.ok(!text.includes("Promise"), "the script source never reaches z0");
});

test("one distinct path keeps its basename; paged reads merge their ranges; mixed dirs carry none", async () => {
  const paged = composedRow([
    { name: "read", args: { path: `${cwd}/README.md`, offset: 1, limit: 200 } },
    { name: "read", args: { path: `${cwd}/README.md`, offset: 201, limit: 200 } },
  ], { cwd });
  const mixed = composedRow(reads(["docs/a.md", "src/b.ts"]), { cwd });
  const single = composedRow([{ name: "write", args: { path: "/tmp/out/report.json", content: "…" } }], { cwd });
  await mount([paged, mixed, single]);
  assert.ok(line(paged).includes("read ×2 ./README.md:1-200,201-400"), line(paged));
  assert.match(line(mixed), /codemode 2 calls · read ×2 {2,}/);
  assert.ok(line(single).includes("codemode 1 call · write /tmp/out/report.json"), line(single));
});

test("a script that called nothing says so", async () => {
  const row = composedRow([], { output: "x".repeat(11_600) });
  await mount([row]);
  assert.match(line(row), /^ {2}▏ › codemode script only {2,}11\.6k ch$/);
});

test("a nested failure inside a completed script marks the member; the bullet stays green", async () => {
  const row = composedRow([
    ...reads(["docs/a.md", "docs/b.md"]),
    { name: "read", args: { path: `${cwd}/docs/missing.md` }, status: "error", error: ENOENT },
  ], { cwd });
  await mount([row]);
  assert.ok(line(row).includes("read ×3 ✗1 ./docs/"), line(row));
  const raw = row.render(120).find((text) => text.trim().length > 0)!;
  assert.match(raw, /\x1b\[32m▸/, "the composed call completed, so its bullet is success ink");
  assert.match(raw, /\x1b\[33m✗1/, "the nested failure is warning ink (partial state)");
});

test("a failed script tints its discriminators and keeps the member marks", async () => {
  const row = composedRow([
    { name: "read", args: { path: `${cwd}/docs/missing.md` }, status: "error", error: ENOENT },
  ], { cwd, failed: true, output: "Script error:\nError: ENOENT" });
  await mount([row]);
  const raw = row.render(120).find((text) => text.trim().length > 0)!;
  assert.match(raw, /\x1b\[31m▸/, "error bullet");
  assert.match(raw, /\x1b\[31m\x1b\[1mcodemode/, "error-tinted verb");
  assert.ok(stripAnsi(raw).includes("read ✗1 ./docs/missing.md"));
});

test("trimmed output is a warning fact ahead of the size cell and lights the block's column", async () => {
  const trimmed = composedRow(reads(["docs/a.md"]), { cwd, trimmed: true, output: "x".repeat(40_100) });
  const tiny = composedRow(reads(["docs/b.md"]), { cwd, output: "ok" });
  await mount([trimmed, tiny]);
  assert.match(line(trimmed), / {2,}trimmed · 40\.2k ch$/, "the count is what reached the model: header, notice and cut output");
  assert.match(line(tiny), / {2,}0\.0k ch$/, "the live column shows the tiny neighbour's cell");
  const raw = trimmed.render(120).find((text) => text.trim().length > 0)!;
  assert.match(raw, /\x1b\[33mtrimmed/, "warning ink");
  // The trimmed cell and the plain cell share one right edge.
  assert.equal(line(trimmed).length, line(tiny).length);
});

test("wall time appears from 10s and names the member that explains it", async () => {
  const slow = composedRow([
    { name: "mcp__monaco__list_campaigns", args: { page_size: 100 }, durationMs: 1_900 },
    { name: "mcp__superhuman-mail__query_email_and_calendar", args: { question: "…" }, durationMs: 122_340 },
    { name: "bash", args: { command: "mkdir -p /tmp/x" }, durationMs: 3_900 },
  ], { wallSeconds: 122.4 });
  const quick = composedRow([{ name: "bash", args: { command: "ls" }, durationMs: 400 }], { wallSeconds: 0.5 });
  await mount([slow, quick]);
  const text = line(slow);
  assert.ok(text.includes("codemode 3 calls · 2m02s · "), text);
  assert.ok(text.includes("superhuman-mail/query_email_and_calendar 2m02s"), text);
  assert.ok(!text.includes("list_campaigns 1.9s"), "a member that does not explain the wall carries no duration");
  assert.ok(!line(quick).includes("0.5s"), line(quick));
});

test("the revealed ledger lists every call in order, indented under the parent, in its tool's grammar", async () => {
  const row = composedRow([
    { name: "read", args: { path: `${cwd}/docs/a.md`, offset: 1, limit: 40 }, durationMs: 23 },
    { name: "read", args: { path: `${cwd}/docs/missing.md` }, status: "error", error: ENOENT, durationMs: 7 },
    { name: "bash", args: { command: "cd /tmp && find docs -type f | head -3" }, durationMs: 540 },
    { name: "mcp__monaco__get_account", args: { account_id: "acc-1" }, durationMs: 1_914 },
    { name: "write", args: { path: "/tmp/out.json", content: "…" }, status: "cancelled" },
  ], { cwd });
  await mount([row]);
  assert.equal(lines(row).length, 1, "folded by default");
  toggleLedger(row);
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
  const rawLedger = row.render(120).slice(-5);
  assert.match(rawLedger[1]!, /\x1b\[31m›/, "error bullet");
  assert.match(rawLedger[4]!, /\x1b\[90m›/, "cancelled bullet is dim");
  toggleLedger(row);
  assert.equal(lines(row).length, 1);
});

test("nested result sizes are live-only: captured from nested events, absent on a restored row", async () => {
  const live = composedRow(reads(["docs/a.md", "docs/b.md"]), { cwd });
  const restored = composedRow(reads(["docs/a.md", "docs/b.md"]), { cwd, restored: true });
  await mount([live, restored]);
  toggleLedger(live);
  toggleLedger(restored);
  assert.ok(lines(live).slice(1).every((text) => !text.endsWith("ch")), "no sizes before live events");
  const parentToolCallId = toolCalls.get(live)!.id;
  await hosted!.session.extensionRunner.emit({
    type: "tool_execution_start", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "read", args: { path: `${cwd}/docs/a.md` },
  });
  await hosted!.session.extensionRunner.emit({
    type: "tool_execution_end", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "read", result: { content: [{ type: "text", text: "y".repeat(12_400) }] }, isError: false,
  });
  await hosted!.session.extensionRunner.emit({
    type: "tool_execution_end", toolCallId: `${parentToolCallId}/2`, parentToolCallId,
    toolName: "read", result: { content: [{ type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "note" }] }, isError: false,
  });
  const liveLedger = lines(live).slice(1);
  assert.match(liveLedger[0]!, / {2,}12\.4k ch$/);
  assert.match(liveLedger[1]!, / {2,}png$/, "an image result shows its what-fact, not a char count");
  const restoredLedger = lines(restored).slice(1);
  assert.equal(restoredLedger.length, 2, "the persisted nestedCalls record still yields the ledger");
  assert.ok(restoredLedger.every((text) => !text.endsWith("ch")), `no size cells without live evidence: ${restoredLedger}`);
  assert.equal(line(restored).includes("read ×2 ./docs/"), true);
});

test("a live nested error observed by event overrides an optimistic streamed status", async () => {
  const row = composedRow([{ name: "bash", args: { command: "false" } }], { cwd });
  await mount([row]);
  assert.ok(!line(row).includes("✗"), "the streamed ledger initially reports success");
  const parentToolCallId = toolCalls.get(row)!.id;
  await hosted!.session.extensionRunner.emit({
    type: "tool_execution_end", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "bash", result: { content: [{ type: "text", text: "exit 1" }] }, isError: true,
  });
  assert.ok(line(row).includes("$ false ✗1") || line(row).includes("$ ✗1"), line(row));
});

test("a running script renders from the streamed ledger in running ink", async () => {
  const row = composedRow([
    { name: "mcp__monaco__get_account", args: { account_id: "1" }, durationMs: 120 },
    { name: "mcp__monaco__get_account", args: { account_id: "2" }, status: "running" },
  ], { running: true });
  await mount([row]);
  const raw = row.render(120).find((text) => text.trim().length > 0)!;
  assert.match(stripAnsi(raw), /^ {2}▏ ▸ codemode 2 calls · monaco\/get_account ×2 *$/);
  assert.match(raw, /\x1b\[34m▸/, "running bullet");
  toggleLedger(row);
  const running = row.render(120).at(-1)!;
  assert.match(running, /\x1b\[34m›/, "the in-flight nested call has a running bullet");
});

test("truncated argument previews recover their read path and range from persisted or live arguments", async () => {
  const args = { path: `${cwd}/${"deep/".repeat(40)}docs/recovered.md`, offset: 4, limit: 7 };
  const persisted = composedRow([{ name: "read", args }]);
  const live = composedRow([{ name: "read", args, status: "running" }], { running: true });
  await mount([persisted, live]);
  toggleLedger(persisted);
  toggleLedger(live);
  assert.match(lines(persisted)[1]!, /› read .*\/docs\/recovered\.md:4-10 *$/, "persisted typed arguments repair the completed row's cut preview");
  assert.ok(!lines(live)[1]!.includes("recovered.md"), "the cut preview has no path before its live start event");
  const parentToolCallId = toolCalls.get(live)!.id;
  await hosted!.session.extensionRunner.emit({
    type: "tool_execution_start", toolCallId: `${parentToolCallId}/1`, parentToolCallId,
    toolName: "read", args,
  });
  assert.match(lines(live)[1]!, /› read .*\/docs\/recovered\.md:4-10 *$/, "the full live arguments repair the running row's cut preview");
});

test("composed rows never fold as repetitions; the block's truncation budget still holds", async () => {
  const a = composedRow(reads(["docs/a.md"]), { cwd });
  const b = composedRow(reads(["docs/a.md"]), { cwd });
  const wide = composedRow(reads(Array.from({ length: 30 }, (_, i) => `go-to-market/motions/lead-generation/file-${i}.md`)), { cwd, output: "x".repeat(20_000) });
  await mount([a, b, wide]);
  assert.equal(lines(a).length, 1);
  assert.equal(lines(b).length, 1, "the second row keeps its own line rather than folding into ×2");
  for (const width of [60, 80, 100]) {
    const text = line(wide, width);
    assert.ok(text.length <= width, `${width}: ${text.length}`);
    assert.match(text, / 20\.0k ch$/);
  }
});

test("an ordinary tool row keeps its read grammar and result size", async () => {
  const id = "ordinary-read";
  const args = { path: `${homedir()}/projects/commercial/README.md` };
  const row = new ToolExecutionComponent("read", id, args, {}, createReadToolDefinition(project.dir), viewport.view, project.dir);
  toolCalls.set(row, { type: "toolCall", id, name: "read", arguments: args });
  row.updateResult({ content: [{ type: "text", text: "x".repeat(300) }], isError: false });
  await mount([row]);
  assert.match(line(row), /^ {2}▏ › read ~\/projects\/commercial\/README\.md {2,}0\.3k ch$/);
});
