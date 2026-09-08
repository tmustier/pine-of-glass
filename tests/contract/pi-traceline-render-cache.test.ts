import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent, createReadTool } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { TraceRenderCache } from "../../extensions/pi-traceline/render-cache.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { assistantMessage } from "../helpers.ts";

initTheme(undefined, false);
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);
afterEach(() => { trace.setTracelineChat(undefined); trace.resetRenderCache(); });

function row() {
  const comp = new ToolExecutionComponent("read", "cache-call", { path: "/src/a.txt" }, {}, {
    ...createReadTool("/tmp"),
    renderCall: (args: { path: string }) => new Text(`read ${args.path}`, 0, 0),
    renderResult: () => new Text("preview", 0, 0),
  }, { requestRender() {} } as never, "/tmp");
  const container = new Container();
  container.addChild(new AssistantMessageComponent(assistantMessage([
    { type: "toolCall", id: "cache-call", name: "read", arguments: { path: "/src/a.txt" } },
  ]), true));
  container.addChild(comp);
  trace.setTracelineChat(container as never);
  return comp;
}

const seam = (comp: ToolExecutionComponent) => comp as unknown as ToolRowLike;

test("warm output matches the raw renderer without recomputing nested values", () => {
  const comp = row();
  const cold = comp.render(80);
  trace.renderCacheWorkCounts(true);
  assert.deepEqual(comp.render(80), cold);
  assert.deepEqual(comp.render(80), trace.uncachedRenderTraceRow(seam(comp), 80));
  assert.deepEqual(trace.renderCacheWorkCounts(), {
    outputHits: 2, outputMisses: 0, intrinsicHits: 0, intrinsicMisses: 0,
  });
});

test("same-object args and result updates invalidate cached output", () => {
  const comp = row();
  const args = { path: "/src/a.txt" };
  comp.updateArgs(args);
  comp.render(80);
  args.path = "/src/b.txt";
  comp.updateArgs(args);
  assert.ok(comp.render(80).map(trace.stripAnsi).join().includes("b.txt"));

  const result = { content: [{ type: "text" as const, text: "small" }], isError: false };
  comp.updateResult(result, true);
  comp.render(80);
  result.content[0]!.text = "x".repeat(2_000);
  comp.updateResult(result);
  assert.ok(comp.render(80).map(trace.stripAnsi).join().includes("2.0k ch"));
  assert.deepEqual(comp.render(80), trace.uncachedRenderTraceRow(seam(comp), 80));
});

test("shared memo invalidation reaches its dependants, not unrelated entries", () => {
  const cache = new TraceRenderCache();
  const shared = {}, unrelated = {}, a = {}, b = {}, c = {};
  let sharedWork = 0, unrelatedWork = 0;
  const sharedMemo = () => cache.memo(shared, "value", () => ++sharedWork);
  const renderA = () => cache.value(a, "80", () => sharedMemo());
  const renderB = () => cache.value(b, "80", () => sharedMemo());
  const renderC = () => cache.value(c, "80", () => cache.memo(unrelated, "value", () => ++unrelatedWork));
  renderA(); renderB(); renderC();
  renderA(); renderB(); renderC();
  assert.deepEqual({ sharedWork, unrelatedWork }, { sharedWork: 1, unrelatedWork: 1 });
  cache.dirty(shared);
  renderA(); renderB(); renderC();
  assert.deepEqual({ sharedWork, unrelatedWork }, { sharedWork: 2, unrelatedWork: 1 });
  assert.equal(cache.memo(shared, "outside", () => ++sharedWork), 3);
  assert.equal(cache.memo(shared, "outside", () => ++sharedWork), 4);
});

test("resize variants are bounded and retain live invalidation links", () => {
  const cache = new TraceRenderCache();
  const owner = {}, dependency = {};
  let work = 0;
  for (let width = 40; width < 57; width++) {
    cache.value(owner, String(width), () => { cache.depend(dependency); return ++work; });
  }
  assert.equal(cache.value(owner, "56", () => ++work), 17, "newest variant stays warm");
  assert.equal(cache.value(owner, "40", () => ++work), 18, "oldest variant was evicted");
  cache.dirty(dependency);
  assert.equal(cache.value(owner, "56", () => ++work), 19, "live dependency edge invalidates");
});
