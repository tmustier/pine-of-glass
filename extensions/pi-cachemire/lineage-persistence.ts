import { isJsonObject, nonNegativeNumberValue, stringValue, type JsonFields } from "../_lib/boundary.ts";
import { confirmedWindow, retentionForModel } from "./retention.ts";
import type { CacheLineageSnapshot, RequestFingerprint } from "./types.ts";

export type PersistedEntry = JsonFields & { id: string };

export function isPersistedEntry(entry: unknown): entry is PersistedEntry {
  return isJsonObject(entry) && typeof entry.id === "string";
}

function persistedEntryAt(entry: PersistedEntry): number | undefined {
  if (isJsonObject(entry.message)) {
    const messageAt = nonNegativeNumberValue(entry.message.timestamp);
    if (messageAt !== undefined) return messageAt;
  }
  const timestamp = stringValue(entry.timestamp);
  const entryAt = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return Number.isFinite(entryAt) && entryAt >= 0 ? entryAt : undefined;
}

function billedSnapshotFromEntry(
  entry: PersistedEntry,
  entryTimes: ReadonlyMap<string, number>,
  entriesById: ReadonlyMap<string, PersistedEntry>,
): CacheLineageSnapshot | undefined {
  if (
    entry.type !== "message" ||
    !isJsonObject(entry.message) || entry.message.role !== "assistant" || !isJsonObject(entry.message.usage)
  ) return undefined;
  const input = nonNegativeNumberValue(entry.message.usage.input);
  const output = nonNegativeNumberValue(entry.message.usage.output);
  const cacheRead = nonNegativeNumberValue(entry.message.usage.cacheRead);
  const cacheWrite = nonNegativeNumberValue(entry.message.usage.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  const responseAt = persistedEntryAt(entry) ?? 0;
  let parentId = stringValue(entry.parentId);
  const seen = new Set<string>();
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = entriesById.get(parentId);
    if (parent?.type !== "usage") break;
    parentId = stringValue(parent.parentId);
  }
  const parentAt = parentId === undefined ? undefined : entryTimes.get(parentId);
  const requestAt = parentAt !== undefined && parentAt <= responseAt ? parentAt : responseAt;
  const provider = stringValue(entry.message.provider);
  const model = stringValue(entry.message.model);
  const api = stringValue(entry.message.api);
  const window = confirmedWindow(
    retentionForModel(provider, model, api),
    { cacheRead, cacheWrite },
  ) ?? { kind: "unknown" };
  return {
    requestLeafId: parentId ?? null,
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
    if (!isPersistedEntry(entry)) continue;
    const at = persistedEntryAt(entry);
    if (at !== undefined) times.set(entry.id, at);
  }
  return times;
}

function warmSnapshotFromEntry(
  entry: PersistedEntry,
  entries: readonly unknown[],
  snapshots: readonly CacheLineageSnapshot[],
): CacheLineageSnapshot | undefined {
  if (entry.type !== "usage" || entry.kind !== "cache_warm" || !isJsonObject(entry.usage)) return undefined;
  const input = nonNegativeNumberValue(entry.usage.input);
  const cacheRead = nonNegativeNumberValue(entry.usage.cacheRead);
  const cacheWrite = nonNegativeNumberValue(entry.usage.cacheWrite);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const provider = stringValue(entry.provider);
  const model = stringValue(entry.model);
  const parentId = stringValue(entry.parentId);
  const childAssistant = entries.find((candidate) =>
    isPersistedEntry(candidate) && stringValue(candidate.parentId) === entry.id &&
    candidate.type === "message" && isJsonObject(candidate.message) && candidate.message.role === "assistant"
  );
  const childId = isPersistedEntry(childAssistant) ? childAssistant.id : undefined;
  const source = childId === undefined
    ? findBranchBaseline(entries, parentId ?? null, snapshots)
    : snapshots.find((snapshot) => snapshot.responseEntryId === childId);
  const sameModel = source !== undefined && source.provider === provider && source.model === model;
  const api = sameModel ? source.api : undefined;
  const usage = { input, cacheRead, cacheWrite };
  const window = sameModel
    ? source.window
    : confirmedWindow(retentionForModel(provider, model, api), usage) ?? { kind: "unknown" };
  const at = persistedEntryAt(entry) ?? 0;
  return {
    requestLeafId: childId ?? parentId ?? null,
    responseEntryId: entry.id,
    responseAt: at,
    requestAt: at,
    promptTokens: input + cacheRead + cacheWrite,
    provider,
    model,
    api,
    fingerprint: sameModel ? source.fingerprint : undefined,
    window,
  };
}

function billedSnapshots(entries: readonly unknown[]): CacheLineageSnapshot[] {
  const entryTimes = persistedEntryTimes(entries);
  const entriesById = new Map<string, PersistedEntry>();
  for (const entry of entries) {
    if (isPersistedEntry(entry)) entriesById.set(entry.id, entry);
  }
  const snapshots: CacheLineageSnapshot[] = [];
  for (const entry of entries) {
    if (!isPersistedEntry(entry)) continue;
    const snapshot = billedSnapshotFromEntry(entry, entryTimes, entriesById);
    if (snapshot) snapshots.push(snapshot);
  }
  for (const entry of entries) {
    if (!isPersistedEntry(entry)) continue;
    const snapshot = warmSnapshotFromEntry(entry, entries, snapshots);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

/** Restore every normal provider call in the session tree, not only the active branch. */
export function restoreLineageSnapshots(
  entries: readonly unknown[],
  previousSnapshots?: CacheLineageSnapshot[],
): CacheLineageSnapshot[] {
  const restored = billedSnapshots(entries);
  if (!previousSnapshots) return restored;
  const fingerprints = new Map<string, RequestFingerprint>();
  for (const snapshot of previousSnapshots) {
    if (snapshot.responseEntryId && snapshot.fingerprint) {
      fingerprints.set(snapshot.responseEntryId, snapshot.fingerprint);
    }
  }
  for (const snapshot of restored) {
    if (snapshot.responseEntryId) snapshot.fingerprint = fingerprints.get(snapshot.responseEntryId);
  }
  return restored;
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
  const persisted = new Map(
    billedSnapshots(entries).map((snapshot) => [responseLinkKey(snapshot), snapshot]),
  );
  for (const snapshot of unresolved) {
    const match = persisted.get(responseLinkKey(snapshot));
    if (match) snapshot.responseEntryId = match.responseEntryId;
  }
}

function parentIndex(entries: readonly unknown[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const entry of entries) {
    if (!isPersistedEntry(entry)) continue;
    parents.set(entry.id, stringValue(entry.parentId) ?? null);
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
    const anchorDepth = responseDepth === undefined
      ? requestDepth
      : requestDepth === undefined ? responseDepth : Math.max(responseDepth, requestDepth);
    if (anchorDepth === undefined) continue;
    if (
      !nearest || anchorDepth > nearest.depth ||
      (anchorDepth === nearest.depth && snapshot.requestAt > nearest.snapshot.requestAt)
    ) nearest = { snapshot, depth: anchorDepth };
  }
  return nearest?.snapshot;
}

export function descendantsOf(entries: readonly unknown[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isPersistedEntry(entry)) continue;
    const parentId = stringValue(entry.parentId);
    if (parentId === undefined) continue;
    children.set(parentId, [...(children.get(parentId) ?? []), entry.id]);
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
