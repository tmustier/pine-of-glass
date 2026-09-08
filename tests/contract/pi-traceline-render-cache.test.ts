import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, ToolExecutionComponent, createReadTool } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { TraceRenderCache } from "../../extensions/pi-traceline/render-cache.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { assistantBefore } from "../traceline/runtime-fixtures.ts";

initTheme(undefined, false);
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);

afterEach(() => {
  trace.setTracelineChat(undefined);
  trace.resetRenderCache();
});

let nextCallId = 0;
function row(path: string, calls: string[], resultText = "done") {
  const definition = {
    ...createReadTool("/tmp"),
    name: "read",
    renderCall: (args: { path: string }) => {
      const text = new Text(`read ${args.path}`, 0, 0);
      const render = text.render.bind(text);
      text.render = (width) => { if (width === 10_000) calls.push(args.path); return render(width); };
      return text;
    },
    renderResult: () => new Text("preview", 0, 0),
  };
  const comp = new ToolExecutionComponent(
    "read", `cache-call-${nextCallId++}`, { path }, {}, definition,
    { requestRender() {} } as never, "/tmp",
  );
  comp.updateResult({ content: [{ type: "text", text: resultText }], isError: false });
  return comp;
}
function seam(comp: ToolExecutionComponent): ToolRowLike { return comp as unknown as ToolRowLike; }
function transcript(rows: ToolExecutionComponent[]) {
  const container = new Container();
  const assistant = Object.assign(assistantBefore(rows.map(seam), [], true), {
    render: () => [] as string[],
    invalidate() {},
  }) as unknown as Component;
  container.addChild(assistant);
  rows.forEach((item) => container.addChild(item));
  trace.setTracelineChat(container as never);
  return container;
}
function painted(container: Container, width = 80) {
  return container.render(width).map(trace.stripAnsi);
}

// This is deliberately an exact oracle comparison, not a hand-maintained rendering
// fixture: every warm cache path must remain observationally identical to a raw render.
test("warm renders hit and cached output exactly matches the uncached renderer", () => {
  const nativeCalls: string[] = [];
  const comp = row("/src/a.txt", nativeCalls, "x".repeat(240));
  transcript([comp]);

  trace.resetRenderCache();
  const cold = trace.cachedRenderTraceRow(seam(comp), 80);
  const afterCold = trace.renderCacheWorkCounts();
  const warm = trace.cachedRenderTraceRow(seam(comp), 80);

  assert.deepEqual(warm, cold);
  assert.deepEqual(warm, trace.uncachedRenderTraceRow(seam(comp), 80));
  const afterWarm = trace.renderCacheWorkCounts();
  assert.equal(afterWarm.outputHits, afterCold.outputHits + 1);
  assert.equal(afterWarm.outputMisses, afterCold.outputMisses);
  assert.equal(afterWarm.intrinsicHits, afterCold.intrinsicHits);
  assert.equal(afterWarm.intrinsicMisses, afterCold.intrinsicMisses);
});

test("real updateArgs and updateResult hooks notice same-object mutation", () => {
  const nativeCalls: string[] = [];
  const args = { path: "/src/a.txt" };
  const comp = row(args.path, nativeCalls, "small");
  const container = transcript([comp]);
  painted(container);

  args.path = "/src/b.txt";
  comp.updateArgs(args);
  assert.ok(painted(container).some((line) => line.includes("b.txt")), "mutated args must replace the cached invocation");

  const result = { content: [{ type: "text" as const, text: "small" }], isError: false };
  comp.updateResult(result);
  painted(container);
  result.content[0]!.text = "x".repeat(2_000);
  comp.updateResult(result);
  const cached = painted(container);
  assert.ok(cached.some((line) => line.includes("2.0k ch")), "mutated result must replace cached size/status facts");
  assert.deepEqual(
    trace.cachedRenderTraceRow(seam(comp), 80),
    trace.uncachedRenderTraceRow(seam(comp), 80),
  );
});

test("updating one fold does not recapture an unrelated group's native invocation", () => {
  const calls: string[] = [];
  const a = row("/one/a.txt", calls);
  const b = row("/one/b.txt", calls);
  const unrelated = row("/two/c.txt", calls);
  const container = transcript([a, b, unrelated]);
  painted(container);
  const unrelatedCaptures = calls.filter((path) => path === "/two/c.txt").length;
  assert.ok(unrelatedCaptures > 0, "count the native component's actual capture, not renderer construction");

  a.updateResult({ content: [{ type: "text", text: "changed" }], isError: false });
  painted(container);
  assert.equal(calls.filter((path) => path === "/two/c.txt").length, unrelatedCaptures);
});

test("container append, removal and clear invalidate fold carriers without stale links", () => {
  const calls: string[] = [];
  const a = row("/src/a.txt", calls);
  const b = row("/src/b.txt", calls);
  const container = transcript([a, b]);
  assert.ok(painted(container).some((line) => line.includes("2 calls")));

  const c = row("/src/c.txt", calls);
  container.addChild(c);
  assert.ok(painted(container).some((line) => line.includes("3 calls")), "append must invalidate the old carrier");
  container.removeChild(c);
  assert.ok(painted(container).some((line) => line.includes("2 calls")), "removal must restore the previous fold");
  container.clear();
  assert.deepEqual(painted(container), []);
});

test("engine tracks nested shared dependencies without invalidating unrelated work", () => {
  const cache = new TraceRenderCache();
  const shared = {};
  const unrelated = {};
  const a = {} as ToolRowLike;
  const b = {} as ToolRowLike;
  const c = {} as ToolRowLike;
  let sharedWork = 0;
  let unrelatedWork = 0;
  const sharedMemo = () => cache.memo(shared, "value", () => ++sharedWork);
  const renderA = () => cache.render(a, "80", () => [`a:${sharedMemo()}`]);
  const renderB = () => cache.render(b, "80", () => [`b:${sharedMemo()}`]);
  const renderC = () => cache.render(c, "80", () => [`c:${cache.memo(unrelated, "value", () => ++unrelatedWork)}`]);

  renderA(); renderB(); renderC();
  renderA(); renderB(); renderC();
  assert.deepEqual({ sharedWork, unrelatedWork }, { sharedWork: 1, unrelatedWork: 1 });
  cache.dirty(shared);
  renderA(); renderB(); renderC();
  assert.deepEqual({ sharedWork, unrelatedWork }, { sharedWork: 2, unrelatedWork: 1 });
  assert.equal(cache.memo(shared, "outside", () => ++sharedWork), 3, "memo is uncached outside render");
  assert.equal(cache.memo(shared, "outside", () => ++sharedWork), 4);
});

test("engine bounds owner variants and evicted reverse links cannot stale later renders", () => {
  const cache = new TraceRenderCache();
  const row = {} as ToolRowLike;
  const dependency = {};
  let work = 0;
  for (let width = 0; width < 17; width++) {
    cache.render(row, String(width), () => { cache.depend(dependency); return [String(++work)]; });
  }
  assert.equal(cache.render(row, "16", () => [String(++work)])[0], "17", "newest variant stays warm");
  assert.equal(cache.render(row, "0", () => [String(++work)])[0], "18", "oldest variant was evicted");
  cache.dirty(dependency);
  assert.equal(cache.render(row, "16", () => [String(++work)])[0], "19", "live dependency edge invalidates");
});
