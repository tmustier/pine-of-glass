// Meantime is opt-in until its UX is ready for every user.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
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
    assert.equal(ui.widgets.has("pi-meantime"), false, "idle sessions draw nothing");
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
      message: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "fixture",
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 100,
          cacheWrite: 0,
          totalTokens: 102,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
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
