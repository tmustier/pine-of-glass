// Two Pi sessions share one process (issue #44): only the one with a UI owns the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

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
    await headless.session.extensionRunner.emitContext([]);
    await headless.session.extensionRunner.emitBeforeProviderRequest({ model: "headless", messages: [] });
    await headless.session.extensionRunner.emitMessageEnd({ type: "message_end", message: billedMessage("headless", 32_800) });
    await interactive.session.prompt("/cache");

    await interactive.session.extensionRunner.emitContext([]);
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

test("/cache reconciles Pi's persisted cache warming usage", async () => {
  const project = new IsolatedProject();
  const host = await hostExtension(piCachemire, { project, reason: "new" });
  const normal = assistantMessage([], {
    usage: {
      input: 0,
      output: 20,
      cacheRead: 0,
      cacheWrite: 100_000,
      totalTokens: 100_020,
      cost: { total: 0.1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0.1 },
    },
  });
  try {
    host.session.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    await host.session.extensionRunner.emitContext([]);
    await host.session.extensionRunner.emitBeforeProviderRequest({ model: normal.model, messages: [] });
    await host.session.extensionRunner.emitMessageEnd({ type: "message_end", message: normal });
    host.session.sessionManager.appendMessage(normal);
    host.session.sessionManager.appendUsage("cache_warm", normal.provider, normal.model, {
      input: 100,
      output: 1,
      cacheRead: 99_900,
      cacheWrite: 0,
      totalTokens: 100_001,
      cost: { total: 0.02, input: 0, output: 0, cacheRead: 0.02, cacheWrite: 0 },
    });

    await host.session.prompt("/cache");
    const ledger = host.ui.notifications.at(-1)!;
    assert.match(ledger, /warm · hit/);
    assert.match(ledger, /totals: 2 calls/);
  } finally {
    await host.dispose();
    project.dispose();
  }
});

test("switching branches does not ingest an already restored warm entry twice", async () => {
  const project = new IsolatedProject();
  const manager = SessionManager.inMemory(project.dir);
  const usage = {
    input: 0,
    output: 10,
    cacheRead: 0,
    cacheWrite: 50_000,
    totalTokens: 50_010,
    cost: { total: 0.05, input: 0, output: 0, cacheRead: 0, cacheWrite: 0.05 },
  };
  const root = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  manager.appendMessage(assistantMessage([], { usage }));
  const warmA = manager.appendUsage("cache_warm", "test", "model", usage);
  manager.branch(root);
  manager.appendMessage(assistantMessage([], { usage }));
  const warmB = manager.appendUsage("cache_warm", "test", "model", usage);
  const host = await hostExtension(piCachemire, { project, sessionManager: manager });
  try {
    manager.branch(warmA.id);
    await host.session.extensionRunner.emit({
      type: "session_tree",
      newLeafId: warmA.id,
      oldLeafId: warmB.id,
    });
    await host.session.extensionRunner.emitContext([]);
    await host.session.prompt("/cache");
    assert.match(host.ui.notifications.at(-1)!, /totals: 2 calls/);
  } finally {
    await host.dispose();
    project.dispose();
  }
});
