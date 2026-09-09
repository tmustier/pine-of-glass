// Meantime is opt-in until its UX is ready for every user.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";

async function withProject(config: JsonObject | undefined, run: (host: HostedExtension) => Promise<void>) {
  const project = new IsolatedProject();
  if (config) project.writeProjectConfig("pi-meantime", config);
  let host: HostedExtension | undefined;
  try {
    host = await hostExtension(piMeantime, { project });
    await host.start("new");
    await run(host);
  } finally {
    try {
      await host?.dispose();
    } finally {
      project.dispose();
    }
  }
}

test("a project without meantime config gets no /pace command and no widget", async () => {
  await withProject(undefined, async (host) => {
    assert.equal(host.hasCommand("pace"), false);
    assert.equal(host.ui.widgets.size, 0, "meantime must not draw a widget while disabled");
  });
});

test("enabling meantime in .pi/pi-meantime.json makes /pace answer with the tempo ledger", async () => {
  await withProject({ enabled: true }, async (host) => {
    await host.runCommand("pace");
    assert.equal(host.ui.notifications.length, 1, "/pace should print one ledger");
    assert.match(host.ui.notificationTexts[0]!, /no timed model calls yet/);
  });
});

test("enabling meantime shows a waiting clock while a provider request is in flight", async () => {
  await withProject({ enabled: true }, async (host) => {
    assert.equal(host.ui.widgets.has("pi-meantime"), false, "idle sessions draw nothing");
    await host.runner.emit({ type: "agent_start" });
    await host.runner.emitBeforeProviderRequest({ model: "fixture", messages: [] });
    assert.match(host.ui.widgetLines("pi-meantime")?.join("\n") ?? "", /waiting/);
  });
});

test("widget: false keeps the widget away even mid-request, and still answers /pace", async () => {
  await withProject({ enabled: true, widget: false }, async (host) => {
    await host.runner.emit({ type: "agent_start" });
    await host.runner.emitBeforeProviderRequest({ model: "fixture", messages: [] });
    assert.equal(host.ui.widgets.has("pi-meantime"), false, "the widget is off by config, not by idleness");
    await host.runCommand("pace");
    assert.match(host.ui.notificationTexts[0]!, /no timed model calls yet/);
  });
});
