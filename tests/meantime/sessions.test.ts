import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import piMeantime from "../../extensions/pi-meantime/index.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";

async function hostMeantime(t: TestContext, widget = false) {
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true, widget });
  const host = await hostExtension(piMeantime, { project });
  t.after(async () => {
    try {
      await host.dispose();
    } finally {
      project.dispose();
    }
  });
  return { ...host, project };
}

const billed = (toolCallId?: string) => assistantMessage(toolCallId
  ? [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "true" } }]
  : [{ type: "text", text: "answer" }], { stopReason: toolCallId ? "toolUse" : "stop" });
type Payload = { model: string; max_tokens?: number; messages: Array<{ role: "user" | "assistant"; content: string }> };

async function request(host: HostedExtension, payload: Payload = { model: "fixture", messages: [] }): Promise<void> {
  await host.session.extensionRunner.emitContext([]);
  await host.session.extensionRunner.emitBeforeProviderRequest(payload);
}

async function tool(host: HostedExtension, toolCallId: string, edge: "start" | "end", parentToolCallId?: string) {
  const runner = host.session.extensionRunner;
  if (edge === "start") {
    await runner.emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "true" }, parentToolCallId });
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
  assert.ok(header && row, ledger);
  const end = header.indexOf(` ${column}`) + column.length + 1;
  return row.slice(0, end).split(/\s+/).at(-1);
}

for (const interactive of [false, true]) {
  test(`a ${interactive ? "second interactive" : "headless"} runtime on one session id has its own /pace ledger`, async (t) => {
    const parent = await hostMeantime(t);
    const id = parent.session.sessionManager.getSessionId();
    const child = await hostExtension(piMeantime, {
      project: parent.project, interactive, sessionManager: SessionManager.inMemory(parent.project.dir, { id }),
    });
    try {
      const runner = child.session.extensionRunner;
      await runner.emit({ type: "agent_start" });
      await request(child);
      await runner.emitMessageEnd({ type: "message_end", message: billed() });
      await runner.emit({ type: "agent_end", messages: [] });
      assert.match(await pace(parent), /no timed model calls yet/);
      if (interactive) assert.match(await pace(child), /totals: 1 call/);
    } finally {
      await child.dispose();
    }
  });
}

test("a child session ending does not freeze the interactive session's widget", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const parent = await hostMeantime(t, true);
  const child = await hostExtension(piMeantime, { project: parent.project, interactive: false });
  await child.dispose();
  await parent.session.extensionRunner.emit({ type: "agent_start" });
  await request(parent);
  const before = parent.ui.widgetLines("pi-meantime")!.join("\n");
  t.mock.timers.tick(4_000);
  const after = parent.ui.widgetLines("pi-meantime")!.join("\n");
  assert.match(after, /waiting/);
  assert.notEqual(after, before, "the widget's clock stopped");
});

test("/reload keeps the ledger", async (t) => {
  const host = await hostMeantime(t);
  const runner = host.session.extensionRunner;
  await runner.emit({ type: "agent_start" });
  await request(host);
  await runner.emitMessageEnd({ type: "message_end", message: billed() });
  await runner.emit({ type: "agent_end", messages: [] });
  await host.session.reload();
  assert.match(await pace(host), /totals: 1 call/);
});

test("an SDK reload while a request streams keeps that request", async (t) => {
  const host = await hostMeantime(t);
  await host.session.extensionRunner.emit({ type: "agent_start" });
  await request(host);
  await host.session.reload();
  await host.session.extensionRunner.emitMessageEnd({ type: "message_end", message: billed() });
  await host.session.extensionRunner.emit({ type: "agent_end", messages: [] });
  assert.match(await pace(host), /totals: 1 call/);
});

test("a response without usage keeps its tools out of the next call's tool time", async (t) => {
  const host = await hostMeantime(t);
  const time = clock(t);
  const runner = host.session.extensionRunner;
  await runner.emit({ type: "agent_start" });
  await request(host);
  await runner.emitMessageEnd({ type: "message_end", message: assistantMessage([
    { type: "toolCall", id: "a", name: "bash", arguments: { command: "true" } },
  ], {
    stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  }) });
  await tool(host, "a", "start");
  time.advance(1_000);
  await tool(host, "a", "end");
  await request(host);
  await runner.emitMessageEnd({ type: "message_end", message: billed("b") });
  await tool(host, "b", "start");
  time.advance(2_000);
  await tool(host, "b", "end");
  await request(host);
  await runner.emitMessageEnd({ type: "message_end", message: billed() });
  await runner.emit({ type: "agent_end", messages: [] });
  const ledger = await pace(host);
  assert.equal(cell(ledger, 1, "tools"), "2.0s", ledger);
});

test("nested calls that outlive a cancelled parent tool do not count as tool time", async (t) => {
  const host = await hostMeantime(t);
  const time = clock(t);
  const runner = host.session.extensionRunner;
  await runner.emit({ type: "agent_start" });
  await request(host);
  await runner.emitMessageEnd({ type: "message_end", message: billed("script") });
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
});

test("a cache-warm replay sent while the next request is being prepared does not start its clock", async (t) => {
  const host = await hostMeantime(t);
  const time = clock(t);
  const runner = host.session.extensionRunner;
  const first: Payload = { model: "fixture", max_tokens: 4096, messages: [{ role: "user", content: "first" }] };
  await runner.emit({ type: "agent_start" });
  await request(host, first);
  time.advance(1_000);
  await runner.emitMessageEnd({ type: "message_end", message: billed() });
  // A queued follow-up prepares context while the warmer replays the first request.
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
});
