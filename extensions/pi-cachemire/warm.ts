import assert from "node:assert/strict";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { classifyCall } from "./classify.ts";
import { hydrateLineageResponseIds, restoreLineageSnapshots, sessionEntryAt } from "./lineage-persistence.ts";
import type { CacheLineageSnapshot, CacheWindow, CallRecord } from "./types.ts";

type CacheWarmUsageEntry = Extract<SessionEntry, { type: "usage" }>;

export interface WarmSyncState {
  records: CallRecord[];
  lineages: CacheLineageSnapshot[];
  seenWarmEntryIds: Set<string>;
  prevCallRequestAt?: number;
  lastRequestAt?: number;
  window: CacheWindow;
  lastCallModelId?: string;
  lastCallProvider?: string;
  lastCallApi?: string;
  modelSwitched: boolean;
  expectedRead: number;
  compacted: boolean;
  inCompaction: boolean;
}

export function isWarmUsageEntry(entry: SessionEntry): entry is CacheWarmUsageEntry {
  return entry.type === "usage" && entry.kind === "cache_warm";
}

export function syncWarmEntries(
  state: WarmSyncState,
  ctx: Pick<ExtensionContext, "model" | "sessionManager">,
): void {
  const branch = ctx.sessionManager.getBranch();
  const unseen = branch.filter(
    (entry): entry is CacheWarmUsageEntry => isWarmUsageEntry(entry) && !state.seenWarmEntryIds.has(entry.id),
  );
  if (unseen.length === 0) return;

  const entries = ctx.sessionManager.getEntries();
  hydrateLineageResponseIds(state.lineages, entries);
  state.lineages = restoreLineageSnapshots(entries, state.lineages);

  for (const entry of unseen) {
    state.seenWarmEntryIds.add(entry.id);
    const { usage } = entry;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) continue;
    const requestAt = sessionEntryAt(entry);
    const lineage = state.lineages.find((snapshot) => snapshot.responseEntryId === entry.id);
    assert(lineage, `missing cache-warm lineage for ${entry.id}`);
    const gapMs = state.prevCallRequestAt === undefined ? undefined : requestAt - state.prevCallRequestAt;
    const switched = state.lastCallModelId !== undefined && (
      entry.model !== state.lastCallModelId ||
      (state.lastCallProvider !== undefined && entry.provider !== state.lastCallProvider)
    );
    const classification = classifyCall({
      isFirst: state.records.length === 0,
      gapMs,
      window: state.window,
      usage,
      expectedRead: state.expectedRead,
      modelSwitched: switched,
      compacted: state.compacted,
      inCompaction: state.inCompaction,
    });
    state.records.push({
      index: state.records.length + 1,
      at: requestAt,
      requestAt,
      gapMs,
      usage,
      expectedRead: state.expectedRead,
      classification,
      rewroteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : usage.input,
      switched: switched ? true : undefined,
      costUsd: usage.cost.total,
      uncachedUsd: usage.cost.total,
      warm: true,
    });
    state.expectedRead = lineage.promptTokens;
    state.prevCallRequestAt = requestAt;
    state.lastRequestAt = Math.max(state.lastRequestAt ?? 0, requestAt);
    state.window = lineage.window ?? { kind: "unknown" };
    state.lastCallModelId = entry.model;
    state.lastCallProvider = entry.provider;
    state.lastCallApi = lineage.api;
    state.modelSwitched = ctx.model !== undefined && (
      ctx.model.provider !== entry.provider || ctx.model.id !== entry.model ||
      (lineage.api !== undefined && ctx.model.api !== lineage.api)
    );
  }
}
