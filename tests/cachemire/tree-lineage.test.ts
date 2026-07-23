import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piCachemire, { internals } from "../../extensions/pi-cachemire/index.ts";

const { activeLineageCause, branchLineageBaseline, diffFingerprints, fingerprintPayload, latestBranchRefreshAt } = internals;

type Handler = (...args: unknown[]) => unknown;

function extensionProbe(): { handlers: Map<string, Handler[]>; commands: Map<string, Handler> } {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: Handler }): void {
      commands.set(name, options.handler);
    },
    getThinkingLevel(): string {
      return "off";
    },
  } as unknown as ExtensionAPI;
  piCachemire(pi);
  return { handlers, commands };
}

async function fire(probe: ReturnType<typeof extensionProbe>, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of probe.handlers.get(event) ?? []) await handler(...args);
}

function usage(input: number, cacheRead: number, cacheWrite: number, output = 10) {
  return {
    input,
    output,
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
    model: "claude-opus-4-8",
    stopReason: "stop",
    timestamp,
    usage: usage(2, prompt - 2, 0),
  };
}

function payload(messages: string[]) {
  return {
    model: "claude-opus-4-8",
    system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
    messages: messages.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
  };
}

function context(entries: unknown[], leafId: string, notifications: string[]) {
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
      reasoning: false,
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    },
    sessionManager: {
      getEntries: () => entries,
      getLeafId: () => leafId,
    },
  };
}

test("branch baseline uses the selected path's last provider-billed prompt", () => {
  const baseline = branchLineageBaseline([
    assistant(1_000, 177_860),
    { role: "assistant", timestamp: 2_000, usage: usage(0, 0, 0, 0) },
  ])!;
  assert.deepEqual(baseline, { promptTokens: 177_860, at: 1_000 });

  // Observed rewind: the next request reused 177,858 and processed only 1,408
  // uncached, rather than breaking the abandoned leaf's 179,294-token prompt.
  assert.equal(177_858 / baseline.promptTokens > 0.99, true);
  assert.equal(2 + 1_406, 1_408);
  assert.equal(branchLineageBaseline([{ role: "user", content: "root" }]), undefined);
});

test("branch freshness follows calls that actually contain the selected prefix", () => {
  const entries = [
    { type: "message", id: "root", parentId: null, message: assistant(1_000, 80_000) },
    { type: "message", id: "left-user", parentId: "root", message: { role: "user", content: "left" } },
    { type: "message", id: "left", parentId: "left-user", message: assistant(10_000, 100_000) },
    { type: "message", id: "right-user", parentId: "root", message: { role: "user", content: "right" } },
    { type: "message", id: "right", parentId: "right-user", message: assistant(20_000, 120_000) },
  ];
  assert.equal(latestBranchRefreshAt(entries, "left-user"), 10_000, "a sibling call cannot refresh this branch");
  assert.equal(latestBranchRefreshAt(entries, "root"), 20_000, "both siblings refresh their common prefix");
  assert.equal(latestBranchRefreshAt(entries, null), undefined);
});

test("tree navigation suppresses only the intentional history divergence", () => {
  const oldBranch = fingerprintPayload(payload(["base", "old branch"]));
  const newBranch = fingerprintPayload(payload(["base", "new branch"]));
  assert.equal(activeLineageCause(oldBranch, newBranch, true, diffFingerprints), undefined);
  assert.equal(activeLineageCause(oldBranch, newBranch, false, diffFingerprints)?.kind, "history");

  const changedSystem = fingerprintPayload({ ...payload(["base", "new branch"]), system: "changed" });
  assert.equal(activeLineageCause(oldBranch, changedSystem, true, diffFingerprints)?.kind, "system");
});

test("session_tree rebases classification to the selected branch", async () => {
  const now = Date.now();
  const baseAssistant = assistant(now - 3_000, 100_000);
  const oldAssistant = assistant(now - 1_000, 200_000);
  const entries = [
    { type: "message", id: "user-base", parentId: null, timestamp: new Date(now - 4_000).toISOString(), message: { role: "user", content: "base", timestamp: now - 4_000 } },
    { type: "message", id: "assistant-base", parentId: "user-base", timestamp: new Date(now - 3_000).toISOString(), message: baseAssistant },
    { type: "message", id: "user-old", parentId: "assistant-base", timestamp: new Date(now - 2_000).toISOString(), message: { role: "user", content: "old branch", timestamp: now - 2_000 } },
    { type: "message", id: "assistant-old", parentId: "user-old", timestamp: new Date(now - 1_000).toISOString(), message: oldAssistant },
  ];
  const notifications: string[] = [];
  const probe = extensionProbe();
  const ctx = context(entries, "assistant-old", notifications);

  await fire(probe, "session_start", {}, ctx);
  try {
    // Establish a live fingerprint and the abandoned leaf's 200k prompt baseline.
    await fire(probe, "before_provider_request", { payload: payload(["base", "old branch"]) });
    await fire(probe, "message_end", { message: { ...oldAssistant, usage: usage(0, 200_000, 0) } });

    // Rewind to the 100k selected-branch baseline. A 90k read is a hit against this
    // branch, but would be misclassified as a 45% partial against the abandoned 200k leaf.
    await fire(probe, "session_tree", { newLeafId: "assistant-base", oldLeafId: "assistant-old" }, ctx);
    await fire(probe, "before_provider_request", { payload: payload(["base", "new branch"]) });
    assert.equal(notifications.length, 0, "intentional branch divergence must not emit a full-prefix warning");
    await fire(probe, "message_end", { message: { ...baseAssistant, usage: usage(0, 90_000, 10_000) } });

    await probe.commands.get("cache")?.("", ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, /\s4\s+.*● hit/);
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});
