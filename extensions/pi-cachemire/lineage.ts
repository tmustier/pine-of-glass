import { isJsonObject } from "../_lib/boundary.ts";
import { confirmedWindow, retentionForModel } from "./retention.ts";
import type {
  CacheLineageSnapshot,
  CacheWindow,
  CallCause,
  RequestFingerprint,
  ResolvedCacheLineage,
} from "./types.ts";

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function persistedEntryAt(entry: unknown): number | undefined {
  if (!isJsonObject(entry)) return undefined;
  if (isJsonObject(entry.message)) {
    const messageAt = nonNegativeNumber(entry.message.timestamp);
    if (messageAt !== undefined) return messageAt;
  }
  const entryAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(entryAt) && entryAt >= 0 ? entryAt : undefined;
}

function billedSnapshotFromEntry(
  entry: unknown,
  entryTimes: ReadonlyMap<string, number>,
): CacheLineageSnapshot | undefined {
  if (
    !isJsonObject(entry) || entry.type !== "message" || typeof entry.id !== "string" ||
    !isJsonObject(entry.message) || entry.message.role !== "assistant" || !isJsonObject(entry.message.usage)
  ) return undefined;
  const input = nonNegativeNumber(entry.message.usage.input);
  const output = nonNegativeNumber(entry.message.usage.output);
  const cacheRead = nonNegativeNumber(entry.message.usage.cacheRead);
  const cacheWrite = nonNegativeNumber(entry.message.usage.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  const responseAt = persistedEntryAt(entry) ?? 0;
  const parentAt = typeof entry.parentId === "string" ? entryTimes.get(entry.parentId) : undefined;
  const requestAt = parentAt !== undefined && parentAt <= responseAt ? parentAt : responseAt;
  const provider = typeof entry.message.provider === "string" ? entry.message.provider : undefined;
  const model = typeof entry.message.model === "string" ? entry.message.model : undefined;
  const api = typeof entry.message.api === "string" ? entry.message.api : undefined;
  const window = confirmedWindow(
    retentionForModel(provider, model, api),
    { cacheRead, cacheWrite },
  ) ?? { kind: "unknown" };
  return {
    requestLeafId: typeof entry.parentId === "string" ? entry.parentId : null,
    responseEntryId: entry.id,
    responseAt,
    requestAt,
    promptTokens: input + cacheRead + cacheWrite,
    provider,
    model,
    api,
    window,
  };
}

function persistedEntryTimes(entries: readonly unknown[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.id !== "string") continue;
    const at = persistedEntryAt(entry);
    if (at !== undefined) times.set(entry.id, at);
  }
  return times;
}

/** Restore every normal provider call in the session tree, not only the active branch. */
export function restoreLineageSnapshots(entries: readonly unknown[]): CacheLineageSnapshot[] {
  const entryTimes = persistedEntryTimes(entries);
  return entries
    .map((entry) => billedSnapshotFromEntry(entry, entryTimes))
    .filter((snapshot): snapshot is CacheLineageSnapshot => snapshot !== undefined);
}

function responseLinkKey(snapshot: CacheLineageSnapshot): string {
  return JSON.stringify([
    snapshot.requestLeafId,
    snapshot.responseAt,
    snapshot.promptTokens,
    snapshot.provider,
    snapshot.model,
    snapshot.api,
  ]);
}

/** Link live snapshots after Pi persists their assistant response entries. */
export function hydrateLineageResponseIds(
  snapshots: CacheLineageSnapshot[],
  entries: readonly unknown[],
): void {
  const unresolved = snapshots.filter((snapshot) => snapshot.responseEntryId === undefined);
  if (unresolved.length === 0) return;
  const entryTimes = persistedEntryTimes(entries);
  const persisted = new Map(
    entries
      .map((entry) => billedSnapshotFromEntry(entry, entryTimes))
      .filter((snapshot): snapshot is CacheLineageSnapshot => snapshot !== undefined)
      .map((snapshot) => [responseLinkKey(snapshot), snapshot]),
  );
  for (const snapshot of unresolved) {
    const match = persisted.get(responseLinkKey(snapshot));
    if (match) snapshot.responseEntryId = match.responseEntryId;
  }
}

function parentIndex(entries: readonly unknown[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.id !== "string") continue;
    parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
  }
  return parents;
}

/** Nearest provider-billed request or response anchored on the active session path. */
export function findBranchBaseline(
  entries: readonly unknown[],
  activeLeafId: string | null,
  snapshots: readonly CacheLineageSnapshot[],
): CacheLineageSnapshot | undefined {
  if (activeLeafId === null) return undefined;
  const parents = parentIndex(entries);
  const reversePath: string[] = [];
  let current: string | null | undefined = activeLeafId;
  const seen = new Set<string>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    reversePath.push(current);
    current = parents.get(current);
  }
  const depth = new Map(reversePath.reverse().map((id, index) => [id, index]));
  let nearest: { snapshot: CacheLineageSnapshot; depth: number } | undefined;
  for (const snapshot of snapshots) {
    const responseDepth = snapshot.responseEntryId === undefined ? undefined : depth.get(snapshot.responseEntryId);
    const requestDepth = snapshot.requestLeafId === null ? undefined : depth.get(snapshot.requestLeafId);
    const anchorDepth = responseDepth ?? requestDepth;
    if (anchorDepth === undefined) continue;
    if (
      !nearest || anchorDepth > nearest.depth ||
      (anchorDepth === nearest.depth && snapshot.requestAt > nearest.snapshot.requestAt)
    ) nearest = { snapshot, depth: anchorDepth };
  }
  return nearest?.snapshot;
}

function descendantsOf(entries: readonly unknown[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || typeof entry.parentId !== "string") continue;
    children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry.id]);
  }
  const descendants = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (descendants.has(current)) continue;
    descendants.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  return descendants;
}

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
  return a.kind === "unknown" && b.kind === "unknown";
}

/** Whether a compaction checkpoint sits between the baseline call and the leaf: the
 * prefix that call cached no longer exists, so nothing can revive its entry. */
export function pathContainsCompaction(
  entries: readonly unknown[],
  leafId: string | null,
  baseline: CacheLineageSnapshot,
): boolean {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (isJsonObject(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
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
    current = typeof entry.parentId === "string" ? entry.parentId : null;
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
