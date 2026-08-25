// A headless child session (pi-subagents general-purpose) shares this process with
// the interactive parent. It must not take Traceline's TUI handle or Ctrl+T listener.
// Oracle: the live 0.10.2 failure after a non-isolated subagent — thinking still
// toggles, the native "Thinking blocks:" status is not suppressed, rails stay gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piTraceline, { internals } from "../../extensions/pi-traceline/index.ts";

type Handler = (...args: unknown[]) => unknown;

function extensionProbe(): {
  handlers: Map<string, Handler[]>;
  listeners: Array<(data: string) => unknown>;
  ui: {
    onTerminalInput: (handler: (data: string) => unknown) => () => void;
    getToolsExpanded: () => boolean;
    setToolsExpanded: (expanded: boolean) => void;
  };
  toolsExpanded: () => boolean;
} {
  const handlers = new Map<string, Handler[]>();
  const listeners: Array<(data: string) => unknown> = [];
  let toolsExpanded = true;
  const tui = { requestRender(): void {} };
  const ui = {
    theme: undefined,
    setWidget(_key: string, factory: unknown): void {
      if (typeof factory === "function") (factory as (captured: { requestRender(): void }) => void)(tui);
    },
    onTerminalInput(handler: (data: string) => unknown): () => void {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded: (expanded: boolean) => {
      toolsExpanded = expanded;
    },
  };
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(): void {},
    registerShortcut(): void {},
  } as unknown as ExtensionAPI;
  piTraceline(pi);
  return {
    handlers,
    listeners,
    ui,
    toolsExpanded: () => toolsExpanded,
  };
}

function sessionContext(
  ui: unknown,
  hasUI: boolean,
  mode: string,
): { hasUI: boolean; mode: string; ui: unknown } {
  return { hasUI, mode, ui };
}

async function fire(
  probe: ReturnType<typeof extensionProbe>,
  event: string,
  ...args: unknown[]
): Promise<void> {
  for (const handler of probe.handlers.get(event) ?? []) await handler(...args);
}

test("a headless child activation cannot tear down the interactive Traceline TUI", async () => {
  const root = extensionProbe();
  const child = extensionProbe();

  await fire(root, "session_start", { type: "session_start" }, sessionContext(root.ui, true, "tui"));
  assert.equal(root.listeners.length, 1, "parent session_start should register the Ctrl+T listener");

  const status = { text: "Thinking blocks: hidden", setText(): void {}, render: () => [] };
  const chatChildren = [status];
  internals.setTracelineChat({ children: chatChildren });

  await fire(child, "session_start", { type: "session_start" }, sessionContext(child.ui, false, "rpc"));
  await fire(child, "session_shutdown", { type: "session_shutdown", reason: "quit" });

  assert.equal(
    root.listeners.length,
    1,
    "child session_shutdown unsubscribed the parent Ctrl+T listener",
  );
  assert.equal(
    internals.suppressThinkingToggleStatus(),
    true,
    "child session_start cleared the parent chat container",
  );
  assert.deepEqual(chatChildren, [], "status pair should still be removable after the child exits");

  assert.equal(root.listeners[0]!("\x14"), undefined, "Ctrl+T must continue to Pi");
  assert.equal(root.toolsExpanded(), false, "Ctrl+T must still collapse Ctrl+O expansion");
});
