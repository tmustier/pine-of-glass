import { stringValue } from "../_lib/boundary.ts";
import {
  descendantsOf,
  findBranchBaseline,
  isPersistedEntry,
  type PersistedEntry,
} from "./lineage-persistence.ts";
export { findBranchBaseline, hydrateLineageResponseIds, restoreLineageSnapshots } from "./lineage-persistence.ts";
import type {
  CacheLineageSnapshot,
  CacheWindow,
  CallCause,
  RequestFingerprint,
  ResolvedCacheLineage,
} from "./types.ts";

function changed(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

function identityCause(
  baseline: CacheLineageSnapshot,
  provider: string | undefined,
  model: string | undefined,
  api: string | undefined,
): CallCause | undefined {
  const providerChanged = changed(baseline.provider, provider);
  const modelChanged = changed(baseline.model, model);
  const apiChanged = changed(baseline.api, api);
  if (!providerChanged && !modelChanged && !apiChanged) return undefined;
  const before = [baseline.provider, baseline.model].filter(Boolean).join("/") || "previous model";
  const after = [provider, model].filter(Boolean).join("/") || "current model";
  // Same provider/model over a different wire API is still a different cache.
  const detail = providerChanged || modelChanged
    ? `model switched ${before} → ${after}`
    : `model switched ${before} (${baseline.api ?? "unknown API"}) → ${after} (${api ?? "unknown API"})`;
  return { kind: "model", detail };
}

function hasCompleteIdentity(snapshot: CacheLineageSnapshot): boolean {
  return snapshot.provider !== undefined && snapshot.model !== undefined && snapshot.api !== undefined;
}

function sameIdentity(a: CacheLineageSnapshot, b: CacheLineageSnapshot): boolean {
  return hasCompleteIdentity(a) && hasCompleteIdentity(b) &&
    a.provider === b.provider && a.model === b.model && a.api === b.api;
}

function sameWindow(a: CacheWindow | undefined, b: CacheWindow | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "contract" && b.kind === "contract") return a.ttlMs === b.ttlMs;
  if (a.kind === "minimum" && b.kind === "minimum") return a.minMs === b.minMs;
  if (a.kind === "maximum" && b.kind === "maximum") return a.maxMs === b.maxMs;
  if (a.kind === "bounded" && b.kind === "bounded") return a.minMs === b.minMs && a.maxMs === b.maxMs;
  return a.kind === "unknown" && b.kind === "unknown";
}

/** Whether a compaction checkpoint sits between the baseline call and the leaf: the
 * prefix that call cached no longer exists, so nothing can revive its entry. */
export function pathContainsCompaction(
  entries: readonly unknown[],
  leafId: string | null,
  baseline: CacheLineageSnapshot,
): boolean {
  const byId = new Map<string, PersistedEntry>();
  for (const entry of entries) {
    if (isPersistedEntry(entry)) byId.set(entry.id, entry);
  }
  const stopIds = new Set(
    [baseline.responseEntryId, baseline.requestLeafId].filter((id): id is string => id !== undefined && id !== null),
  );
  let current = leafId;
  const seen = new Set<string>();
  while (current !== null && !stopIds.has(current) && !seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) return false;
    if (entry.type === "compaction") return true;
    current = stringValue(entry.parentId) ?? null;
  }
  return false;
}

/** Project a lineage resolution onto the cache clock's baseline state. */
export function cacheStateForLineage(
  resolution: ResolvedCacheLineage,
  current: { provider?: string; model?: string; api?: string },
): {
  expectedRead: number;
  lastRequestAt: number | undefined;
  lastCallModelId: string | undefined;
  lastCallProvider: string | undefined;
  lastCallApi: string | undefined;
  modelSwitched: boolean;
  window: CacheWindow;
} {
  const { baseline, refresh } = resolution;
  return {
    expectedRead: baseline?.promptTokens ?? 0,
    lastRequestAt: refresh?.requestAt,
    lastCallModelId: baseline?.model,
    lastCallProvider: baseline?.provider,
    lastCallApi: baseline?.api,
    modelSwitched: baseline !== undefined && (
      changed(baseline.provider, current.provider) ||
      changed(baseline.model, current.model) ||
      changed(baseline.api, current.api)
    ),
    window: refresh?.window ?? { kind: "unknown" },
  };
}

/**
 * Resolve the provider-known prefix for the active path and every compatible request
 * that could have refreshed it. Conversation branching is handled by ancestry; payload
 * compatibility is handled by the baseline fingerprint being a prefix of each request.
 */
export function resolveCacheLineage(args: {
  entries: readonly unknown[];
  activeLeafId: string | null;
  snapshots: readonly CacheLineageSnapshot[];
  currentProvider?: string;
  currentModel?: string;
  currentApi?: string;
  currentFingerprint?: RequestFingerprint;
  compareFingerprints: (baseline: RequestFingerprint, current: RequestFingerprint) => CallCause | undefined;
}): ResolvedCacheLineage {
  const baseline = findBranchBaseline(args.entries, args.activeLeafId, args.snapshots);
  if (!baseline) return { compatible: [] };
  let cause = identityCause(baseline, args.currentProvider, args.currentModel, args.currentApi) ??
    (baseline.fingerprint && args.currentFingerprint
      ? args.compareFingerprints(baseline.fingerprint, args.currentFingerprint)
      : undefined);
  if (
    cause?.kind === "history" &&
    pathContainsCompaction(args.entries, args.activeLeafId, baseline)
  ) {
    cause = { kind: "compaction", detail: "selected path contains a compaction checkpoint" };
  }
  if (cause) return { baseline, refresh: baseline, compatible: [], cause };
  // Missing identity is not positive switch evidence, but it cannot prove warmth or
  // descendant compatibility either. Keep the billed denominator and withhold time.
  if (!hasCompleteIdentity(baseline) || args.currentProvider === undefined ||
      args.currentModel === undefined || args.currentApi === undefined) {
    return { baseline, compatible: [] };
  }

  const descendants = baseline.responseEntryId
    ? descendantsOf(args.entries, baseline.responseEntryId)
    : new Set<string>();
  const compatible = args.snapshots.filter((candidate) => {
    if (candidate === baseline) return true;
    if (candidate.requestLeafId === null || !descendants.has(candidate.requestLeafId)) return false;
    if (!sameIdentity(baseline, candidate) || !sameWindow(baseline.window, candidate.window)) return false;
    if (!baseline.fingerprint || !candidate.fingerprint) return false;
    return args.compareFingerprints(baseline.fingerprint, candidate.fingerprint) === undefined;
  });
  const refresh = compatible.reduce<CacheLineageSnapshot | undefined>(
    (latest, candidate) => !latest || candidate.requestAt > latest.requestAt ? candidate : latest,
    undefined,
  );
  return { baseline, refresh, compatible };
}
