import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { classifyCall } from "./classify.ts";
import { UNKNOWN_WINDOW } from "./clock.ts";
import { sessionEntryAt } from "./lineage-persistence.ts";
import { hasBilledUsage } from "../_lib/usage.ts";
import type { CacheWindow, CallCause, CallRecord } from "./types.ts";

export interface Route {
  provider?: string;
  model?: string;
  /** The same model through a different wire API is a different cache. */
  api?: string;
}

/** What the provider cache holds for the active path, as of the last billed call. */
export interface CacheBaseline {
  /** Prompt size of the last billed call: the next call's expected cache read. */
  expectedRead: number;
  /** When a compatible request last refreshed the cache: the clock anchor. */
  refreshedAt?: number;
  window: CacheWindow;
  billedBy?: Route;
  thinkingLevel?: string;
  /** When the previous booked call refreshed the cache: the ledger's gap anchor. It differs
   * from `refreshedAt` after a branch switch, because the clock follows lineage and the
   * ledger follows time. */
  lastCallAt?: number;
}

const EMPTY_BASELINE: CacheBaseline = { expectedRead: 0, window: UNKNOWN_WINDOW };

/** Unknown parts of a route are not evidence of a switch. */
export function routeChanged(from: Route | undefined, to: Route): boolean {
  const changed = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a !== b;
  return from !== undefined &&
    (changed(from.provider, to.provider) || changed(from.model, to.model) || changed(from.api, to.api));
}

/** One billed call from a live response, a warm entry or a restored session entry. */
export interface BilledCall {
  /** Restored calls know only when the response was saved. */
  requestAt?: number;
  at: number;
  refreshedAt: number;
  usage: Usage;
  route: Route;
  /** The retention window this call confirmed. */
  window: CacheWindow;
  /** A compaction sits between the baseline call and this one. */
  compacted: boolean;
  fingerprintCause?: CallCause;
  thinkingLevel?: string;
  uncachedUsd?: number;
  warm?: true;
  restored?: true;
}

interface BookedCall {
  record: CallRecord;
  baseline: CacheBaseline;
}

/** Book one billed call against the baseline it read from, and advance the baseline. */
export function bookCall(records: readonly CallRecord[], baseline: CacheBaseline, call: BilledCall): BookedCall {
  const { usage } = call;
  const { billedBy } = baseline;
  // Pi saves no API on warm entries; one that repeats the baseline's model used its API.
  const sameModel = billedBy?.provider === call.route.provider && billedBy?.model === call.route.model;
  const route = { ...call.route, api: call.route.api ?? (sameModel ? billedBy?.api : undefined) };
  const switched = routeChanged(billedBy, route);
  const start = call.requestAt ?? call.at;
  const classification = classifyCall({
    isFirst: records.length === 0,
    gapMs: baseline.refreshedAt === undefined ? undefined : start - baseline.refreshedAt,
    window: baseline.window,
    usage,
    expectedRead: baseline.expectedRead,
    modelSwitched: switched,
    compacted: call.compacted,
    fingerprintCause: call.fingerprintCause ?? (switched ? {
      kind: "model",
      detail: `model switched ${billedBy?.model ?? "previous model"} \u2192 ${route.model ?? "current model"}`,
    } : undefined),
  });
  if (
    call.restored && classification.kind !== "cold" && classification.kind !== "hit" &&
    classification.cause.kind !== "model" && classification.cause.kind !== "compaction"
  ) {
    classification.cause = { kind: "restored", detail: "restored session (cause unknown)" };
  }
  return {
    record: {
      index: records.length + 1,
      at: call.at,
      requestAt: call.requestAt,
      gapMs: baseline.lastCallAt === undefined ? undefined : start - baseline.lastCallAt,
      usage,
      expectedRead: baseline.expectedRead,
      classification,
      rewroteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : usage.input,
      switched: switched ? true : undefined,
      postCompaction: call.compacted ? { modelSwitched: switched } : undefined,
      costUsd: usage.cost.total,
      uncachedUsd: call.uncachedUsd,
      warm: call.warm,
      restored: call.restored,
    },
    baseline: {
      expectedRead: usage.input + usage.cacheRead + usage.cacheWrite,
      refreshedAt: Math.max(baseline.refreshedAt ?? 0, call.refreshedAt),
      window: call.window,
      billedBy: route,
      thinkingLevel: call.thinkingLevel ?? baseline.thinkingLevel,
      lastCallAt: call.refreshedAt,
    },
  };
}

/** Rebuild a branch's ledger from its saved calls. */
export function restoreBranchRecords(entries: readonly SessionEntry[]): CallRecord[] {
  const records: CallRecord[] = [];
  let baseline = EMPTY_BASELINE;
  let compacted = false;
  for (const entry of entries) {
    if (entry.type === "compaction") {
      compacted = true;
      continue;
    }
    const warm = entry.type === "usage" && entry.kind === "cache_warm";
    const call = warm ? entry : entry.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
    if (!call || !hasBilledUsage(call.usage)) continue;
    const at = sessionEntryAt(entry);
    const booked = bookCall(records, baseline, {
      at,
      refreshedAt: at,
      usage: call.usage,
      route: { provider: call.provider, model: call.model, api: "api" in call ? call.api : undefined },
      window: UNKNOWN_WINDOW,
      compacted,
      warm: warm ? true : undefined,
      restored: true,
    });
    records.push(booked.record);
    baseline = booked.baseline;
    compacted = false;
  }
  return records;
}
