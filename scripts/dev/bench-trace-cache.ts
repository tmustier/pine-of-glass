#!/usr/bin/env node
// Real Pi components, no model calls. Timings are observations, not CI thresholds.
// Run: node --expose-gc scripts/dev/bench-trace-cache.ts
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { AssistantMessageComponent, createReadTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { AssistantRowPrototypeLike, ToolRowLike } from "../../extensions/_lib/chat.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { assistantMessage } from "../../tests/helpers.ts";

const cases = [[50, 5], [200, 5], [500, 5], [200, 200]] as const;
if (process.argv[2] === undefined) {
  for (let i = 0; i < cases.length; i++) {
    const child = spawnSync(process.execPath, ["--expose-gc", import.meta.filename, String(i)], { stdio: "inherit", timeout: 120_000 });
    assert.equal(child.status, 0, `benchmark case ${i} failed`);
  }
  process.exit(0);
}
initTheme(undefined, false);
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);
trace.patchAssistantRowPrototype(AssistantMessageComponent.prototype as unknown as AssistantRowPrototypeLike);
const rowSeam = (row: ToolExecutionComponent) => row as unknown as ToolRowLike;
let captures = 0;
function makeRow(id: number) {
  const command = `cd /tmp/project && NODE_ENV=test npm run validate -- src/package-${id}/important-file.ts`;
  const row = new ToolExecutionComponent("bash", `bench-${id}`, { command }, {}, {
    ...createReadTool("/tmp"), name: "bash",
    renderCall: (args: { command: string }) => {
      const component = new Text(`$ ${args.command}`, 0, 0);
      const render = component.render.bind(component);
      component.render = (width) => { if (width === 10_000) captures++; return render(width); };
      return component;
    },
    renderResult: () => new Text("native output", 0, 0),
  }, { requestRender() {} } as never, "/tmp");
  row.updateResult({ content: [{ type: "text", text: "x".repeat(1024) }], isError: false });
  return row;
}
function message(rows: ToolExecutionComponent[], group: number) {
  return assistantMessage([
    { type: "text", text: `Step ${group}` },
    ...rows.map((row) => ({ type: "toolCall" as const, id: String(rowSeam(row).toolCallId), name: "bash", arguments: {} })),
  ]);
}
function sample(times: number[], fn: () => void) { const start = performance.now(); fn(); times.push(performance.now() - start); }
function distribution(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  return { medianMs: +sorted[Math.floor(sorted.length / 2)]!.toFixed(3), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1]!.toFixed(3) };
}

for (const [count, groupSize] of cases.slice(Number(process.argv[2]), Number(process.argv[2]) + 1)) {
  trace.resetRenderCache();
  const container = new Container();
  const rows: ToolExecutionComponent[] = [];
  let tail: AssistantMessageComponent | undefined;
  let tailRows: ToolExecutionComponent[] = [];
  for (let i = 0; i < count; i += groupSize) {
    const members = Array.from({ length: Math.min(groupSize, count - i) }, (_, j) => makeRow(i + j));
    tail = new AssistantMessageComponent(message(members, i), true);
    container.addChild(tail); members.forEach((row) => container.addChild(row));
    rows.push(...members); tailRows = members;
  }
  trace.setTracelineChat(container as never);
  const raw = () => rows.map((row) => trace.uncachedRenderTraceRow(rowSeam(row), 100));
  const cached = () => rows.map((row) => row.render(100));
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const check = () => {
    if (groupSize <= 50) assert.deepEqual(cached(), raw());
    else for (const index of [0, Math.floor(rows.length / 2), rows.length - 1]) {
      assert.deepEqual(rows[index]!.render(100), trace.uncachedRenderTraceRow(rowSeam(rows[index]!), 100));
    }
  };
  const cold: number[] = []; sample(cold, () => { cached(); }); check();
  const baseline: number[] = [];
  // The uncached giant-block path takes minutes. Sample oracle rows instead of
  // presenting a partial-transcript timing as a comparable full-frame baseline.
  if (groupSize <= 50) for (let i = 0; i < 3; i++) sample(baseline, () => { raw(); });
  const warm: number[] = []; captures = 0; trace.renderCacheWorkCounts(true);
  for (let i = 0; i < 30; i++) sample(warm, () => { cached(); });
  assert.equal(captures, 0, "warm frames must not capture native invocations");
  assert.equal(trace.renderCacheWorkCounts().outputMisses, 0);
  const streaming: number[] = []; const work: number[] = []; const parsed: number[] = [];
  for (let i = 0; i < 20; i++) {
    captures = 0; trace.renderCacheWorkCounts(true);
    sample(streaming, () => {
      rows.at(-1)!.updateResult({ content: [{ type: "text", text: "x".repeat(1024 + i) }], isError: false }, true);
      cached();
    });
    work.push(trace.renderCacheWorkCounts().outputMisses); parsed.push(captures);
  }
  assert.ok(work.every((misses) => misses === groupSize), "only the active block may recompute output");
  assert.ok(parsed.every((n) => n === 1), "only the mutated row may recapture its native invocation");
  const appends: number[] = [];
  for (let i = 0; i < 5; i++) sample(appends, () => {
    const row = makeRow(count + i); rows.push(row); tailRows.push(row);
    tail!.updateContent(message(tailRows, count), true); container.addChild(row); cached();
  });
  check();
  global.gc?.();
  console.log(JSON.stringify({ rows: count, groupSize, raw: baseline.length ? distribution(baseline) : null, cold: distribution(cold),
    warm: distribution(warm), activeUpdate: distribution(streaming), append: distribution(appends),
    activeOutputMisses: [...new Set(work)], activeNativeCaptures: [...new Set(parsed)],
    processHeapDeltaKiB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024) }));
  trace.setTracelineChat(undefined); trace.resetRenderCache();
}
