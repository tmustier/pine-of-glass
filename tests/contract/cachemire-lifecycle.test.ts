// Installed-Pi lifecycle contract for Cachemire's process-global state: two real
// ExtensionRunner instances share one process (issue #44), and only the one with a UI
// may own the interactive ledger.
import { test } from "node:test";
import assert from "node:assert/strict";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension } from "../harness/extension-host.ts";
import { assistantMessage } from "../helpers.ts";

test("real ExtensionRunner keeps a headless child out of Cachemire's interactive state", async () => {
  const root = await hostExtension(piCachemire, { name: "pi-cachemire-contract" });
  const child = await hostExtension(piCachemire, { name: "pi-cachemire-contract", interactive: false });
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

  assert.equal(child.runner.hasUI(), false, "Pi no longer marks the SDK-style runner headless");
  assert.equal(root.runner.hasUI(), true, "Pi no longer marks the interactive runner as UI-owning");

  try {
    await child.start();
    await root.start();
    await child.runner.emitBeforeProviderRequest({ model: "child", messages: [] });
    await child.runner.emitMessageEnd({ type: "message_end", message: billedMessage("child", 32_800) });
    await root.runCommand("cache");

    await root.runner.emitBeforeProviderRequest({ model: "root", messages: [] });
    await root.runner.emitMessageEnd({ type: "message_end", message: billedMessage("root", 1_000) });
    await root.runCommand("cache");
  } finally {
    await child.dispose();
    await root.dispose();
  }

  assert.deepEqual(child.errors, [], "headless child lifecycle raised a real-runner error");
  assert.deepEqual(root.errors, [], "interactive root lifecycle raised a real-runner error");
  const ledgers = root.ui.notificationTexts;
  assert.equal(ledgers.length, 2, "each /cache invocation should reach the root UI once");
  assert.match(ledgers[0]!, /no model calls yet/, "the child call leaked into the root ledger");
  assert.match(ledgers[1]!, /\b1\.0k\b/, "the root no longer records its own call");
  assert.doesNotMatch(ledgers[1]!, /32\.8k/, "the child call contaminated the root ledger");
});
