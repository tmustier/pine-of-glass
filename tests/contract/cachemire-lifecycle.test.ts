// Installed-Pi lifecycle contract for Cachemire's process-global state. The extension
// loader and both ExtensionRunner instances are real; core actions and UI output are
// inert boundary adapters because their behaviour is not under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pi from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { assistantMessage } from "../helpers.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

type PiExtension = ConstructorParameters<typeof pi.ExtensionRunner>[0][number];
type MinimalUi = {
  theme: undefined;
  setWidget: (key: string, widget: unknown) => void;
  notify: (text: string) => void;
};

test("real ExtensionRunner keeps a headless child out of Cachemire's interactive state", async () => {
  const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href) as {
    loadExtensionFromFactory: (
      factory: typeof piCachemire,
      cwd: string,
      eventBus: ReturnType<typeof pi.createEventBus>,
      runtime: ReturnType<typeof pi.createExtensionRuntime>,
      extensionPath?: string,
    ) => Promise<PiExtension>;
  };
  assert.equal(
    typeof loader.loadExtensionFromFactory,
    "function",
    "Pi's factory loader moved; Cachemire's nested-runner lifecycle contract needs a new seam",
  );

  const cwd = tmpdir();
  const makeRunner = async (ui?: MinimalUi) => {
    const runtime = pi.createExtensionRuntime();
    const extension = await loader.loadExtensionFromFactory(
      piCachemire,
      cwd,
      pi.createEventBus(),
      runtime,
      "pi-cachemire-contract",
    );
    const runner = new pi.ExtensionRunner(
      [extension],
      runtime,
      cwd,
      pi.SessionManager.inMemory(cwd),
      {} as never,
    );
    runner.bindCore(
      { getThinkingLevel: (): "off" => "off" } as never,
      {
        getModel: () => undefined,
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
      },
    );
    if (ui) runner.setUIContext(ui as never, "tui");
    const errors: string[] = [];
    runner.onError((error) => errors.push(`${error.event}: ${error.error}`));
    return { runner, errors };
  };

  const notifications: string[] = [];
  const rootUi: MinimalUi = {
    theme: undefined,
    setWidget(_key, widget): void {
      if (typeof widget === "function") widget({ requestRender: () => {} });
    },
    notify(text): void {
      notifications.push(text);
    },
  };
  const root = await makeRunner(rootUi);
  const child = await makeRunner();
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
  const showRootLedger = async () => {
    const command = root.runner.getCommand("cache");
    assert.ok(command, "real Pi loader did not register Cachemire's /cache command");
    await command.handler("", root.runner.createCommandContext());
  };

  assert.equal(child.runner.hasUI(), false, "Pi no longer marks the SDK-style runner headless");
  assert.equal(root.runner.hasUI(), true, "Pi no longer marks the interactive runner as UI-owning");

  try {
    // Production seam from issue #44: two real Pi extension instances share one process,
    // but only the runner with a UI may own Cachemire's process-global state.
    await child.runner.emit({ type: "session_start", reason: "startup" });
    await root.runner.emit({ type: "session_start", reason: "startup" });
    await child.runner.emitBeforeProviderRequest({ model: "child", messages: [] });
    await child.runner.emitMessageEnd({
      type: "message_end",
      message: billedMessage("child", 32_800),
    });
    await showRootLedger();

    await root.runner.emitBeforeProviderRequest({ model: "root", messages: [] });
    await root.runner.emitMessageEnd({
      type: "message_end",
      message: billedMessage("root", 1_000),
    });
    await showRootLedger();
  } finally {
    await child.runner.emit({ type: "session_shutdown", reason: "quit" });
    await root.runner.emit({ type: "session_shutdown", reason: "quit" });
  }

  assert.deepEqual(child.errors, [], "headless child lifecycle raised a real-runner error");
  assert.deepEqual(root.errors, [], "interactive root lifecycle raised a real-runner error");
  assert.equal(notifications.length, 2, "each /cache invocation should reach the root UI once");
  assert.match(notifications[0]!, /no model calls yet/, "the child call leaked into the root ledger");
  assert.match(notifications[1]!, /\b1\.0k\b/, "the root no longer records its own call");
  assert.doesNotMatch(notifications[1]!, /32\.8k/, "the child call contaminated the root ledger");
});
