export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RequestFingerprint {
  kind: "anthropic" | "openai-responses" | "unknown";
  model?: string;
  systemHash?: string;
  toolHashes: Array<{ name: string; hash: string }>;
  messageHashes: string[];
  ttlMs?: number;
  /** Canonical thinking/reasoning wire parameters. */
  thinking?: string;
}

export type CauseKind =
  | "cold" | "ttl" | "compaction" | "compaction-work" | "model" | "thinking" | "system"
  | "tools" | "history" | "replica" | "restored" | "unknown";

export interface CallCause { kind: CauseKind; detail: string }

export interface CallClassification {
  kind: "cold" | "hit" | "partial" | "miss";
  cause?: CallCause;
}

export interface CallRecord {
  index: number;
  at: number;
  /** Request-start anchor; `at` is response end. Absent on restored records. */
  requestAt?: number;
  gapMs?: number;
  usage: UsageLike;
  expectedRead: number;
  classification: CallClassification;
  rewroteTokens: number;
  postCompaction?: { modelSwitched: boolean };
  costUsd?: number;
  uncachedUsd?: number;
  restored?: boolean;
}

export interface RunAggregate {
  startedAt: number;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd: number;
}

export interface CachemireConfig {
  widget: boolean;
  turnSummary: boolean;
  turnSummaryMinCalls: number;
  missWarnings: boolean;
  missWarnUsd: number;
  missWarnTokens: number;
}

export type CacheWindow =
  | { kind: "contract"; ttlMs: number; source: "observed" | "inferred" }
  | { kind: "band"; softMs: number; hardMs: number }
  | { kind: "unknown" };

export interface BreakPrediction {
  cause: CallCause;
  /** Last provider-known prompt size; absent when token currency or the new prefix is unknown. */
  expectedRewriteTokens?: number;
  expectedUsd?: number;
}

/** One provider-billed request anchored to the session path it serialized. */
export interface CacheLineageSnapshot {
  /** Last persisted session entry included in this provider request. */
  requestLeafId: string | null;
  /** Assistant response entry created by the request, linked after message persistence. */
  responseEntryId?: string;
  responseAt: number;
  requestAt: number;
  promptTokens: number;
  cacheRead: number;
  cacheWrite: number;
  provider?: string;
  model?: string;
  fingerprint?: RequestFingerprint;
  window?: CacheWindow;
  /** Chronological ledger row for live calls; restored all-branch snapshots omit it. */
  recordIndex?: number;
}

export interface ResolvedCacheLineage {
  baseline?: CacheLineageSnapshot;
  refresh?: CacheLineageSnapshot;
  compatible: CacheLineageSnapshot[];
  cause?: CallCause;
}
