import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, createReadTool, initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { AssistantRowPrototypeLike, ToolRowLike } from "../../extensions/_lib/chat.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { drillState, enterDrillMode, exitDrillMode, setSelected, type DrillHost } from "../../extensions/pi-traceline/drill.ts";
import { assistantMessage } from "../helpers.ts";

initTheme(undefined, false);
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);
trace.patchAssistantRowPrototype(AssistantMessageComponent.prototype as unknown as AssistantRowPrototypeLike);
let id = 0;
function makeRow(path: string, name = "read", pending = false) {
  const comp = new ToolExecutionComponent(name, `transition-${id++}`, { path, command: path }, {}, {
    ...createReadTool("/tmp"), name,
    renderCall: (args: { path: string }) => new Text(name === "bash" ? `$ ${args.path}` : `${name} ${args.path}`, 0, 0),
    renderResult: () => new Text("native result", 0, 0),
  }, { requestRender() {} } as never, "/tmp");
  if (!pending) comp.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
  return comp;
}
const seam = (row: ToolExecutionComponent) => row as unknown as ToolRowLike;
function step(rows: ToolExecutionComponent[], text = "step") {
  return new AssistantMessageComponent(assistantMessage([
    ...(text ? [{ type: "text" as const, text }] : []),
    ...rows.map((row) => ({ type: "toolCall" as const, id: String(seam(row).toolCallId), name: String(seam(row).toolName), arguments: {} })),
  ]), true);
}
function chat(...children: (ToolExecutionComponent | AssistantMessageComponent)[]) {
  const container = new Container();
  children.forEach((row) => container.addChild(row));
  trace.setTracelineChat(container as never);
  return container;
}
function equal(rows: ToolExecutionComponent[], width = 80) {
  for (const row of rows) assert.deepEqual(row.render(width), trace.uncachedRenderTraceRow(seam(row), width));
}
const text = (row: ToolExecutionComponent) => row.render(80).map(trace.stripAnsi).join();
function misses(render: () => void): number {
  trace.renderCacheWorkCounts(true); render(); return trace.renderCacheWorkCounts().outputMisses;
}
function complete(row: ToolExecutionComponent, size: number, error = false) {
  row.updateResult({ content: [{ type: "text", text: "x".repeat(size) }], isError: error });
}
afterEach(() => { exitDrillMode(); trace.resetRenderCache(); trace.setTracelineChat(undefined); trace.setTracelineThemeGetter(undefined); });

test("warm output matches the raw renderer", () => {
  const a = makeRow("/src/a");
  chat(step([a]), a);
  a.render(80);
  assert.equal(misses(() => equal([a])), 0);
});

test("same-object args and result updates invalidate cached output", () => {
  const a = makeRow("/src/a", "read", true);
  chat(step([a]), a);
  const args = { path: "/src/a" };
  a.updateArgs(args); a.render(80);
  args.path = "/src/b"; a.updateArgs(args);
  assert.ok(text(a).includes("/src/b"));
  const result = { content: [{ type: "text" as const, text: "small" }], isError: false };
  a.updateResult(result, true); a.render(80);
  result.content[0]!.text = "x".repeat(2_000); a.updateResult(result);
  assert.ok(text(a).includes("2.0k ch"));
  equal([a]);
});

test("a failed member breaks a warm fold without recomputing history", () => {
  const old = makeRow("/old/a"), a = makeRow("/live/a"), b = makeRow("/live/b", "read", true);
  chat(step([old], "history"), old, step([a, b], "live"), a, b);
  equal([old, a, b]);
  assert.ok(text(a).includes("2 calls"));
  complete(b, 2_000, true);
  assert.equal(misses(() => equal([old, a, b])), 2);
  assert.ok(!text(a).includes("2 calls") && text(b).includes("/live/b"));
});

test("assistant text deltas with unchanged structure keep historical traces cached", () => {
  const old = makeRow("/old/a");
  const live = new AssistantMessageComponent(assistantMessage([{ type: "text", text: "answer begins" }]), true);
  chat(step([old]), old, live).render(80);
  live.updateContent(assistantMessage([{ type: "text", text: "answer begins and keeps streaming" }]), true);
  assert.equal(misses(() => equal([old])), 0);
});

test("a neighbour's path change refreshes shared directory emphasis", () => {
  const a = makeRow("/tmp/project/src/shared/a.ts", "edit");
  const b = makeRow("/tmp/project/src/shared/b.ts", "edit");
  chat(step([a, b]), a, b); equal([a, b]);
  const before = b.render(80);
  a.updateArgs({ path: "/tmp/project/other/a.ts" });
  equal([a, b]); assert.notDeepEqual(b.render(80), before);
});

test("same-step repeated calls follow changed sibling status without touching another step", () => {
  const a = makeRow("echo hello", "bash"), b = makeRow("echo hello", "bash", true), c = makeRow("echo hello", "bash");
  chat(step([a, b]), a, b, step([c], "separate"), c);
  equal([a, b, c]);
  complete(b, 2_300, true);
  assert.equal(misses(() => equal([c])), 0);
  equal([a, b]);
  assert.ok(text(a).includes("2.3k ch"));
});

test("bash preamble context crosses collapsed thinking until it becomes prose", () => {
  const a = makeRow("cd /tmp/one && echo a", "bash");
  const b = makeRow("cd /tmp/one && echo b", "bash");
  const thinking = new AssistantMessageComponent(assistantMessage([{ type: "thinking", thinking: "reason" }]), true);
  chat(step([a]), a, thinking, b);
  equal([a, b]);
  assert.ok(text(b).includes("⋯"));
  thinking.updateContent(assistantMessage([{ type: "text", text: "visible prose" }]));
  assert.ok(!text(b).includes("⋯"));
  equal([a, b]);
});

test("Pi-style insertion before a streaming assistant updates bash predecessor context", () => {
  const a = makeRow("cd /tmp/one && echo a", "bash");
  const b = makeRow("cd /tmp/one && echo b", "bash");
  const thinking = new AssistantMessageComponent(assistantMessage([{ type: "thinking", thinking: "reason" }]), true);
  const container = chat(step([a]), a, thinking, b);
  equal([a, b]); assert.ok(text(b).includes("⋯"));
  // InteractiveMode inserts messages immediately before its streaming component.
  container.children.splice(2, 0, step([], "inserted prose"));
  equal([a, b]); assert.ok(!text(b).includes("⋯"));
});

test("resize truncates a warm row and preserves its wider variant", () => {
  const row = makeRow("/project/src/components/a-long-component-name-and-its-helper.ts");
  chat(step([row]), row);
  const wide = row.render(100);
  const narrow = row.render(45);
  assert.notDeepEqual(narrow, wide);
  assert.ok(narrow.map(trace.stripAnsi).join().includes("…"));
  equal([row], 45);
  assert.equal(misses(() => assert.deepEqual(row.render(100), wide)), 0);
});

test("Drill entry, selection and exit update warm row styling", () => {
  const a = makeRow("/a/one"); const b = makeRow("/b/two");
  const container = chat(step([a, b]), a, b);
  const plain = [a.render(80), b.render(80)];
  const host: DrillHost = {
    ui: { custom: () => new Promise(() => {}), notify() {} } as never,
    theme: () => undefined, chatChildren: () => container.children, requestRender() {},
    traceLines: trace.renderTraceRow, runRows: () => undefined, hiddenByFold: () => false, statusTone: trace.statusTone,
  };
  enterDrillMode(host); equal([a, b]);
  assert.ok(text(b).includes("1 ›"));
  const numbered = [a.render(80), b.render(80)];
  setSelected(drillState()!, 1);
  assert.notDeepEqual([a.render(80), b.render(80)], numbered);
  equal([a, b]);
  exitDrillMode();
  assert.deepEqual([a.render(80), b.render(80)], plain);
});

test("real theme Proxy keeps its identity while Pi invalidation refreshes cached colours", async () => {
  const api = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
    theme: Theme; setTheme(name: string, watch: boolean): { success: boolean }; onThemeChange(callback: () => void): void;
  };
  const a = makeRow("/theme/a"); const container = chat(step([a]), a);
  trace.setTracelineThemeGetter(() => api.theme);
  api.setTheme("dark", false);
  const before = a.render(80);
  const proxy = api.theme;
  // InteractiveMode's real onThemeChange handler invalidates the mounted TUI.
  api.onThemeChange(() => container.invalidate());
  try {
    assert.equal(api.setTheme("light", false).success, true);
    assert.equal(api.theme, proxy, "the production theme is an identity-stable proxy");
    const after = a.render(80);
    assert.notDeepEqual(after, before);
    equal([a]);
  } finally { api.onThemeChange(() => {}); api.setTheme("dark", false); }
});

test("custom renderer invalidation replaces its warm invocation", () => {
  let invalidate = () => {};
  let label = "first";
  const b = new ToolExecutionComponent("custom", "custom-invalidate", {}, {}, {
    ...createReadTool("/tmp"), name: "custom",
    renderCall: (_args: unknown, _theme: unknown, context: { invalidate: () => void }) => { invalidate = context.invalidate; return new Text(label, 0, 0); },
    renderResult: () => new Text("result", 0, 0),
  }, { requestRender() {} } as never, "/tmp");
  complete(b, 20); chat(step([b]), b);
  assert.ok(text(b).includes("first"));
  label = "second"; invalidate();
  assert.ok(text(b).includes("second")); equal([b]);
});

test("replacement containers track batched membership changes with unchanged length", () => {
  const a = makeRow("/a/one"); chat(step([a]), a); equal([a]);
  const b = makeRow("/b/one"), c = makeRow("/b/two"), d = makeRow("/b/three");
  const container = chat(step([b, c, d]), b, c); equal([b, c]);
  container.addChild(d);
  container.removeChild(b);
  equal([c, d]);
  assert.ok(text(c).includes("2 calls"));
});
