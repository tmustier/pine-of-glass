import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";

type Handler = (...args: unknown[]) => unknown;

function extensionProbe(): { pi: ExtensionAPI; handlers: Map<string, Handler[]>; commands: Map<string, Handler> } {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: Handler }): void {
      commands.set(name, options.handler);
    },
    registerProvider(): void {},
    unregisterProvider(): void {},
    getThinkingLevel(): string {
      return "off";
    },
  } as unknown as ExtensionAPI;
  piCachemire(pi);
  return { pi, handlers, commands };
}

function sessionContext(id: string, notifications?: string[]): unknown {
  const ui = {
    theme: undefined,
    setWidget(): void {},
    notify(text: string): void {
      notifications?.push(text);
    },
  };
  return {
    hasUI: notifications !== undefined,
    ui,
    model: {
      id,
      provider: id === "root" ? "anthropic" : "ollama-cloud",
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    sessionManager: {
      getSessionId: () => id,
      getEntries: () => [],
      getLeafId: () => undefined,
    },
    modelRegistry: {
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
  };
}

async function fire(probe: ReturnType<typeof extensionProbe>, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of probe.handlers.get(event) ?? []) await handler(...args);
}

const usage = (input: number) => ({
  input,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

test("a headless child activation cannot write through the interactive session", async () => {
  const root = extensionProbe();
  const child = extensionProbe();
  const rootNotifications: string[] = [];

  await fire(child, "session_start", {}, sessionContext("child"));
  await fire(root, "session_start", {}, sessionContext("root", rootNotifications));

  try {
    await fire(child, "agent_start", {}, sessionContext("child"));
    await fire(child, "before_provider_request", { payload: { model: "glm-5.2", messages: [] } });
    await fire(child, "message_end", { message: { role: "assistant", usage: usage(32_800) } });
    await fire(child, "before_provider_request", { payload: { model: "glm-5.2", messages: [] } });
    await fire(child, "message_end", { message: { role: "assistant", usage: usage(33_000) } });
    await fire(child, "agent_end", {});
    await fire(child, "session_shutdown", {});
    await root.commands.get("cache")?.("", sessionContext("root", rootNotifications));
  } finally {
    await fire(root, "session_shutdown", {});
  }

  assert.equal(rootNotifications.length, 1);
  assert.match(rootNotifications[0]!, /no model calls yet/);
});
