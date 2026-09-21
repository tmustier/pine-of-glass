import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { sessionEntryAt } from "./lineage-persistence.ts";
import type { CallCause, CallClassification, CallRecord, UsageLike } from "./types.ts";

type RestoreClassifier = (args: {
  isFirst: boolean;
  gapMs?: number;
  usage: UsageLike;
  expectedRead: number;
  modelSwitched?: boolean;
  compacted?: boolean;
  fingerprintCause?: CallCause;
}) => CallClassification;

function identityChanged(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

type PersistedCall = {
  at: number;
  usage: Usage;
  provider?: string;
  model?: string;
  api?: string;
  warm: boolean;
};

export function restoreBranchRecords(
  entries: readonly SessionEntry[],
  classify: RestoreClassifier,
): CallRecord[] {
  const records: CallRecord[] = [];
  let previousAt: number | undefined;
  let previousIdentity: { provider?: string; model?: string; api?: string } | undefined;
  let expectedRead = 0;
  let compacted = false;
  for (const entry of entries) {
    if (entry.type === "compaction") {
      compacted = true;
      continue;
    }

    let call: PersistedCall;
    if (entry.type === "usage" && entry.kind === "cache_warm") {
      call = {
        at: sessionEntryAt(entry),
        usage: entry.usage,
        provider: entry.provider,
        model: entry.model,
        warm: true,
      };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      call = {
        at: sessionEntryAt(entry),
        usage: entry.message.usage,
        provider: entry.message.provider,
        model: entry.message.model,
        api: entry.message.api,
        warm: false,
      };
    } else {
      continue;
    }

    const { usage } = call;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) continue;
    const inheritedApi = call.warm && previousIdentity !== undefined &&
      previousIdentity.provider === call.provider && previousIdentity.model === call.model
      ? previousIdentity.api
      : undefined;
    const identity = { provider: call.provider, model: call.model, api: call.api ?? inheritedApi };
    const switched = previousIdentity !== undefined && (
      identityChanged(previousIdentity.provider, identity.provider) ||
      identityChanged(previousIdentity.model, identity.model) ||
      identityChanged(previousIdentity.api, identity.api)
    );
    const gapMs = previousAt === undefined ? undefined : call.at - previousAt;
    let fingerprintCause: CallCause | undefined;
    if (switched) {
      assert(previousIdentity);
      fingerprintCause = {
        kind: "model",
        detail: `model switched ${previousIdentity.model ?? "previous model"} \u2192 ${identity.model ?? "current model"}`,
      };
    }
    const classification = classify({
      isFirst: records.length === 0,
      gapMs,
      usage,
      expectedRead,
      modelSwitched: switched,
      compacted,
      fingerprintCause,
    });
    if (
      classification.cause && classification.kind !== "cold" && classification.kind !== "hit" &&
      classification.cause.kind !== "model" && classification.cause.kind !== "compaction"
    ) {
      classification.cause = { kind: "restored", detail: "restored session (cause unknown)" };
    }
    records.push({
      index: records.length + 1,
      at: call.at,
      gapMs,
      usage,
      expectedRead,
      classification,
      rewroteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : usage.input,
      switched: switched ? true : undefined,
      postCompaction: compacted ? { modelSwitched: switched } : undefined,
      costUsd: usage.cost.total,
      warm: call.warm ? true : undefined,
      restored: true,
    });
    previousAt = call.at;
    previousIdentity = identity;
    expectedRead = usage.input + usage.cacheRead + usage.cacheWrite;
    compacted = false;
  }
  return records;
}
