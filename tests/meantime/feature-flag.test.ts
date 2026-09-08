// Meantime ships in the package before its UX is ready for every user, so it is opt-in.
// These specs drive the extension exactly as Pi does: the default export loaded through
// Pi's real loader, config read from the project's `.pi/pi-meantime.json`, behaviour
// observed through the command registry and the recorded UI. Nothing here names a hook
// or an internal function, so the extension is free to change how it registers itself.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";

async function withProject(config: JsonObject | undefined, run: (host: HostedExtension) => Promise<void>) {
  const project = new IsolatedProject();
  if (config) project.writeProjectConfig("pi-meantime", config);
  const host = await hostExtension(piMeantime, { project });
  try {
    await run(host);
  } finally {
    await host.dispose();
    project.dispose();
  }
}

test("a project without meantime config gets no /pace command and no widget", async () => {
  await withProject(undefined, async (host) => {
    await host.start();
    assert.equal(host.hasCommand("pace"), false);
    assert.equal(host.ui.widgets.size, 0, "meantime must not draw a widget while disabled");
    assert.deepEqual(host.errors, []);
  });
});

test("enabling meantime in .pi/pi-meantime.json makes /pace answer with the tempo ledger", async () => {
  await withProject({ enabled: true }, async (host) => {
    await host.start();
    await host.runCommand("pace");
    assert.deepEqual(host.errors, []);
    assert.equal(host.ui.notifications.length, 1, "/pace should print one ledger");
    assert.match(host.ui.notificationTexts[0]!, /no model calls yet|calls/i);
  });
});

test("enabling meantime shows a waiting clock while a provider request is in flight", async () => {
  await withProject({ enabled: true }, async (host) => {
    await host.start();
    assert.equal(host.ui.widgets.has("pi-meantime"), false, "idle sessions draw nothing");
    await host.runner.emit({ type: "agent_start" });
    await host.runner.emitBeforeProviderRequest({ model: "fixture", messages: [] });
    assert.match(host.ui.widgetLines("pi-meantime")?.join("\n") ?? "", /waiting/);
    await host.shutdown();
    assert.equal(host.ui.widgets.has("pi-meantime"), false, "shutdown clears the widget");
  });
});

test("a config that disables the widget still answers /pace", async () => {
  await withProject({ enabled: true, widget: false }, async (host) => {
    await host.start();
    assert.equal(host.ui.widgets.has("pi-meantime"), false);
    await host.runCommand("pace");
    assert.equal(host.ui.notifications.length, 1);
  });
});
