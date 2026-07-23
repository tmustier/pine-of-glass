import { isJsonObject } from "../_lib/boundary.ts";
import type {
  CallCause,
  CallClassification,
  CallRecord,
  RequestFingerprint,
  UsageLike,
} from "./index.ts";

export interface BranchLineageBaseline {
  /** Provider-billed prompt tokens for the last call on the selected branch. */
  promptTokens: number;
  /** Response timestamp when the serialized message provides one. */
  at?: number;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Recover the provider-exact prompt baseline for one resolved session branch.
 *
 * buildSessionContext() has already selected the active tree path and applied
 * compaction. This boundary parser deliberately ignores zero-usage assistant entries:
 * Pi can persist injected or aborted assistant messages that never reached a provider.
 */
export function branchLineageBaseline(messages: readonly unknown[]): BranchLineageBaseline | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isJsonObject(message) || message.role !== "assistant" || !isJsonObject(message.usage)) continue;
    const input = nonNegativeNumber(message.usage.input);
    const cacheRead = nonNegativeNumber(message.usage.cacheRead);
    const cacheWrite = nonNegativeNumber(message.usage.cacheWrite);
    const output = nonNegativeNumber(message.usage.output);
    if (input === undefined || cacheRead === undefined || cacheWrite === undefined || output === undefined) continue;
    if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) continue;
    return {
      promptTokens: input + cacheRead + cacheWrite,
      at: nonNegativeNumber(message.timestamp),
    };
  }
  return undefined;
}

function billedAssistantAt(entry: unknown): number | undefined {
  if (!isJsonObject(entry) || entry.type !== "message" || !isJsonObject(entry.message)) return undefined;
  const baseline = branchLineageBaseline([entry.message]);
  return baseline?.at;
}

/** Latest provider call whose session path contains the selected branch root. */
export function latestBranchRefreshAt(
  entries: readonly unknown[],
  branchRootId: string | null,
): number | undefined {
  if (branchRootId === null) return undefined;
  const parents = new Map<string, string | null>();
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.id !== "string") continue;
    parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
  }
  const descendsFromRoot = (entryId: string): boolean => {
    let current: string | null | undefined = entryId;
    const seen = new Set<string>();
    while (current !== null && current !== undefined && !seen.has(current)) {
      if (current === branchRootId) return true;
      seen.add(current);
      current = parents.get(current);
    }
    return false;
  };
  let latest: number | undefined;
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || !descendsFromRoot(entry.id)) continue;
    const at = billedAssistantAt(entry);
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

export function activeLineageCause(
  prev: RequestFingerprint | undefined,
  cur: RequestFingerprint | undefined,
  treeRebased: boolean,
  diff: (a: RequestFingerprint, b: RequestFingerprint) => CallCause | undefined,
): CallCause | undefined {
  const cause = prev && cur ? diff(prev, cur) : undefined;
  return treeRebased && cause?.kind === "history" ? undefined : cause;
}

type RestoreClassifier = (args: {
  isFirst: boolean;
  gapMs?: number;
  usage: UsageLike;
  expectedRead: number;
}) => CallClassification;

/** Rebuild persisted ledger rows without inventing request-time causes. */
export function restoreBranchRecords(
  messages: Array<Record<string, unknown>>,
  classify: RestoreClassifier,
): CallRecord[] {
  const records: CallRecord[] = [];
  let previousAt: number | undefined;
  let expectedRead = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = message.usage as UsageLike | undefined;
    if (!usage || (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0)) continue;
    const at = typeof message.timestamp === "number" ? message.timestamp : 0;
    const classification = classify({
      isFirst: records.length === 0,
      gapMs: previousAt !== undefined ? at - previousAt : undefined,
      usage,
      expectedRead,
    });
    if (classification.cause && classification.kind !== "cold" && classification.kind !== "hit") {
      classification.cause = { kind: "restored", detail: "restored session (cause unknown)" };
    }
    records.push({
      index: records.length + 1,
      at,
      gapMs: previousAt !== undefined ? at - previousAt : undefined,
      usage,
      expectedRead,
      classification,
      rewroteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : usage.input,
      costUsd: usage.cost?.total,
      restored: true,
    });
    previousAt = at;
    expectedRead = usage.input + usage.cacheRead + usage.cacheWrite;
  }
  return records;
}
