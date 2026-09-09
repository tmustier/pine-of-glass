import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";

type Handler = (...args: unknown[]) => unknown;

function probe(): { handlers: Map<string, Handler[]>; commands: Map<string, Handler> } {
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
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  piCachemire(pi);
  return { handlers, commands };
}

async function fire(runtime: ReturnType<typeof probe>, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of runtime.handlers.get(event) ?? []) await handler(...args);
}

function usage(input: number, cacheRead: number, cacheWrite = 0) {
  return {
    input,
    output: 10,
    cacheRead,
    cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(timestamp: number, prompt: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-opus-4-8",
    stopReason: "stop",
    timestamp,
    usage: usage(2, prompt - 2),
  };
}

function payload(messages: string[], tools?: unknown[]) {
  return {
    model: "claude-opus-4-8",
    system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
    messages: messages.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
    ...(tools ? { tools } : {}),
  };
}

function context(entries: unknown[], leaf: { id: string }, notifications: string[]) {
  return {
    hasUI: true,
    ui: {
      theme: undefined,
      setWidget(): void {},
      notify(text: string): void {
        notifications.push(text);
      },
    },
    model: {
      id: "claude-opus-4-8",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: false,
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    },
    sessionManager: {
      getEntries: () => entries,
      getLeafId: () => leaf.id,
    },
    modelRegistry: {
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
    getSystemPrompt: () => "",
  };
}

test("first request after hot reload diagnoses a changed tool schema", async () => {
  const now = Date.now();
  const entries: unknown[] = [{
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: new Date(now - 2_000).toISOString(),
    message: { role: "user", content: "before reload", timestamp: now - 2_000 },
  }];
  const leaf = { id: "user-1" };
  const notifications: string[] = [];
  const oldTool = { name: "computer_use", description: "Control apps", input_schema: { type: "object" } };
  const oldRuntime = probe();
  const oldContext = context(entries, leaf, notifications);
  const oldAssistant = assistant(now - 1_000, 100_000);

  await fire(oldRuntime, "session_start", { reason: "startup" }, oldContext);
  await fire(oldRuntime, "before_provider_request", { payload: payload(["before reload"], [oldTool]) }, oldContext);
  await fire(oldRuntime, "message_end", { message: oldAssistant });
  entries.push({
    type: "message",
    id: "assistant-1",
    parentId: leaf.id,
    timestamp: new Date(now - 1_000).toISOString(),
    message: oldAssistant,
  });
  leaf.id = "assistant-1";
  await fire(oldRuntime, "turn_end", {}, oldContext);
  await fire(oldRuntime, "session_shutdown", { reason: "reload" });

  const newRuntime = probe();
  const newContext = context(entries, leaf, notifications);
  await fire(newRuntime, "session_start", { reason: "reload" }, newContext);
  try {
    entries.push({
      type: "message",
      id: "user-2",
      parentId: leaf.id,
      timestamp: new Date(now).toISOString(),
      message: { role: "user", content: "after reload", timestamp: now },
    });
    leaf.id = "user-2";
    const changedTool = {
      ...oldTool,
      input_schema: { type: "object", properties: { code: { type: "string" } } },
    };
    await fire(
      newRuntime,
      "before_provider_request",
      { payload: payload(["before reload", "after reload"], [changedTool]) },
      newContext,
    );
    assert.match(notifications.at(-1)!, /cause: tools changed \(1 modified\)/);
  } finally {
    await fire(newRuntime, "agent_end");
    await fire(newRuntime, "session_shutdown", { reason: "quit" });
  }
});

test("session_tree rebases classification to the selected provider-known prompt", async () => {
  const now = Date.now();
  const entries = [
    { type: "message", id: "user-base", parentId: null, timestamp: new Date(now - 4_000).toISOString(), message: { role: "user", content: "base", timestamp: now - 4_000 } },
    { type: "message", id: "assistant-base", parentId: "user-base", timestamp: new Date(now - 3_000).toISOString(), message: assistant(now - 3_000, 100_000) },
    { type: "message", id: "user-old", parentId: "assistant-base", timestamp: new Date(now - 2_000).toISOString(), message: { role: "user", content: "old branch", timestamp: now - 2_000 } },
    { type: "message", id: "assistant-old", parentId: "user-old", timestamp: new Date(now - 1_000).toISOString(), message: assistant(now - 1_000, 200_000) },
  ];
  const notifications: string[] = [];
  const leaf = { id: "assistant-old" };
  const runtime = probe();
  const ctx = context(entries, leaf, notifications);

  await fire(runtime, "session_start", {}, ctx);
  try {
    leaf.id = "assistant-base";
    await fire(runtime, "session_tree", { newLeafId: leaf.id, oldLeafId: "assistant-old" }, ctx);
    await fire(runtime, "before_provider_request", { payload: payload(["base", "new branch"]) }, ctx);
    await fire(runtime, "before_provider_request", { payload: payload(["base", "new branch"]) }, ctx);
    assert.equal(notifications.length, 0, "branching must not price the abandoned 200k leaf");
    await fire(runtime, "message_end", {
      message: { ...assistant(now, 100_000), usage: usage(0, 90_000, 10_000) },
    });

    await fire(runtime, "before_provider_request", {
      payload: payload(["base", "new branch", "aborted suffix"]),
    }, ctx);
    await fire(runtime, "agent_end");
    await runtime.commands.get("cache")?.("", ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, /\s3\s+.*● hit/);
  } finally {
    await fire(runtime, "session_shutdown", {});
  }
});
