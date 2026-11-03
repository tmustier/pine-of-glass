import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ThemedText, TextContent } from "../_lib/themed-text.ts";
import { captureTui } from "../_lib/capture.ts";
import { appendAnchoredLine, type ChatLineHost } from "../_lib/chatline.ts";
import { readConfig } from "./config.ts";
import { LiveWidget } from "../_lib/live-widget.ts";
import { RequestTracker } from "../_lib/request-cycle.ts";
import { presentation, sessionStates } from "../_lib/session-state.ts";
import { GLYPH, ink, type Tone } from "../_lib/style.ts";
import { hasBilledUsage } from "../_lib/usage.ts";
import {
  classifyCall,
  diffFingerprints,
  fingerprintPayload,
  pastWindow,
  withheldThinkingCause,
  withinWarmPromise,
} from "./classify.ts";
import { UNKNOWN_WINDOW } from "./clock.ts";
import { predictBreak, rewriteCostUsd, uncachedCostUsd } from "./economics.ts";
import { activeToolDefinitions, computeSwitchForecast, type SwitchForecast, type SwitchTarget } from "./forecast.ts";
import { restoreBranchRecords } from "./ledger.ts";
import {
  cacheStateForLineage,
  findBranchBaseline,
  hydrateLineageResponseIds,
  pathContainsCompaction,
  requestLeafFor,
  resolveCacheLineage,
  restoreLineageSnapshots,
} from "./lineage.ts";
import { renderBreakingLine, renderHeldLine, renderLedger, renderMissLine, renderRunSummary } from "./render.ts";
import { confirmedWindow, retentionForRequest, type RetentionMatch } from "./retention.ts";
import {
  recordBilledThinking,
  restoreBilledThinking,
  thinkingChangeInvalidatesCache,
  thinkingChangesPreserveCache,
  type ThinkingEvidenceLedger,
  thinkingRoute,
} from "./thinking.ts";
import { isWarmUsageEntry, syncWarmEntries, type WarmSyncState } from "./warm.ts";
import { clearCacheWidgetTimer, type CacheWidgetRuntime, updateCacheWidget } from "./widget.ts";
import type {
  CacheWindow,
  CachemireConfig,
  CallCause,
  CallRecord,
  ModelRates,
  RequestFingerprint,
  RunAggregate,
} from "./types.ts";

export type {
  BreakPrediction,
  CacheWindow,
  CachemireConfig,
  CallCause,
  CallClassification,
  CallRecord,
  CauseKind,
  ModelRates,
  RequestFingerprint,
  RunAggregate,
  UsageLike,
} from "./types.ts";

// --- per-session state (docs/state-machines-2026-11-03.md) -------------------------------------

/** What Cachemire knew when it sent the agent request still waiting for usage. */
interface PendingRequest {
  /** Latest payload fingerprint, including provider re-attempts. */
  fingerprint: RequestFingerprint;
  cause?: CallCause;
  requestLeafId: string | null;
  requestAt: number;
  /** The clock before this send, restored when the request ends without usage. */
  previousRefreshedAt?: number;
  previousWindow: CacheWindow;
  cacheGapMs?: number;
  retention?: RetentionMatch;
  /** Break notice placed at send time; resolved in place when the request ends. */
  notice?: ThemedText;
}

interface CachemireState extends WarmSyncState, ChatLineHost {
  config: CachemireConfig;
  requests: RequestTracker<PendingRequest>;
  /** Target-currency forecast while modelSwitched (issue #57); cleared by usage. */
  switchForecast?: SwitchForecast;
  /** Thinking level at the last billed call vs now; mirrors the model-switch pair. */
  lastCallThinkingLevel?: string;
  currentThinkingLevel?: string;
  thinkingChanged: boolean;
  rates?: ModelRates;
  modelLabel?: string;
  providerLabel?: string;
  run?: RunAggregate;
  // Presentation, rebound on every session_start.
  theme?: Theme;
  widget: CacheWidgetRuntime;
}

const states = sessionStates<CachemireState>("pi-cachemire");

type CachemireGlobal = typeof globalThis & { __piCachemireThinkingEvidence?: ThinkingEvidenceLedger };
// SAFETY: a typed view of this extension's one process-wide global; only this file uses the key.
const g = globalThis as CachemireGlobal;
/** Billed effort-change verdicts per route: facts about the provider and extension stack that
 * every session and loaded copy in the process shares (see thinking.ts). */
const thinkingEvidence = (): ThinkingEvidenceLedger => (g.__piCachemireThinkingEvidence ??= new Map());

// One-line loop-economics facts (design language §§1, 6): ◍ opens the line; the status
// tone is theme-derived. These are transient signals, so the tone covers the whole line.
function econLine(s: CachemireState, tone: Tone, text: string): () => string {
  return () => ink(s.theme, tone, `${GLYPH.econ} ${text}`);
}
function updateWidget(s: CachemireState, now = Date.now()): void {
  updateCacheWidget(s.widget, {
    enabled: s.config.widget,
    renderLine: (tone, text) => econLine(s, tone, text),
    clock: {
      now,
      lastRefreshedAt: s.lastRefreshedAt,
      window: s.window,
      cachedTokens: s.expectedRead,
      rewriteUsd: s.expectedRead > 0 ? rewriteCostUsd(s.expectedRead, s.rates) : undefined,
      compacted: s.compacted,
      modelSwitched: s.modelSwitched,
      switchForecast: s.switchForecast,
      thinkingChanged: s.thinkingChanged,
    },
  });
}
function appendChatLine(s: CachemireState, text: TextContent): ThemedText | undefined {
  return appendAnchoredLine(s, "cachemire", text);
}

function resolveNotice(s: CachemireState, pending: PendingRequest, text: TextContent): void {
  if (!pending.notice) return;
  pending.notice.setText(text);
  pending.notice = undefined;
  s.tui?.requestRender?.(true);
}

/** Whether the active path compacted away the prefix its last billed call cached. Derived
 * from the session, so reload, resume and tree navigation agree with what Pi will send. */
function pathCompacted(s: CachemireState, entries: readonly SessionEntry[], leafId: string | null): boolean {
  const baseline = findBranchBaseline(entries, leafId, s.lineages);
  return baseline !== undefined && pathContainsCompaction(entries, leafId, baseline);
}

function refreshSwitchForecast(
  s: CachemireState,
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "sessionManager" | "getSystemPrompt">,
  activeLeafId: string | null,
  target: SwitchTarget | undefined,
): void {
  if (!s.modelSwitched || !target) {
    s.switchForecast = undefined;
    return;
  }
  s.switchForecast = computeSwitchForecast({
    target,
    entries: ctx.sessionManager.getEntries(),
    activeLeafId,
    systemPromptChars: ctx.getSystemPrompt().length,
    tools: activeToolDefinitions(pi),
    snapshots: s.lineages,
  });
}

// --- extension entry --------------------------------------------------------------------

export default function piCachemire(pi: ExtensionAPI): void {
  // Compare effort against the last billed level, not intermediate selections.
  const markThinkingChange = (s: CachemireState, ctx: ExtensionContext) => {
    s.thinkingChanged = s.expectedRead > 0 && ctx.model?.reasoning === true &&
      thinkingChangeInvalidatesCache(
        thinkingRoute(ctx),
        ctx.model.thinkingLevelMap,
        s.lastCallThinkingLevel,
        s.currentThinkingLevel,
        thinkingEvidence(),
      );
  };

  // Resume and branch changes restore the billed level from the active path.
  const restoreThinkingForPath = (
    s: CachemireState,
    ctx: ExtensionContext,
    entries: readonly SessionEntry[],
    leafId: string | null,
  ) => {
    const lastBilledLevel = restoreBilledThinking(thinkingEvidence(), entries, leafId, ctx.model, Date.now());
    s.currentThinkingLevel = pi.getThinkingLevel();
    s.lastCallThinkingLevel = lastBilledLevel ?? s.currentThinkingLevel;
    markThinkingChange(s, ctx);
  };

  /** Recomputed for each payload, including strict-schema fallback. */
  const describeRequest = (s: CachemireState, ctx: ExtensionContext, payload: unknown) => {
    const fingerprint = fingerprintPayload(payload, thinkingRoute(ctx));
    const entries = ctx.sessionManager.getEntries();
    hydrateLineageResponseIds(s.lineages, entries);
    const current = { provider: ctx.model?.provider, model: ctx.model?.id ?? fingerprint.model, api: ctx.model?.api };
    const resolution = resolveCacheLineage({
      entries,
      activeLeafId: ctx.sessionManager.getLeafId(),
      snapshots: s.lineages,
      currentProvider: current.provider,
      currentModel: current.model,
      currentApi: current.api,
      currentFingerprint: fingerprint,
      compareFingerprints: diffFingerprints,
    });
    return {
      entries,
      fingerprint,
      lineage: cacheStateForLineage(resolution, current),
      cause: resolution.cause ?? withheldThinkingCause(resolution.baseline?.fingerprint, fingerprint),
      retention: retentionForRequest({ ...current, ttlMs: fingerprint.ttlMs, payload }),
    };
  };

  /** A request that ended without usage: restore the clock it moved at send. */
  const rollBack = (s: CachemireState, pending: PendingRequest) => {
    s.lastRefreshedAt = pending.previousRefreshedAt;
    s.window = pending.previousWindow;
    resolveNotice(s, pending, econLine(s, "dim", "cache \u00b7 send ended without usage (aborted?) \u00b7 outcome unknown"));
  };

  pi.on("session_start", async (event, ctx) => {
    const level = presentation(ctx);
    if (level === "none") return;
    // The first session of a process starts without route evidence; later sessions share it.
    if (event.reason === "startup" && states.liveSessions === 0) g.__piCachemireThinkingEvidence = new Map();
    // SDK reload preserves in-flight requests.
    const config = readConfig();
    const s = states.open(ctx, event.reason, () => ({
      config,
      records: [],
      lineages: [],
      requests: new RequestTracker<PendingRequest>(),
      seenWarmEntryIds: new Set<string>(),
      window: UNKNOWN_WINDOW,
      modelSwitched: false,
      thinkingChanged: false,
      expectedRead: 0,
      compacted: false,
      anchored: [],
      widget: {},
    }));
    s.config = config;
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    s.records = restoreBranchRecords(ctx.sessionManager.getBranch());
    s.seenWarmEntryIds = new Set(entries.filter(isWarmUsageEntry).map((entry) => entry.id));
    s.lineages = restoreLineageSnapshots(entries, event.reason === "reload" ? s.lineages : undefined);
    const baseline = findBranchBaseline(entries, leafId, s.lineages);
    const model = ctx.model;
    if (model) {
      s.rates = model.cost;
      s.modelLabel = `${model.provider}/${model.id}`;
    }
    Object.assign(s, cacheStateForLineage(
      { baseline, refresh: baseline, compatible: [] },
      { provider: model?.provider, model: model?.id, api: model?.api },
    ));
    s.prevCallRefreshedAt = s.records.at(-1)?.at || undefined;
    s.compacted = pathCompacted(s, entries, leafId);
    // A restored branch can already be mid-switch (billed by a different model than the
    // current one); the forecast must exist before the first widget render.
    refreshSwitchForecast(s, pi, ctx, leafId, model);
    restoreThinkingForPath(s, ctx, entries, leafId);

    clearCacheWidgetTimer(s.widget);
    s.widget.widget = undefined;
    s.theme = ctx.ui.theme;
    s.notifyFallback = (plainText) => ctx.ui.notify(plainText, "info");
    s.tui = undefined;
    // RPC has notify but renders no components: no widget, no chat lines in place.
    if (level !== "tui") return;
    captureTui(ctx.ui, "__pi_cachemire_capture", (tui) => {
      s.tui = tui;
    });
    if (s.config.widget) {
      ctx.ui.setWidget("pi-cachemire", (tui) => {
        s.widget.widget = new LiveWidget(tui);
        return s.widget.widget;
      });
    }
    updateWidget(s);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    clearCacheWidgetTimer(s.widget);
    if (s.widget.widget) ctx.ui.setWidget("pi-cachemire", undefined);
    s.widget.widget = undefined;
    states.close(ctx, event.reason);
  });

  pi.on("context", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    syncWarmEntries(s, ctx);
    s.requests.arm();
  });

  pi.on("cache_warming_decision", async (event, ctx) => {
    if (event.action === "warm") states.get(ctx)?.requests.expectReplay();
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const kind = s.requests.payload(event.payload, () => {
      const requestAt = Date.now();
      const sent = describeRequest(s, ctx, event.payload);
      Object.assign(s, sent.lineage);
      const pending: PendingRequest = {
        fingerprint: sent.fingerprint,
        cause: sent.cause,
        requestLeafId: requestLeafFor(new Map(sent.entries.map((entry) => [entry.id, entry])), ctx.sessionManager.getLeafId()),
        requestAt,
        previousRefreshedAt: s.lastRefreshedAt,
        previousWindow: s.window,
        cacheGapMs: s.lastRefreshedAt !== undefined ? requestAt - s.lastRefreshedAt : undefined,
        retention: sent.retention,
      };
      s.providerLabel = ctx.model?.provider;
      s.lastRefreshedAt = requestAt;
      s.window = UNKNOWN_WINDOW;
      return pending;
    }, (pending) => {
      // Replace rejected-payload evidence without restarting the clock.
      const sent = describeRequest(s, ctx, event.payload);
      pending.fingerprint = sent.fingerprint;
      pending.cause = sent.cause;
      pending.retention = sent.retention;
    });
    if (kind !== "agent" && kind !== "reattempt") return;
    const pending = s.requests.inFlight;
    assert(pending);
    if (s.config.missWarnings) {
      const prediction = predictBreak({
        isFirst: s.records.length === 0,
        compacted: s.compacted,
        gapMs: pending.cacheGapMs,
        window: pending.previousWindow,
        expectedRead: s.expectedRead,
        fingerprintCause: pending.cause,
        thinkingCacheNeutral: thinkingChangesPreserveCache(thinkingRoute(ctx), thinkingEvidence()),
        rates: s.rates,
        switchForecast: s.switchForecast === undefined ? undefined : {
          ...s.switchForecast,
          priorMayBeWarm: s.switchForecast.prior !== undefined &&
            !pastWindow(s.switchForecast.prior.window, pending.requestAt - s.switchForecast.prior.refreshedAt),
        },
      });
      const sizedTokens = prediction?.expectedRewriteTokens ?? prediction?.estimatedRewriteTokens;
      const sizedUsd = prediction?.expectedUsd ?? prediction?.estimatedUsd;
      const material = prediction !== undefined && (
        sizedTokens === undefined || // Explain explicit breaks even without a size estimate.
        sizedTokens >= s.config.missWarnTokens ||
        (sizedUsd ?? 0) >= s.config.missWarnUsd
      );
      if (material) {
        const text = econLine(s, "warning", renderBreakingLine(prediction));
        if (pending.notice) pending.notice.setText(text);
        else pending.notice = appendChatLine(s, text);
        if (s.config.debug) {
          pi.appendEntry("cachemire-warning", { cause: prediction.cause.kind });
          pending.requestLeafId = ctx.sessionManager.getLeafId();
        }
      }
    }
    updateWidget(s);
  });

  // Anthropic sends response headers only after prefill has read and written the cache.
  pi.on("after_provider_response", async (_event, ctx) => {
    states.get(ctx)?.requests.responded(Date.now());
  });

  pi.on("model_select", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const model = event.model;
    s.rates = model.cost;
    s.modelLabel = `${model.provider}/${model.id}`;
    // Caches are per-model on every provider, and the same id through a different
    // provider or wire api is a different cache too; the stored token count is also in
    // the old tokenizer's currency. Switching back before the next call revives both.
    s.modelSwitched = s.lastCallModelId !== undefined && (
      model.id !== s.lastCallModelId ||
      (s.lastCallProvider !== undefined && model.provider !== s.lastCallProvider) ||
      (s.lastCallApi !== undefined && model.api !== s.lastCallApi)
    );
    refreshSwitchForecast(s, pi, ctx, ctx.sessionManager.getLeafId(), model);
    updateWidget(s);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    // First flip in a session: the event's own previousLevel is the level every billed
    // call so far used — a baseline that needs no session_start timing assumptions.
    s.lastCallThinkingLevel ??= event.previousLevel;
    s.currentThinkingLevel = event.level;
    markThinkingChange(s, ctx);
    updateWidget(s);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const s = states.get(ctx);
    if (s) s.run = { startedAt: Date.now(), calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };
  });

  pi.on("session_tree", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const pending = s.requests.abandon();
    if (pending) rollBack(s, pending.sent);
    const entries = ctx.sessionManager.getEntries();
    hydrateLineageResponseIds(s.lineages, entries);
    const baseline = findBranchBaseline(entries, event.newLeafId, s.lineages);
    const resolution = resolveCacheLineage({
      entries,
      activeLeafId: event.newLeafId,
      snapshots: s.lineages,
      currentProvider: ctx.model?.provider,
      currentModel: ctx.model?.id,
      currentApi: ctx.model?.api,
      currentFingerprint: baseline?.fingerprint,
      compareFingerprints: diffFingerprints,
    });
    Object.assign(s, cacheStateForLineage(
      resolution,
      { provider: ctx.model?.provider, model: ctx.model?.id, api: ctx.model?.api },
    ));
    s.compacted = pathCompacted(s, entries, event.newLeafId);
    // Checking out a branch billed by another model is a switch in lineage terms.
    refreshSwitchForecast(s, pi, ctx, event.newLeafId, ctx.model);
    restoreThinkingForPath(s, ctx, entries, event.newLeafId);
    updateWidget(s);
  });

  // The summary request bypasses the provider hooks, so compaction only changes the path.
  pi.on("session_compact", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    s.compacted = pathCompacted(s, ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    updateWidget(s);
  });

  pi.on("message_end", async (event, ctx) => {
    const s = states.get(ctx);
    const message = event.message;
    if (!s || message.role !== "assistant") return;
    const ended = s.requests.settle();
    const pending = ended?.sent;
    const usage = message.usage;
    if (!hasBilledUsage(usage)) {
      if (pending) rollBack(s, pending);
      updateWidget(s);
      return;
    }
    const now = Date.now();
    // Idle gap between the previous call's cache refresh and this request.
    const requestAt = pending?.requestAt ?? now;
    const responseAt = ended?.respondedAt;
    const refreshedAt = responseAt ?? requestAt;
    const gapMs = s.prevCallRefreshedAt !== undefined ? requestAt - s.prevCallRefreshedAt : undefined;
    const cacheGapMs = pending ? pending.cacheGapMs : gapMs;
    const previousWindow = pending?.previousWindow ?? s.window;

    const fingerprintCause = pending?.cause;
    const classification = classifyCall({
      isFirst: s.records.length === 0,
      gapMs: cacheGapMs,
      window: previousWindow,
      usage,
      expectedRead: s.expectedRead,
      modelSwitched: s.modelSwitched,
      compacted: s.compacted,
      fingerprintCause,
    });
    const activeWindow = confirmedWindow(pending?.retention, usage) ?? UNKNOWN_WINDOW;
    // The billed verdict on an effort change, whatever the payload looked like at
    // Cachemire's hook: a later extension or provider may have transformed it.
    const thinkingBreakExpected = s.thinkingChanged;
    const route = thinkingRoute(ctx);
    const thinkingChange = route && recordBilledThinking(thinkingEvidence(), route, {
      map: ctx.model?.thinkingLevelMap,
      lastCallLevel: s.lastCallThinkingLevel,
      currentLevel: s.currentThinkingLevel,
      incomparable: s.modelSwitched || s.compacted,
      classification,
      thinkingNamedAtSend: fingerprintCause?.kind === "thinking",
      warmPromised: withinWarmPromise(previousWindow, cacheGapMs),
      usage,
      expectedRead: s.expectedRead,
    });
    const record: CallRecord = {
      index: s.records.length + 1,
      at: now,
      requestAt,
      gapMs,
      usage,
      expectedRead: s.expectedRead,
      classification,
      rewroteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : usage.input,
      switched: s.modelSwitched ? true : undefined,
      postCompaction: s.compacted ? { modelSwitched: s.modelSwitched } : undefined,
      thinkingChange,
      costUsd: usage.cost.total,
      uncachedUsd: uncachedCostUsd(usage, s.rates),
    };
    s.records.push(record);
    const promptSize = usage.input + usage.cacheRead + usage.cacheWrite;
    s.lineages.push({
      requestLeafId: pending?.requestLeafId ?? null,
      responseAt: message.timestamp,
      requestAt,
      responseStartAt: responseAt,
      promptTokens: promptSize,
      provider: message.provider,
      model: message.model,
      api: message.api,
      fingerprint: pending?.fingerprint,
      window: activeWindow,
    });
    s.compacted = false;
    s.prevCallRefreshedAt = refreshedAt;
    s.expectedRead = promptSize;
    s.window = activeWindow;
    s.lastCallModelId = message.model;
    s.lastCallProvider = message.provider;
    s.lastCallApi = message.api;
    s.modelSwitched = false;
    s.switchForecast = undefined;
    s.lastCallThinkingLevel = s.currentThinkingLevel ?? s.lastCallThinkingLevel;
    s.thinkingChanged = false;
    // Anchor at the response start, not its end: a 4m thinking block must not show 5m left
    // on a prefix written before it started.
    s.lastRefreshedAt = refreshedAt;

    if (s.run) {
      s.run.calls += 1;
      s.run.input += usage.input;
      s.run.cacheRead += usage.cacheRead;
      s.run.cacheWrite += usage.cacheWrite;
      s.run.output += usage.output;
      s.run.costUsd += usage.cost.total;
    }

    const broke = classification.kind === "miss" || classification.kind === "partial";
    if (pending?.notice) {
      // Resolve the in-flight notice with actuals — yellow when the break happened, green
      // when the prediction was wrong and the prefix held (shared-prefix warmth).
      resolveNotice(s, pending, broke
        ? econLine(s, "warning", renderMissLine(record))
        : econLine(s, "success", renderHeldLine(record)));
    } else if (
      s.config.missWarnings && broke &&
      ((record.costUsd ?? 0) >= s.config.missWarnUsd || record.rewroteTokens >= s.config.missWarnTokens)
    ) {
      // Append an unpredicted break once provider usage proves it.
      appendChatLine(s, econLine(s, "warning", renderMissLine(record)));
    } else if (s.config.missWarnings && thinkingBreakExpected && thinkingChange?.held) {
      // An expected break that held: say so once; the evidence keeps later ones quiet.
      appendChatLine(s, econLine(s, "success", renderHeldLine(record)));
    }
    updateWidget(s, now);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    hydrateLineageResponseIds(s.lineages, ctx.sessionManager.getEntries());
    syncWarmEntries(s, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const pending = s.requests.abandon();
    if (pending) {
      rollBack(s, pending.sent);
      updateWidget(s);
    }
    syncWarmEntries(s, ctx);
    const run = s.run;
    s.run = undefined;
    if (!run || !s.config.turnSummary || run.calls < s.config.turnSummaryMinCalls) return;
    appendChatLine(s, econLine(s, "dim", renderRunSummary(run, Date.now())));
  });

  pi.registerCommand("cache", {
    description: "Show the cachemire cache & loop ledger",
    handler: async (_args, ctx) => {
      const s = states.get(ctx);
      if (!s) return;
      syncWarmEntries(s, ctx);
      const records = s.records.slice();
      const options = { providerLabel: s.providerLabel, window: s.window, modelLabel: s.modelLabel };
      appendChatLine(s, () => renderLedger(records, { ...options, theme: s.theme }).join("\n"));
    },
  });
}
