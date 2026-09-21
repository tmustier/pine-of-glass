import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { classifyCall } from "./classify.ts";
import { findBranchBaseline } from "./lineage.ts";
import { confirmedWindow, type RetentionMatch } from "./retention.ts";
import type { CacheLineageSnapshot, CacheWindow, CallRecord } from "./types.ts";

type CacheWarmUsageEntry = Extract<SessionEntry, { type: "usage" }>;

export interface WarmSyncState {
  records: CallRecord[];
  lineages: CacheLineageSnapshot[];
  seenWarmEntryIds: Set<string>;
  pendingRetention?: RetentionMatch;
  prevCallRequestAt?: number;
  lastRequestAt?: number;
  window: CacheWindow;
  lastCallModelId?: string;
  lastCallProvider?: string;
  lastCallApi?: string;
  modelSwitched: boolean;
  expectedRead: number;
  compacted: boolean;
  inCompaction: boolean;
}

export function isWarmUsageEntry(entry: SessionEntry): entry is CacheWarmUsageEntry {
  return entry.type === "usage" && entry.kind === "cache_warm";
}

function warmEntryAt(entry: CacheWarmUsageEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Reconcile Pi's persisted warming usage at the next public extension boundary.
 * Pi 0.86 emits no extension completion event for a warm request, so session entries
 * are the canonical completion signal. */
export function syncWarmEntries(
  state: WarmSyncState,
  ctx: Pick<ExtensionContext, "model" | "sessionManager">,
): void {
  const entries = ctx.sessionManager.getEntries();
  const branch = ctx.sessionManager.getBranch();
  for (const entry of branch) {
    if (!isWarmUsageEntry(entry) || state.seenWarmEntryIds.has(entry.id)) continue;
    state.seenWarmEntryIds.add(entry.id);
    const usage = entry.usage;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) continue;
    const requestAt = warmEntryAt(entry);
    const gapMs = state.prevCallRequestAt === undefined ? undefined : requestAt - state.prevCallRequestAt;
    const switched = state.lastCallModelId !== undefined && (
      entry.model !== state.lastCallModelId ||
      (state.lastCallProvider !== undefined && entry.provider !== state.lastCallProvider)
    );
    const classification = classifyCall({
      isFirst: state.records.length === 0,
      gapMs,
      window: state.window,
      usage,
      expectedRead: state.expectedRead,
      modelSwitched: switched,
      compacted: state.compacted,
      inCompaction: state.inCompaction,
    });
    const record: CallRecord = {
      index: state.records.length + 1,
      at: requestAt,
      requestAt,
      gapMs,
      usage,
      expectedRead: state.expectedRead,
      classification,
      rewroteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : usage.input,
      switched: switched ? true : undefined,
      costUsd: usage.cost.total,
      // A no-cache counterfactual would not make this maintenance request. Giving it
      // the same counterfactual cost includes the overhead without inventing savings.
      uncachedUsd: usage.cost.total,
      warm: true,
    };
    state.records.push(record);
    const promptSize = usage.input + usage.cacheRead + usage.cacheWrite;
    const childAssistant = branch.find((candidate) =>
      candidate.parentId === entry.id && candidate.type === "message" && candidate.message.role === "assistant"
    );
    const source = (childAssistant === undefined
      ? undefined
      : state.lineages.find((snapshot) => snapshot.responseEntryId === childAssistant.id)) ??
      findBranchBaseline(entries, entry.parentId, state.lineages);
    const sameModel = source !== undefined && source.provider === entry.provider && source.model === entry.model;
    const sourceApi = sameModel ? source.api : undefined;
    const currentModel = ctx.model;
    const activeWindow = sameModel && source.window !== undefined
      ? source.window
      : confirmedWindow(state.pendingRetention, usage) ?? state.window;
    state.lineages.push({
      requestLeafId: childAssistant?.id ?? entry.parentId,
      responseEntryId: entry.id,
      responseAt: requestAt,
      requestAt,
      promptTokens: promptSize,
      provider: entry.provider,
      model: entry.model,
      api: sourceApi ?? (
        currentModel?.provider === entry.provider && currentModel.id === entry.model ? currentModel.api : undefined
      ),
      fingerprint: sameModel ? source.fingerprint : undefined,
      window: activeWindow,
      recordIndex: record.index,
    });
    state.expectedRead = promptSize;
    state.prevCallRequestAt = requestAt;
    state.lastRequestAt = Math.max(state.lastRequestAt ?? 0, requestAt);
    state.window = activeWindow;
    state.lastCallModelId = entry.model;
    state.lastCallProvider = entry.provider;
    if (sourceApi !== undefined) state.lastCallApi = sourceApi;
    state.modelSwitched = ctx.model !== undefined && (
      ctx.model.provider !== entry.provider || ctx.model.id !== entry.model ||
      (state.lastCallApi !== undefined && ctx.model.api !== state.lastCallApi)
    );
  }
}
