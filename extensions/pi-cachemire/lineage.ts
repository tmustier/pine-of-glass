import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findBranchBaseline } from "./lineage-persistence.ts";
export { findBranchBaseline, hydrateLineageResponseIds, requestLeafFor, restoreLineageSnapshots } from "./lineage-persistence.ts";
import type { CacheBaseline } from "./ledger.ts";
import type {
  CacheLineageSnapshot,
  CallCause,
  RequestFingerprint,
  ResolvedCacheLineage,
} from "./types.ts";

/** When a billed call last refreshed its cache entry; restored calls lack a response start. */
export function cacheRefreshedAt(snapshot: CacheLineageSnapshot): number {
  return snapshot.responseStartAt ?? snapshot.requestAt;
}

function changed(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

/** Whether a compaction checkpoint sits between the baseline call and the leaf: the
 * prefix that call cached no longer exists, so nothing can revive its entry. */
export function pathContainsCompaction(
  entries: readonly SessionEntry[],
  leafId: string | null,
  baseline: CacheLineageSnapshot,
): boolean {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const stopIds = new Set([baseline.responseEntryId, baseline.requestLeafId]);
  let current = leafId;
  while (current !== null && !stopIds.has(current)) {
    const entry = byId.get(current);
    if (!entry) return false;
    if (entry.type === "compaction") return true;
    current = entry.parentId;
  }
  return false;
}

/** The cache baseline a lineage resolution implies. */
export function baselineForLineage(
  resolution: ResolvedCacheLineage,
): Pick<CacheBaseline, "expectedRead" | "refreshedAt" | "window" | "billedBy"> {
  const { baseline, refresh } = resolution;
  return {
    expectedRead: baseline?.promptTokens ?? 0,
    refreshedAt: refresh && cacheRefreshedAt(refresh),
    window: refresh?.window ?? { kind: "unknown" },
    billedBy: baseline && { provider: baseline.provider, model: baseline.model, api: baseline.api },
  };
}

/**
 * Resolve the provider-known prefix for the active path and every compatible request
 * that could have refreshed it. Conversation branching is handled by ancestry; payload
 * compatibility is handled by the baseline fingerprint being a prefix of each request.
 */
export function resolveCacheLineage(args: {
  entries: readonly SessionEntry[];
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
  const providerChanged = changed(baseline.provider, args.currentProvider);
  const modelChanged = changed(baseline.model, args.currentModel);
  const apiChanged = changed(baseline.api, args.currentApi);
  let cause: CallCause | undefined;
  if (providerChanged || modelChanged || apiChanged) {
    const before = [baseline.provider, baseline.model].filter(Boolean).join("/") || "previous model";
    const after = [args.currentProvider, args.currentModel].filter(Boolean).join("/") || "current model";
    cause = {
      kind: "model",
      detail: providerChanged || modelChanged
        ? `model switched ${before} → ${after}`
        : `model switched ${before} (${baseline.api ?? "unknown API"}) → ${after} (${args.currentApi ?? "unknown API"})`,
    };
  } else if (baseline.fingerprint && args.currentFingerprint) {
    cause = args.compareFingerprints(baseline.fingerprint, args.currentFingerprint);
  }
  if (
    cause?.kind === "history" &&
    pathContainsCompaction(args.entries, args.activeLeafId, baseline)
  ) {
    cause = { kind: "compaction", detail: "selected path contains a compaction checkpoint" };
  }
  if (cause) return { baseline, refresh: baseline, compatible: [], cause };
  // Missing identity is not positive switch evidence, but it cannot prove warmth or
  // descendant compatibility either. Keep the billed denominator and withhold time.
  if (baseline.provider === undefined || baseline.model === undefined || baseline.api === undefined ||
      args.currentProvider === undefined || args.currentModel === undefined || args.currentApi === undefined) {
    return { baseline, compatible: [] };
  }

  const children = new Map<string, string[]>();
  for (const entry of args.entries) {
    if (entry.parentId === null) continue;
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry.id);
    children.set(entry.parentId, siblings);
  }
  const descendants = new Set<string>();
  const pending = baseline.responseEntryId ? [baseline.responseEntryId] : [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    descendants.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  const compatible = args.snapshots.filter((candidate) => {
    if (candidate === baseline) return true;
    if (candidate.requestLeafId === null || !descendants.has(candidate.requestLeafId)) return false;
    if (candidate.provider !== baseline.provider || candidate.model !== baseline.model || candidate.api !== baseline.api) {
      return false;
    }
    const baselineWindow = baseline.window;
    const candidateWindow = candidate.window;
    if (!baselineWindow || !candidateWindow || baselineWindow.kind !== candidateWindow.kind) return false;
    switch (baselineWindow.kind) {
      case "contract":
        if (candidateWindow.kind !== "contract" || baselineWindow.ttlMs !== candidateWindow.ttlMs) return false;
        break;
      case "minimum":
        if (candidateWindow.kind !== "minimum" || baselineWindow.minMs !== candidateWindow.minMs) return false;
        break;
      case "maximum":
        if (candidateWindow.kind !== "maximum" || baselineWindow.maxMs !== candidateWindow.maxMs) return false;
        break;
      case "bounded":
        if (candidateWindow.kind !== "bounded" || baselineWindow.minMs !== candidateWindow.minMs ||
            baselineWindow.maxMs !== candidateWindow.maxMs) return false;
        break;
    }
    if (!baseline.fingerprint || !candidate.fingerprint) return false;
    return args.compareFingerprints(baseline.fingerprint, candidate.fingerprint) === undefined;
  });
  const refresh = compatible.reduce<CacheLineageSnapshot | undefined>(
    (latest, candidate) => !latest || candidate.requestAt > latest.requestAt ? candidate : latest,
    undefined,
  );
  return { baseline, refresh, compatible };
}
