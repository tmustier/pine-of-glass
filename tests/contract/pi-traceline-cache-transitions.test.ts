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
function makeRow(path: string, name = "read", captures: string[] = []) {
  const comp = new ToolExecutionComponent(name, `transition-${id++}`, { path, command: path }, {}, {
    ...createReadTool("/tmp"), name,
    renderCall: (args: { path: string }) => {
      const text = new Text(name === "bash" ? `$ ${args.path}` : `${name} ${args.path}`, 0, 0);
      const render = text.render.bind(text);
      text.render = (width) => { if (width === 10_000) captures.push(args.path); return render(width); };
      return text;
    },
    renderResult: () => new Text("native result", 0, 0),
  }, { requestRender() {} } as never, "/tmp");
  comp.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
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
function complete(row: ToolExecutionComponent, size: number, error = false) {
  row.updateResult({ content: [{ type: "text", text: "x".repeat(size) }], isError: error });
}
afterEach(() => { exitDrillMode(); trace.resetRenderCache(); trace.setTracelineChat(undefined); trace.setTracelineThemeGetter(undefined); });

test("streaming group changes leave historical outputs and native captures warm", () => {
  const captures: string[] = [];
  const old = makeRow("/old/a", "read", captures);
  const a = makeRow("/live/a", "read", captures);
  const b = makeRow("/live/b", "read", captures);
  chat(step([old], "history"), old, step([a, b], "live"), a, b);
  [old, a, b].forEach((row) => row.render(80));
  const oldCount = captures.filter((path) => path === "/old/a").length;
  assert.ok(oldCount > 0);
  trace.renderCacheWorkCounts(true);
  complete(a, 2_000);
  [old, a, b].forEach((row) => row.render(80));
  assert.equal(trace.renderCacheWorkCounts().outputMisses, 2);
  assert.equal(captures.filter((path) => path === "/old/a").length, oldCount);
  equal([old, a, b]);
});

test("assistant text deltas with unchanged structure keep historical traces cached", () => {
  const old = makeRow("/old/a");
  const live = new AssistantMessageComponent(assistantMessage([{ type: "text", text: "answer begins" }]), true);
  const container = chat(step([old]), old, live);
  container.render(80);
  trace.renderCacheWorkCounts(true);
  live.updateContent(assistantMessage([{ type: "text", text: "answer begins and keeps streaming" }]), true);
  old.render(80);
  assert.equal(trace.renderCacheWorkCounts().outputMisses, 0);
  equal([old]);
});

test("fold errors, warning breakout, expanded boundaries and partial results match raw output", () => {
  const a = makeRow("/src/a"); const b = makeRow("/src/b"); const c = makeRow("/src/c");
  chat(step([a, b, c]), a, b, c);
  equal([a, b, c]);
  b.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
  equal([a, b, c]);
  complete(b, 2_300, true); equal([a, b, c]);
  complete(b, 50_000); equal([a, b, c]);
  b.setExpanded(true); equal([a, c]);
  b.setExpanded(false); complete(b, 20); equal([a, b, c]);
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
  const a = makeRow("echo hello", "bash"); const b = makeRow("echo hello", "bash");
  const c = makeRow("echo hello", "bash");
  chat(step([a, b]), a, b, step([c], "separate"), c);
  equal([a, b, c]);
  complete(b, 2_300, true);
  equal([a, b, c]);
  assert.ok(a.render(80).map(trace.stripAnsi).join().includes("2.3k ch"));
});

test("bash preamble dependency crosses collapsed thinking but stops at prose", () => {
  const a = makeRow("cd /tmp/one && echo a", "bash");
  const b = makeRow("cd /tmp/one && echo b", "bash");
  const thinking = new AssistantMessageComponent(assistantMessage([{ type: "thinking", thinking: "reason" }]), true);
  chat(step([a]), a, thinking, b);
  equal([a, b]);
  assert.ok(b.render(80).map(trace.stripAnsi).join().includes("⋯"));
  a.updateArgs({ path: "cd /tmp/two && echo a", command: "cd /tmp/two && echo a" });
  equal([a, b]);
  assert.ok(!b.render(80).map(trace.stripAnsi).join().includes("⋯"));
  thinking.updateContent(assistantMessage([{ type: "text", text: "visible prose" }]));
  equal([a, b]);
});

test("theme, width and Drill state never reuse stale styled variants", () => {
  const a = makeRow("/a/one"); const b = makeRow("/b/two");
  const container = chat(step([a, b]), a, b);
  equal([a, b]);
  // SAFETY: Traceline consumes fg at this theme seam; native Text is already built.
  const theme = { fg: (_tone: string, text: string) => `\x1b[35m${text}\x1b[39m` } as unknown as Theme;
  trace.setTracelineThemeGetter(() => theme);
  equal([a, b]); equal([a, b], 45); equal([a, b]);
  const host: DrillHost = {
    ui: { custom: () => new Promise(() => {}), notify() {} } as never,
    theme: () => theme, chatChildren: () => container.children, requestRender() {},
    traceLines: trace.renderTraceRow, runRows: () => undefined, hiddenByFold: () => false, statusTone: trace.statusTone,
  };
  enterDrillMode(host); equal([a, b]);
  assert.ok(b.render(80).map(trace.stripAnsi).join().includes("1 ›"));
  setSelected(drillState()!, 1); equal([a, b]);
  exitDrillMode(); equal([a, b]);
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

test("Pi mutation methods and custom renderer invalidate converge on the dirty hook", () => {
  const a = makeRow("/mutators/a"); chat(step([a]), a);
  assert.equal(typeof (a as unknown as { updateDisplay: unknown }).updateDisplay, "function");
  assert.equal(typeof (AssistantMessageComponent.prototype as unknown as { updateContent: unknown }).updateContent, "function");
  for (const mutate of [() => a.markExecutionStarted(), () => a.setArgsComplete(),
    () => a.setShowImages(false), () => a.setImageWidthCells(40), () => a.invalidate()]) {
    a.render(80); trace.renderCacheWorkCounts(true); mutate(); a.render(80);
    assert.equal(trace.renderCacheWorkCounts().outputMisses, 1);
  }
  let invalidate = () => {};
  let label = "first";
  const b = new ToolExecutionComponent("custom", "custom-invalidate", {}, {}, {
    ...createReadTool("/tmp"), name: "custom",
    renderCall: (_args: unknown, _theme: unknown, context: { invalidate: () => void }) => { invalidate = context.invalidate; return new Text(label, 0, 0); },
    renderResult: () => new Text("result", 0, 0),
  }, { requestRender() {} } as never, "/tmp");
  complete(b, 20); chat(step([b]), b); b.render(80);
  label = "second"; invalidate();
  assert.ok(b.render(80).map(trace.stripAnsi).join().includes("second")); equal([b]);
});

test("new containers install mutation hooks after prototypes are already patched", () => {
  const a = makeRow("/a/one"); chat(step([a]), a); equal([a]);
  const b = makeRow("/b/one"); const c = makeRow("/b/two");
  const container = chat(step([b]), b); equal([b]);
  container.addChild(c); equal([b, c]);
  assert.ok(b.render(80).map(trace.stripAnsi).join().includes("2 calls"));
  container.removeChild(c); equal([b]);
});
