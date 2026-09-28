// Contextimate counts the prompt the latest run sent (extensions/pi-contextimate/README.md)
// because Pi exposes a before_agent_start rewrite through getSystemPrompt() only during
// the run. If Pi starts keeping the rewrite, Contextimate can read getSystemPrompt() directly.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

test("Pi shows a before_agent_start prompt rewrite only while its run is active", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("OK")]);
  const project = new IsolatedProject();
  let duringRun = "";
  const host = await hostExtension((pi) => {
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n<rewritten/>` }));
    pi.on("turn_start", (_event, ctx) => {
      duringRun = ctx.getSystemPrompt();
    });
  }, { project, model: faux.getModel() });
  try {
    host.session.modelRuntime.registerNativeProvider(faux.provider);
    const base = host.session.systemPrompt;
    await host.session.prompt("hello");
    assert.ok(duringRun.endsWith("<rewritten/>"), "Contextimate captures the run's prompt at turn_start");
    assert.equal(host.session.systemPrompt, base, "Pi reverts to its own prompt after the run");
  } finally {
    await host.dispose();
    project.dispose();
  }
});
