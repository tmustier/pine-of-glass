import type { CallCause, CallClassification, CallRecord, UsageLike } from "./types.ts";

type RestoreClassifier = (args: {
  isFirst: boolean;
  gapMs?: number;
  usage: UsageLike;
  expectedRead: number;
  modelSwitched?: boolean;
  fingerprintCause?: CallCause;
}) => CallClassification;

function identityChanged(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

function stringField(message: Record<string, unknown>, key: string): string | undefined {
  return typeof message[key] === "string" ? message[key] as string : undefined;
}

/** Rebuild active-branch ledger rows without inventing request-time causes. */
export function restoreBranchRecords(
  messages: Array<Record<string, unknown>>,
  classify: RestoreClassifier,
): CallRecord[] {
  const records: CallRecord[] = [];
  let previousAt: number | undefined;
  let previousIdentity: { provider?: string; model?: string; api?: string } | undefined;
  let expectedRead = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = message.usage as UsageLike | undefined;
    if (!usage || (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0)) continue;
    const at = typeof message.timestamp === "number" ? message.timestamp : 0;
    // A model-identity change between persisted calls is in the data, not invented:
    // the previous expectation is old-currency and the switch itself names the cause.
    const identity = { provider: stringField(message, "provider"), model: stringField(message, "model"), api: stringField(message, "api") };
    const switched = previousIdentity !== undefined && (
      identityChanged(previousIdentity.provider, identity.provider) ||
      identityChanged(previousIdentity.model, identity.model) ||
      identityChanged(previousIdentity.api, identity.api)
    );
    const classification = classify({
      isFirst: records.length === 0,
      gapMs: previousAt !== undefined ? at - previousAt : undefined,
      usage,
      expectedRead,
      modelSwitched: switched,
      fingerprintCause: switched
        ? { kind: "model", detail: `model switched ${previousIdentity?.model ?? "previous model"} \u2192 ${identity.model ?? "current model"}` }
        : undefined,
    });
    if (
      classification.cause && classification.kind !== "cold" && classification.kind !== "hit" &&
      classification.cause.kind !== "model"
    ) {
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
      switched: switched ? true : undefined,
      costUsd: usage.cost?.total,
      restored: true,
    });
    previousAt = at;
    previousIdentity = identity;
    expectedRead = usage.input + usage.cacheRead + usage.cacheWrite;
  }
  return records;
}
