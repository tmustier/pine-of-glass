import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { confirmedWindow, retentionForModel } from "./retention.ts";
import type { CacheLineageSnapshot } from "./types.ts";

export function sessionEntryAt(entry: SessionEntry): number {
  const at = entry.type === "message" && typeof entry.message.timestamp === "number"
    ? entry.message.timestamp
    : Date.parse(entry.timestamp);
  assert(Number.isFinite(at), `invalid session timestamp for ${entry.id}`);
  return at;
}

export function requestLeafFor(
  entriesById: ReadonlyMap<string, SessionEntry>,
  leafId: string | null,
): string | null {
  let current = leafId;
  while (current !== null) {
    const entry = entriesById.get(current);
    if (entry?.type !== "usage") break;
    current = entry.parentId;
  }
  return current;
}

function snapshotsFromEntries(
  entries: readonly SessionEntry[],
  previousByResponse = new Map<string, CacheLineageSnapshot>(),
): CacheLineageSnapshot[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const entryTimes = new Map(entries.map((entry) => [entry.id, sessionEntryAt(entry)]));
  const assistantChildren = new Map<string, string>();
  const snapshots: CacheLineageSnapshot[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.parentId !== null) assistantChildren.set(entry.parentId, entry.id);
    const { usage } = entry.message;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) continue;
    const parentId = requestLeafFor(entriesById, entry.parentId);
    const responseAt = sessionEntryAt(entry);
    const requestAt = parentId === null ? responseAt : entryTimes.get(parentId) ?? responseAt;
    const { provider, model, api } = entry.message;
    const previous = previousByResponse.get(entry.id);
    snapshots.push({
      requestLeafId: parentId,
      responseEntryId: entry.id,
      responseAt,
      requestAt,
      promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      provider,
      model,
      api,
      fingerprint: previous?.fingerprint,
      window: previous?.window ?? confirmedWindow(retentionForModel(provider, model, api), usage) ?? { kind: "unknown" },
    });
  }

  const snapshotsByResponse = new Map(snapshots.map((snapshot) => [snapshot.responseEntryId, snapshot]));
  for (const entry of entries) {
    if (entry.type !== "usage" || entry.kind !== "cache_warm") continue;
    const childId = assistantChildren.get(entry.id);
    const source = (childId === undefined ? undefined : snapshotsByResponse.get(childId)) ??
      findBranchBaseline(entries, entry.parentId, snapshots);
    const sameModel = source?.provider === entry.provider && source.model === entry.model;
    const previous = previousByResponse.get(entry.id);
    const api = previous?.api ?? (sameModel ? source.api : undefined);
    const at = sessionEntryAt(entry);
    snapshots.push({
      requestLeafId: childId ?? entry.parentId,
      responseEntryId: entry.id,
      responseAt: at,
      requestAt: at,
      promptTokens: entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite,
      provider: entry.provider,
      model: entry.model,
      api,
      fingerprint: previous?.fingerprint ?? (sameModel ? source.fingerprint : undefined),
      window: previous?.window ?? (sameModel
        ? source.window
        : confirmedWindow(retentionForModel(entry.provider, entry.model, api), entry.usage) ?? { kind: "unknown" }),
    });
  }
  return snapshots;
}

export function restoreLineageSnapshots(
  entries: readonly SessionEntry[],
  previousSnapshots?: CacheLineageSnapshot[],
): CacheLineageSnapshot[] {
  const previousByResponse = new Map<string, CacheLineageSnapshot>();
  for (const snapshot of previousSnapshots ?? []) {
    if (snapshot.responseEntryId) previousByResponse.set(snapshot.responseEntryId, snapshot);
  }
  return snapshotsFromEntries(entries, previousByResponse);
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

export function hydrateLineageResponseIds(
  snapshots: CacheLineageSnapshot[],
  entries: readonly SessionEntry[],
): void {
  const unresolved = snapshots.filter((snapshot) => snapshot.responseEntryId === undefined);
  if (unresolved.length === 0) return;
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const persisted = new Map(
    snapshotsFromEntries(entries).map((snapshot) => [responseLinkKey(snapshot), snapshot]),
  );
  for (const snapshot of unresolved) {
    snapshot.requestLeafId = requestLeafFor(entriesById, snapshot.requestLeafId);
    snapshot.responseEntryId = persisted.get(responseLinkKey(snapshot))?.responseEntryId;
  }
}

export function findBranchBaseline(
  entries: readonly SessionEntry[],
  activeLeafId: string | null,
  snapshots: readonly CacheLineageSnapshot[],
): CacheLineageSnapshot | undefined {
  if (activeLeafId === null) return undefined;
  const parents = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const reversePath: string[] = [];
  let current: string | null = activeLeafId;
  while (current !== null) {
    reversePath.push(current);
    current = parents.get(current) ?? null;
  }
  const depth = new Map(reversePath.reverse().map((id, index) => [id, index]));
  let nearest: { snapshot: CacheLineageSnapshot; depth: number } | undefined;
  for (const snapshot of snapshots) {
    const responseDepth = snapshot.responseEntryId === undefined ? undefined : depth.get(snapshot.responseEntryId);
    const requestDepth = snapshot.requestLeafId === null ? undefined : depth.get(snapshot.requestLeafId);
    if (responseDepth === undefined && requestDepth === undefined) continue;
    const anchorDepth = Math.max(responseDepth ?? -1, requestDepth ?? -1);
    if (
      !nearest || anchorDepth > nearest.depth ||
      (anchorDepth === nearest.depth && snapshot.requestAt > nearest.snapshot.requestAt)
    ) nearest = { snapshot, depth: anchorDepth };
  }
  return nearest?.snapshot;
}
