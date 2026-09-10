// Two Pi sessions share one process (issue #44): only the one with a UI owns the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";
import { assistantMessage } from "../helpers.ts";

test("a headless child does not appear in the interactive Cachemire ledger", async () => {
  const project = new IsolatedProject();
  // The headless session starts first, so nothing but the UI check keeps it from claiming the ledger.
  const headless = await hostExtension(piCachemire, { project, interactive: false });
  const interactive = await hostExtension(piCachemire, { project });
  const billedMessage = (model: string, input: number) => assistantMessage([], {
    model,
    usage: {
      input,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + 10,
      cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  });

  try {
    await headless.session.extensionRunner.emitBeforeProviderRequest({ model: "headless", messages: [] });
    await headless.session.extensionRunner.emitMessageEnd({ type: "message_end", message: billedMessage("headless", 32_800) });
    await interactive.session.prompt("/cache");

    await interactive.session.extensionRunner.emitBeforeProviderRequest({ model: "interactive", messages: [] });
    await interactive.session.extensionRunner.emitMessageEnd({ type: "message_end", message: billedMessage("interactive", 1_000) });
    await interactive.session.prompt("/cache");
  } finally {
    await headless.dispose();
    await interactive.dispose();
    project.dispose();
  }

  const ledgers = interactive.ui.notifications;
  assert.equal(ledgers.length, 2, "each /cache invocation should reach the interactive UI once");
  assert.match(ledgers[0]!, /no model calls yet/, "the headless call leaked into the interactive ledger");
  assert.match(ledgers[1]!, /\b1\.0k\b/, "the interactive ledger did not record its own call");
  assert.doesNotMatch(ledgers[1]!, /32\.8k/, "the headless call contaminated the interactive ledger");
});
