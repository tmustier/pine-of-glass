import assert from "node:assert/strict";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { UNKNOWN_WINDOW } from "./clock.ts";
import { bookCall, type CacheBaseline } from "./ledger.ts";
import { hydrateLineageResponseIds, restoreLineageSnapshots, sessionEntryAt } from "./lineage-persistence.ts";
import { hasBilledUsage } from "../_lib/usage.ts";
import type { CacheLineageSnapshot, CallRecord } from "./types.ts";

type CacheWarmUsageEntry = Extract<SessionEntry, { type: "usage" }>;

export interface WarmSyncState {
  records: CallRecord[];
  lineages: CacheLineageSnapshot[];
  seenWarmEntryIds: Set<string>;
  baseline: CacheBaseline;
}

export function isWarmUsageEntry(entry: SessionEntry): entry is CacheWarmUsageEntry {
  return entry.type === "usage" && entry.kind === "cache_warm";
}

export function syncWarmEntries(state: WarmSyncState, sessionManager: ExtensionContext["sessionManager"]): void {
  const unseen = sessionManager.getBranch().filter(
    (entry): entry is CacheWarmUsageEntry => isWarmUsageEntry(entry) && !state.seenWarmEntryIds.has(entry.id),
  );
  if (unseen.length === 0) return;

  const entries = sessionManager.getEntries();
  hydrateLineageResponseIds(state.lineages, entries);
  state.lineages = restoreLineageSnapshots(entries, state.lineages);

  for (const entry of unseen) {
    state.seenWarmEntryIds.add(entry.id);
    const { usage } = entry;
    if (!hasBilledUsage(usage)) continue;
    const at = sessionEntryAt(entry);
    const lineage = state.lineages.find((snapshot) => snapshot.responseEntryId === entry.id);
    assert(lineage, `missing cache-warm lineage for ${entry.id}`);
    const booked = bookCall(state.records, state.baseline, {
      requestAt: at,
      at,
      refreshedAt: at,
      usage,
      route: { provider: entry.provider, model: entry.model, api: lineage.api },
      window: lineage.window ?? UNKNOWN_WINDOW,
      // A warm request replays the baseline request, whose prefix no compaction can change.
      compacted: false,
      uncachedUsd: usage.cost.total,
      warm: true,
    });
    state.records.push(booked.record);
    state.baseline = booked.baseline;
  }
}
