// Meantime is opt-in until its UX is ready for every user.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";

async function withProject(config: JsonObject | undefined, run: (host: HostedExtension) => Promise<void>) {
  const project = new IsolatedProject();
  if (config) project.writeProjectConfig("pi-meantime", config);
  // Reason "new" resets meantime's process-global state, so specs are order-independent.
  const host = await hostExtension(piMeantime, { project, reason: "new" });
  try {
    await run(host);
  } finally {
    await host.dispose();
    project.dispose();
  }
}

test("a project without meantime config gets no /pace command and no widget", async () => {
  await withProject(undefined, async ({ session, ui }) => {
    assert.equal(session.extensionRunner.getCommand("pace"), undefined);
    assert.equal(ui.widgets.size, 0, "meantime must not draw a widget while disabled");
  });
});

test("enabling meantime in .pi/pi-meantime.json makes /pace answer with the tempo ledger", async () => {
  await withProject({ enabled: true }, async ({ session, ui }) => {
    await session.prompt("/pace");
    assert.equal(ui.notifications.length, 1, "/pace should print one ledger");
    assert.match(ui.notifications[0]!, /no timed model calls yet/);
  });
});

test("enabling meantime shows a waiting clock while a provider request is in flight", async () => {
  await withProject({ enabled: true }, async ({ session, ui }) => {
    assert.deepEqual(ui.widgetLines("pi-meantime"), [], "idle sessions draw no line");
    await session.extensionRunner.emit({ type: "agent_start" });
    await session.extensionRunner.emitContext([]);
    await session.extensionRunner.emitBeforeProviderRequest({ model: "fixture", messages: [] });
    assert.match(ui.widgetLines("pi-meantime")?.join("\n") ?? "", /waiting/);
  });
});

test("widget: false keeps the widget away even mid-request, and still answers /pace", async () => {
  await withProject({ enabled: true, widget: false }, async ({ session, ui }) => {
    await session.extensionRunner.emit({ type: "agent_start" });
    await session.extensionRunner.emitContext([]);
    await session.extensionRunner.emitBeforeProviderRequest({ model: "fixture", messages: [] });
    assert.equal(ui.widgets.has("pi-meantime"), false, "the widget is off by config, not by idleness");
    await session.prompt("/pace");
    assert.match(ui.notifications[0]!, /no timed model calls yet/);
  });
});

test("cache-warming provider hooks cannot replace a live tool phase with a phantom wait", async () => {
  await withProject({ enabled: true }, async ({ session, ui }) => {
    await session.extensionRunner.emit({ type: "agent_start" });
    await session.extensionRunner.emitContext([]);
    await session.extensionRunner.emitBeforeProviderRequest({ model: "fixture", messages: [] });
    await session.extensionRunner.emitMessageEnd({
      type: "message_end",
      message: assistantMessage([
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      ], { stopReason: "toolUse" }),
    });
    await session.extensionRunner.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    assert.match(ui.widgetLines("pi-meantime")?.join("\n") ?? "", /tools/);

    await session.extensionRunner.emitBeforeProviderRequest({ model: "fixture", max_tokens: 1, messages: [] });
    const line = ui.widgetLines("pi-meantime")?.join("\n") ?? "";
    assert.match(line, /tools/, "the real call's tool phase remains live");
    assert.doesNotMatch(line, /waiting/, "background provider traffic does not start a call");
  });
});

test("slow-start notices use completed prior calls, not the call being resolved", async (t) => {
  await withProject({ enabled: true }, async ({ session, ui }) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await session.extensionRunner.emit({ type: "agent_start" });
    for (const waitMs of [1_900, 1_700, 2_100, 14_200]) {
      await session.extensionRunner.emitContext([]);
      await session.extensionRunner.emitBeforeProviderRequest({ model: "fixture", messages: [] });
      now += waitMs;
      const message = assistantMessage([{ type: "text", text: "" }]);
      await session.extensionRunner.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
      });
      now += 500;
      message.content = [{ type: "text", text: "answer" }];
      await session.extensionRunner.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer", partial: message },
      });
      now += 500;
      await session.extensionRunner.emitMessageEnd({ type: "message_end", message });
    }
    assert.equal(ui.notifications.length, 1, "healthy calls stay silent");
    assert.match(ui.notifications[0]!, /slow start · first token 14s \(median 1.9s\)/);
    await session.prompt("/pace");
    assert.match(ui.notifications[1]!, /totals: 4 calls/);
  });
});
