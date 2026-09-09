// Installed-Pi lifecycle contract for Traceline's TUI handle: a headless subagent child
// sharing the process must not drop the interactive parent's TUI handle or Ctrl+T listener.
import { test } from "node:test";
import assert from "node:assert/strict";

import piTraceline, { internals } from "../../extensions/pi-traceline/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

test("real ExtensionRunner keeps a headless subagent child out of Traceline's TUI", async () => {
  const project = new IsolatedProject();
  const root = await hostExtension(piTraceline, { name: "pi-traceline-contract", project });
  const child = await hostExtension(piTraceline, {
    name: "pi-traceline-contract",
    interactive: false,
    project,
  }).catch(async (error: unknown) => {
    await root.dispose().finally(() => project.dispose());
    throw error;
  });
  const listeners = root.ui.terminalListeners;

  assert.equal(child.runner.hasUI(), false, "Pi no longer marks the SDK-style runner headless");
  assert.equal(root.runner.hasUI(), true, "Pi no longer marks the interactive runner as UI-owning");

  try {
    await root.start();
    assert.equal(listeners.length, 1, "parent session_start should register the Ctrl+T listener");

    const status = { text: "Thinking blocks: hidden", setText(): void {}, render: () => [] };
    internals.setTracelineChat({ children: [status] });

    await child.start();
    await child.shutdown();

    assert.equal(listeners.length, 1, "child session_shutdown unsubscribed the parent Ctrl+T listener");
    assert.equal(internals.suppressThinkingToggleStatus(), true, "child session_start cleared the parent chat container");
    assert.equal(listeners[0]!("\x14"), undefined, "Ctrl+T must continue to Pi");
    assert.equal(root.ui.toolsExpanded, false, "Ctrl+T must still collapse Ctrl+O expansion");
  } finally {
    try {
      await child.dispose();
    } finally {
      try {
        await root.dispose();
      } finally {
        project.dispose();
      }
    }
  }

  assert.deepEqual(child.errors, [], "headless child lifecycle raised a real-runner error");
  assert.deepEqual(root.errors, [], "interactive root lifecycle raised a real-runner error");
});
