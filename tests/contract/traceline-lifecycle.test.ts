// Installed-Pi lifecycle contract for Traceline's TUI handle.
// Both ExtensionRunner instances are real. The UI records onTerminalInput.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pi from "@earendil-works/pi-coding-agent";

import piTraceline, { internals } from "../../extensions/pi-traceline/index.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

type PiExtension = ConstructorParameters<typeof pi.ExtensionRunner>[0][number];
type TerminalListener = (data: string) => { consume?: boolean; data?: string } | undefined;
type MinimalUi = {
  theme: undefined;
  setWidget: (key: string, widget: unknown) => void;
  onTerminalInput: (handler: TerminalListener) => () => void;
  getToolsExpanded: () => boolean;
  setToolsExpanded: (expanded: boolean) => void;
};

test("real ExtensionRunner keeps a headless subagent child out of Traceline's TUI", async () => {
  const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href) as {
    loadExtensionFromFactory: (
      factory: typeof piTraceline,
      cwd: string,
      eventBus: ReturnType<typeof pi.createEventBus>,
      runtime: ReturnType<typeof pi.createExtensionRuntime>,
      extensionPath?: string,
    ) => Promise<PiExtension>;
  };
  assert.equal(
    typeof loader.loadExtensionFromFactory,
    "function",
    "Pi's factory loader moved. Traceline's nested-runner lifecycle contract needs a new seam.",
  );

  const cwd = tmpdir();
  const makeRunner = async (ui?: MinimalUi) => {
    const runtime = pi.createExtensionRuntime();
    const extension = await loader.loadExtensionFromFactory(
      piTraceline,
      cwd,
      pi.createEventBus(),
      runtime,
      "pi-traceline-contract",
    );
    const modelRegistry = {
      registerProvider(): void {},
      unregisterProvider(): void {},
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    };
    const runner = new pi.ExtensionRunner(
      [extension],
      runtime,
      cwd,
      pi.SessionManager.inMemory(cwd),
      modelRegistry as never,
    );
    runner.bindCore(
      { getThinkingLevel: (): "off" => "off" } as never,
      {
        getModel: () => undefined,
        getScopedModels: () => [],
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

  const listeners: TerminalListener[] = [];
  let toolsExpanded = true;
  const rootUi: MinimalUi = {
    theme: undefined,
    setWidget(_key, widget): void {
      if (typeof widget === "function") widget({ requestRender: () => {} });
    },
    onTerminalInput(handler): () => void {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(expanded): void {
      toolsExpanded = expanded;
    },
  };
  const root = await makeRunner(rootUi);
  const child = await makeRunner();

  assert.equal(child.runner.hasUI(), false, "Pi no longer marks the SDK-style runner headless");
  assert.equal(root.runner.hasUI(), true, "Pi no longer marks the interactive runner as UI-owning");

  try {
    await root.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal(listeners.length, 1, "parent session_start should register the Ctrl+T listener");

    const status = { text: "Thinking blocks: hidden", setText(): void {}, render: () => [] };
    const chatChildren = [status];
    internals.setTracelineChat({ children: chatChildren });

    await child.runner.emit({ type: "session_start", reason: "startup" });
    await child.runner.emit({ type: "session_shutdown", reason: "quit" });

    assert.equal(listeners.length, 1, "child session_shutdown unsubscribed the parent Ctrl+T listener");
    assert.equal(
      internals.suppressThinkingToggleStatus(),
      true,
      "child session_start cleared the parent chat container",
    );
    assert.equal(listeners[0]!("\x14"), undefined, "Ctrl+T must continue to Pi");
    assert.equal(toolsExpanded, false, "Ctrl+T must still collapse Ctrl+O expansion");
  } finally {
    await child.runner.emit({ type: "session_shutdown", reason: "quit" });
    await root.runner.emit({ type: "session_shutdown", reason: "quit" });
  }

  assert.deepEqual(child.errors, [], "headless child lifecycle raised a real-runner error");
  assert.deepEqual(root.errors, [], "interactive root lifecycle raised a real-runner error");
});
