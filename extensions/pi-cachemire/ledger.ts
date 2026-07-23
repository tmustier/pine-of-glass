import type { CallClassification, CallRecord, UsageLike } from "./types.ts";

type RestoreClassifier = (args: {
  isFirst: boolean;
  gapMs?: number;
  usage: UsageLike;
  expectedRead: number;
}) => CallClassification;

/** Rebuild active-branch ledger rows without inventing request-time causes. */
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
