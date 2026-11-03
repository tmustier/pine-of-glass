// Meantime keeps one timing ledger per Pi session, and only the agent loop's own requests and
// top-level tools count (docs/state-machines-2026-11-03.md).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import piMeantime from "../../extensions/pi-meantime/index.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";

const billed = (stopReason: "stop" | "toolUse" = "stop") => assistantMessage([{ type: "text", text: "answer" }], { stopReason });
const unbilled = () => assistantMessage([{ type: "text", text: "answer" }], {
  stopReason: "toolUse",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
});

type Payload = { model: string; max_tokens?: number; messages: Array<{ role: string; content: string }> };

async function request(host: HostedExtension, payload: Payload = { model: "fixture", messages: [] }): Promise<void> {
  await host.session.extensionRunner.emitContext([]);
  await host.session.extensionRunner.emitBeforeProviderRequest(payload);
}

async function tool(host: HostedExtension, toolCallId: string, edge: "start" | "end", parentToolCallId?: string) {
  const runner = host.session.extensionRunner;
  if (edge === "start") {
    await runner.emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args: {}, parentToolCallId });
  } else {
    await runner.emit({
      type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [] }, isError: false, parentToolCallId,
    });
  }
}

async function pace(host: HostedExtension): Promise<string> {
  await host.session.prompt("/pace");
  return host.ui.notifications.at(-1)!;
}

function clock(t: TestContext) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return { advance: (ms: number) => { now += ms; } };
}

/** One right-aligned /pace cell: the token in call `index`'s row that ends under `column`. */
function cell(ledger: string, index: number, column: string): string | undefined {
  const lines = ledger.split("\n");
  const header = lines.find((line) => /^\s*call\s/.test(line));
  const row = lines.find((line) => new RegExp(`^\\s*${index}\\s`).test(line));
  if (!header || !row) return undefined;
  const end = header.indexOf(` ${column}`) + column.length + 1;
  return row.slice(0, end).split(/\s+/).at(-1);
}

test("a headless session in the same process does not write into the interactive /pace ledger", async () => {
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true, widget: false });
  const parent = await hostExtension(piMeantime, { project });
  const child = await hostExtension(piMeantime, { project, interactive: false });
  try {
    const runner = child.session.extensionRunner;
    await runner.emit({ type: "agent_start" });
    await request(child);
    await runner.emitMessageEnd({ type: "message_end", message: billed() });
    await runner.emit({ type: "agent_end", messages: [] });
    assert.match(await pace(parent), /no timed model calls yet/, "the child's call leaked into the parent's ledger");
  } finally {
    await child.dispose();
    await parent.dispose();
    project.dispose();
  }
});

test("a child session ending does not freeze the interactive session's widget", async () => {
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true });
  const parent = await hostExtension(piMeantime, { project });
  const child = await hostExtension(piMeantime, { project, interactive: false });
  try {
    await child.dispose();
    await parent.session.extensionRunner.emit({ type: "agent_start" });
    await request(parent);
    assert.match(parent.ui.widgetLines("pi-meantime")?.join("\n") ?? "", /waiting/);
  } finally {
    await parent.dispose();
    project.dispose();
  }
});

test("/reload keeps the ledger", async () => {
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true, widget: false });
  const host = await hostExtension(piMeantime, { project });
  try {
    const runner = host.session.extensionRunner;
    await runner.emit({ type: "agent_start" });
    await request(host);
    await runner.emitMessageEnd({ type: "message_end", message: billed() });
    await runner.emit({ type: "agent_end", messages: [] });
    await host.session.reload();
    assert.match(await pace(host), /totals: 1 call/);
  } finally {
    await host.dispose();
    project.dispose();
  }
});

test("a response without usage keeps its tools out of the next call's tool time", async (t) => {
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true, widget: false });
  const host = await hostExtension(piMeantime, { project });
  const time = clock(t);
  try {
    const runner = host.session.extensionRunner;
    await runner.emit({ type: "agent_start" });
    await request(host);
    await runner.emitMessageEnd({ type: "message_end", message: unbilled() });
    await tool(host, "a", "start");
    time.advance(1_000);
    await tool(host, "a", "end");
    await request(host);
    await runner.emitMessageEnd({ type: "message_end", message: billed("toolUse") });
    await tool(host, "b", "start");
    time.advance(2_000);
    await tool(host, "b", "end");
    await request(host);
    await runner.emitMessageEnd({ type: "message_end", message: billed() });
    await runner.emit({ type: "agent_end", messages: [] });
    const ledger = await pace(host);
    assert.equal(cell(ledger, 1, "tools"), "2.0s", ledger);
  } finally {
    await host.dispose();
    project.dispose();
  }
});

test("nested calls that outlive a cancelled parent tool do not count as tool time", async (t) => {
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true, widget: false });
  const host = await hostExtension(piMeantime, { project });
  const time = clock(t);
  try {
    const runner = host.session.extensionRunner;
    await runner.emit({ type: "agent_start" });
    await request(host);
    await runner.emitMessageEnd({ type: "message_end", message: billed("toolUse") });
    await tool(host, "script", "start");
    await tool(host, "script/1", "start", "script");
    time.advance(1_000);
    await tool(host, "script", "end");
    time.advance(4_000);
    await request(host);
    await tool(host, "script/1", "end", "script");
    await runner.emitMessageEnd({ type: "message_end", message: billed() });
    await runner.emit({ type: "agent_end", messages: [] });
    const ledger = await pace(host);
    assert.equal(cell(ledger, 1, "tools"), "1.0s", ledger);
  } finally {
    await host.dispose();
    project.dispose();
  }
});

test("a cache-warm replay sent while the next request is being prepared does not start its clock", async (t) => {
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true, widget: false });
  const host = await hostExtension(piMeantime, { project });
  const time = clock(t);
  try {
    const runner = host.session.extensionRunner;
    const first = { model: "fixture", max_tokens: 4096, messages: [{ role: "user", content: "first" }] };
    await runner.emit({ type: "agent_start" });
    await request(host, first);
    time.advance(1_000);
    await runner.emitMessageEnd({ type: "message_end", message: billed("toolUse") });
    // The next request's context handlers run while the warmer replays the first request.
    await runner.emitContext([]);
    await runner.emitCacheWarmingDecision({
      type: "cache_warming_decision", warmCost: 0, missCost: 1, continuationProbability: 1, action: "warm",
    });
    await runner.emitBeforeProviderRequest({ ...first, max_tokens: 1 });
    time.advance(10_000);
    await runner.emitBeforeProviderRequest({
      model: "fixture", max_tokens: 4096, messages: [{ role: "user", content: "first" }, { role: "assistant", content: "answer" }],
    });
    time.advance(1_000);
    await runner.emitMessageEnd({ type: "message_end", message: billed() });
    await runner.emit({ type: "agent_end", messages: [] });
    const ledger = await pace(host);
    assert.equal(cell(ledger, 2, "total"), "1.0s", `context preparation was charged to the model:\n${ledger}`);
  } finally {
    await host.dispose();
    project.dispose();
  }
});
