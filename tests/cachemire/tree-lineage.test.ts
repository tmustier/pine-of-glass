import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piCachemire, { internals } from "../../extensions/pi-cachemire/index.ts";
import { cacheStateForLineage } from "../../extensions/pi-cachemire/lineage.ts";
import type { CacheLineageSnapshot } from "../../extensions/pi-cachemire/types.ts";

const {
  diffFingerprints,
  findBranchBaseline,
  fingerprintPayload,
  hydrateLineageResponseIds,
  predictBreak,
  resolveCacheLineage,
  restoreLineageSnapshots,
} = internals;

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

function assistant(timestamp: number, prompt: number, model = "claude-opus-4-8") {
  return {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    provider: "anthropic",
    api: "anthropic-messages",
    model,
    stopReason: "stop",
    timestamp,
    usage: usage(2, prompt - 2, 0),
  };
}

function payload(
  messages: string[],
  options: { model?: string; system?: string; tools?: unknown[]; thinkingBudget?: number } = {},
) {
  return {
    model: options.model ?? "claude-opus-4-8",
    system: [{ type: "text", text: options.system ?? "fixture", cache_control: { type: "ephemeral" } }],
    messages: messages.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.thinkingBudget ? { thinking: { type: "enabled", budget_tokens: options.thinkingBudget } } : {}),
  };
}

function snapshotById(snapshots: CacheLineageSnapshot[], id: string): CacheLineageSnapshot {
  return snapshots.find((snapshot) => snapshot.responseEntryId === id)!;
}

function branchedEntries(now = 30_000) {
  return [
    { type: "message", id: "root-user", parentId: null, message: { role: "user", content: "root", timestamp: 500 } },
    { type: "message", id: "root", parentId: "root-user", message: assistant(1_000, 80_000) },
    { type: "message", id: "left-user", parentId: "root", message: { role: "user", content: "left", timestamp: 2_000 } },
    { type: "message", id: "left", parentId: "left-user", message: assistant(3_000, 100_000) },
    { type: "message", id: "left-next-user", parentId: "left", message: { role: "user", content: "left next", timestamp: 4_000 } },
    { type: "message", id: "left-next", parentId: "left-next-user", message: assistant(now, 110_000) },
    { type: "message", id: "right-user", parentId: "root", message: { role: "user", content: "right", timestamp: 5_000 } },
    { type: "message", id: "right", parentId: "right-user", message: assistant(20_000, 120_000) },
  ];
}

function resolve(
  entries: unknown[],
  snapshots: CacheLineageSnapshot[],
  leaf: string,
  current: ReturnType<typeof fingerprintPayload>,
  model = "claude-opus-4-8",
) {
  return resolveCacheLineage({
    entries,
    activeLeafId: leaf,
    snapshots,
    currentProvider: "anthropic",
    currentModel: model,
    currentApi: "anthropic-messages",
    currentFingerprint: current,
    compareFingerprints: diffFingerprints,
  });
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
  };
}

test("restores every branch while selecting only the active path baseline", () => {
  const entries = branchedEntries();
  const snapshots = restoreLineageSnapshots(entries);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.responseEntryId), ["root", "left", "left-next", "right"]);
  assert.equal(findBranchBaseline(entries, "left", snapshots)?.promptTokens, 100_000);
  assert.equal(findBranchBaseline(entries, "right", snapshots)?.promptTokens, 120_000);
  assert.equal(
    findBranchBaseline(entries, "left-user", snapshots)?.promptTokens,
    100_000,
    "a replay can reuse the prior provider call made from that exact request leaf",
  );
  assert.equal(findBranchBaseline(entries, null, snapshots), undefined);
  const restoredResolution = resolve(entries, snapshots, "left", fingerprintPayload(payload(["root", "left"])));
  assert.equal(restoredResolution.refresh?.responseEntryId, "left", "restored descendants lack compatibility proof");
});

test("links a live request snapshot after Pi persists its assistant response", () => {
  const entries = branchedEntries();
  const persisted = restoreLineageSnapshots(entries)[0]!;
  const live = { ...persisted, responseEntryId: undefined, fingerprint: fingerprintPayload(payload(["root"])) };
  hydrateLineageResponseIds([live], entries);
  assert.equal(live.responseEntryId, "root");
  assert.ok(live.fingerprint);
});

test("returning to a warm branch uses its compatible descendants, not a sibling", () => {
  const entries = branchedEntries(30_000);
  const snapshots = restoreLineageSnapshots(entries);
  const root = snapshotById(snapshots, "root");
  const left = snapshotById(snapshots, "left");
  const leftNext = snapshotById(snapshots, "left-next");
  const right = snapshotById(snapshots, "right");
  root.fingerprint = fingerprintPayload(payload(["root"]));
  left.fingerprint = fingerprintPayload(payload(["root", "left"]));
  leftNext.fingerprint = fingerprintPayload(payload(["root", "left", "left next"]));
  right.fingerprint = fingerprintPayload(payload(["root", "right"]));

  const resolution = resolve(entries, snapshots, "left", fingerprintPayload(payload(["root", "left", "continued"])));
  assert.equal(resolution.baseline, left);
  assert.equal(resolution.refresh, leftNext);
  assert.deepEqual(resolution.compatible, [left, leftNext]);
  assert.equal(resolution.cause, undefined);
});

test("an unknown restored API withholds refresh proof without inventing a model switch", () => {
  const entries = branchedEntries();
  const snapshots = restoreLineageSnapshots(entries);
  const left = snapshotById(snapshots, "left");
  left.api = undefined;
  left.fingerprint = fingerprintPayload(payload(["root", "left"]));
  const resolution = resolve(entries, snapshots, "left", fingerprintPayload(payload(["root", "left"])));
  assert.equal(resolution.cause, undefined, "missing history is not positive switch evidence");
  assert.deepEqual(resolution.compatible, [], "unknown identity cannot prove a warm entry or compatible descendants");
  const cacheState = cacheStateForLineage(
    resolution,
    { provider: "anthropic", model: "claude-opus-4-8", api: "anthropic-messages" },
  );
  assert.equal(cacheState.modelSwitched, false);
  assert.equal(cacheState.lastRequestAt, undefined, "unknown identity cannot restore a freshness clock");
});

test("incompatible descendants cannot refresh the selected lineage", () => {
  const entries = branchedEntries(40_000);
  const tool = { name: "read", input_schema: { type: "object" } };
  const baseOptions = { tools: [tool], thinkingBudget: 8_192 };
  const variants = [
    { ...baseOptions, system: "changed" },
    { ...baseOptions, tools: [{ ...tool, description: "changed" }] },
    { ...baseOptions, thinkingBudget: 16_384 },
    { ...baseOptions, model: "claude-fable-5" },
  ];
  for (const options of variants) {
    const snapshots = restoreLineageSnapshots(entries);
    const left = snapshotById(snapshots, "left");
    const leftNext = snapshotById(snapshots, "left-next");
    left.fingerprint = fingerprintPayload(payload(["root", "left"], baseOptions));
    leftNext.fingerprint = fingerprintPayload(payload(["root", "left", "left next"], options));
    const current = fingerprintPayload(payload(["root", "left", "continued"], baseOptions));
    const resolution = resolve(entries, snapshots, "left", current);
    assert.equal(resolution.refresh, left);
    assert.deepEqual(resolution.compatible, [left]);
  }
  for (const mutate of [
    (snapshot: CacheLineageSnapshot) => { snapshot.provider = "openai"; },
    (snapshot: CacheLineageSnapshot) => { snapshot.api = undefined; },
    (snapshot: CacheLineageSnapshot) => { snapshot.window = { kind: "contract", ttlMs: 60 * 60_000, source: "observed" }; },
  ]) {
    const snapshots = restoreLineageSnapshots(entries);
    const left = snapshotById(snapshots, "left");
    const leftNext = snapshotById(snapshots, "left-next");
    left.fingerprint = fingerprintPayload(payload(["root", "left"], baseOptions));
    leftNext.fingerprint = fingerprintPayload(payload(["root", "left", "left next"], baseOptions));
    mutate(leftNext);
    const resolution = resolve(entries, snapshots, "left", fingerprintPayload(payload(["root", "left"], baseOptions)));
    assert.deepEqual(resolution.compatible, [left]);
  }
});

test("suffix divergence is natural, while edited history and model changes still break", () => {
  const entries = branchedEntries();
  const snapshots = restoreLineageSnapshots(entries);
  const left = snapshotById(snapshots, "left");
  left.fingerprint = fingerprintPayload(payload(["root", "left"]));

  const suffix = resolve(entries, snapshots, "left", fingerprintPayload(payload(["root", "left", "new suffix"])));
  assert.equal(suffix.cause, undefined);
  const edited = resolve(entries, snapshots, "left", fingerprintPayload(payload(["root", "edited"])));
  assert.equal(edited.cause?.kind, "history");
  const switched = resolve(
    entries,
    snapshots,
    "left",
    fingerprintPayload(payload(["root", "left"], { model: "claude-fable-5" })),
    "claude-fable-5",
  );
  assert.equal(switched.cause?.kind, "model");
});

test("a selected compaction checkpoint stays unsized before provider usage", () => {
  const entries = [
    ...branchedEntries(),
    { type: "compaction", id: "compact", parentId: "left", summary: "short summary", timestamp: new Date().toISOString() },
  ];
  const snapshots = restoreLineageSnapshots(entries);
  const left = snapshotById(snapshots, "left");
  left.fingerprint = fingerprintPayload(payload(["root", "left"]));
  const resolution = resolve(entries, snapshots, "compact", fingerprintPayload(payload(["summary"])));
  assert.equal(resolution.cause?.kind, "compaction");
  const prediction = predictBreak({
    isFirst: false,
    inCompaction: false,
    compacted: false,
    expectedRead: resolution.baseline!.promptTokens,
    fingerprintCause: resolution.cause,
  });
  assert.equal(prediction?.expectedRewriteTokens, undefined);
});

test("lineage-local freshness drives TTL prediction", () => {
  const now = 10 * 60_000;
  const entries = branchedEntries(now - 6 * 60_000);
  const snapshots = restoreLineageSnapshots(entries);
  const left = snapshotById(snapshots, "left");
  const leftNext = snapshotById(snapshots, "left-next");
  left.fingerprint = fingerprintPayload(payload(["root", "left"]));
  leftNext.fingerprint = fingerprintPayload(payload(["root", "left", "left next"]));
  const resolution = resolve(entries, snapshots, "left", fingerprintPayload(payload(["root", "left", "continued"])));
  const prediction = predictBreak({
    isFirst: false,
    inCompaction: false,
    compacted: false,
    gapMs: now - resolution.refresh!.requestAt,
    window: resolution.refresh!.window,
    expectedRead: resolution.baseline!.promptTokens,
  });
  assert.equal(prediction?.cause.kind, "ttl");
  assert.equal(prediction?.expectedRewriteTokens, 100_000);
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
  const probe = extensionProbe();
  const ctx = context(entries, leaf, notifications);

  await fire(probe, "session_start", {}, ctx);
  try {
    leaf.id = "assistant-base";
    await fire(probe, "session_tree", { newLeafId: leaf.id, oldLeafId: "assistant-old" }, ctx);
    await fire(probe, "before_provider_request", { payload: payload(["base", "new branch"]) }, ctx);
    await fire(probe, "before_provider_request", { payload: payload(["base", "new branch"]) }, ctx);
    assert.equal(notifications.length, 0, "branching must not price the abandoned 200k leaf");
    await fire(probe, "message_end", { message: { ...assistant(now, 100_000), usage: usage(0, 90_000, 10_000) } });

    await fire(probe, "before_provider_request", { payload: payload(["base", "new branch", "aborted suffix"]) }, ctx);
    await fire(probe, "agent_end");
    await probe.commands.get("cache")?.("", ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0]!, /\s3\s+.*● hit/);
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});
