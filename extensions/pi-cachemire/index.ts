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
  diffFingerprints,
  fingerprintPayload,
  pastWindow,
  withheldThinkingCause,
  withinWarmPromise,
} from "./classify.ts";
import { UNKNOWN_WINDOW } from "./clock.ts";
import { predictBreak, rewriteCostUsd, uncachedCostUsd } from "./economics.ts";
import { activeToolDefinitions, computeSwitchForecast, type SwitchForecast } from "./forecast.ts";
import { bookCall, restoreBranchRecords, routeChanged } from "./ledger.ts";
import {
  baselineForLineage,
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
import type { CachemireConfig, CallCause, RequestFingerprint, RunAggregate } from "./types.ts";

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
  retention?: RetentionMatch;
  /** Break notice placed at send time; resolved in place when the request ends. */
  notice?: ThemedText;
}

interface CachemireState extends WarmSyncState, ChatLineHost {
  config: CachemireConfig;
  requests: RequestTracker<PendingRequest>;
  /** Target-currency forecast, read only while the model is switched (issue #57). */
  switchForecast?: SwitchForecast;
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
function appendChatLine(s: CachemireState, text: TextContent): ThemedText | undefined {
  return appendAnchoredLine(s, "cachemire", text);
}

function resolveNotice(s: CachemireState, pending: PendingRequest, text: TextContent): void {
  if (!pending.notice) return;
  pending.notice.setText(text);
  pending.notice = undefined;
  s.tui?.requestRender?.(true);
}

// --- extension entry --------------------------------------------------------------------

export default function piCachemire(pi: ExtensionAPI): void {
  /** How the selection and the active path differ from the cache baseline. */
  const drift = (s: CachemireState, ctx: ExtensionContext) => {
    const { baseline } = s;
    const model = ctx.model;
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    const snapshot = findBranchBaseline(entries, leafId, s.lineages);
    return {
      modelSwitched: model !== undefined && routeChanged(baseline.billedBy, { provider: model.provider, model: model.id, api: model.api }),
      // Compare effort against the last billed level, not intermediate selections.
      thinkingChanged: baseline.expectedRead > 0 && model?.reasoning === true && thinkingChangeInvalidatesCache(
        thinkingRoute(ctx), model.thinkingLevelMap, baseline.thinkingLevel, pi.getThinkingLevel(), thinkingEvidence(),
      ),
      compacted: snapshot !== undefined && pathContainsCompaction(entries, leafId, snapshot),
    };
  };

  /** Pi saves warm refreshes without telling extensions, so every update reads them first. */
  const updateWidget = (s: CachemireState, ctx: ExtensionContext, now = Date.now()) => {
    syncWarmEntries(s, ctx.sessionManager);
    const { baseline } = s;
    const inFlight = s.requests.inFlight;
    const d = drift(s, ctx);
    updateCacheWidget(s.widget, {
      enabled: s.config.widget,
      renderLine: (tone, text) => econLine(s, tone, text),
      refresh: () => updateWidget(s, ctx),
      clock: {
        now,
        lastRefreshedAt: inFlight?.requestAt ?? baseline.refreshedAt,
        window: inFlight ? UNKNOWN_WINDOW : baseline.window,
        cachedTokens: baseline.expectedRead,
        rewriteUsd: baseline.expectedRead > 0 ? rewriteCostUsd(baseline.expectedRead, ctx.model?.cost) : undefined,
        ...d,
        switchForecast: d.modelSwitched ? s.switchForecast : undefined,
      },
    });
  };

  const refreshSwitchForecast = (s: CachemireState, ctx: ExtensionContext) => {
    s.switchForecast = ctx.model && drift(s, ctx).modelSwitched ? computeSwitchForecast({
      target: ctx.model,
      entries: ctx.sessionManager.getEntries(),
      activeLeafId: ctx.sessionManager.getLeafId(),
      systemPromptChars: ctx.getSystemPrompt().length,
      tools: activeToolDefinitions(pi),
      snapshots: s.lineages,
    }) : undefined;
  };

  /** Resume and branch changes restore the billed level from the active path. */
  const billedThinkingLevel = (ctx: ExtensionContext, entries: readonly SessionEntry[], leafId: string | null) =>
    restoreBilledThinking(thinkingEvidence(), entries, leafId, ctx.model, Date.now()) ?? pi.getThinkingLevel();

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
      lineage: baselineForLineage(resolution),
      cause: resolution.cause ?? withheldThinkingCause(resolution.baseline?.fingerprint, fingerprint),
      retention: retentionForRequest({ ...current, ttlMs: fingerprint.ttlMs, payload }),
    };
  };

  const endedWithoutUsage = (s: CachemireState, pending: PendingRequest) =>
    resolveNotice(s, pending, econLine(s, "dim", "cache \u00b7 send ended without usage (aborted?) \u00b7 outcome unknown"));

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
      baseline: { expectedRead: 0, window: UNKNOWN_WINDOW },
      anchored: [],
      widget: {},
    }));
    s.config = config;
    const entries = ctx.sessionManager.getEntries();
    const leafId = ctx.sessionManager.getLeafId();
    s.records = restoreBranchRecords(ctx.sessionManager.getBranch());
    s.seenWarmEntryIds = new Set(entries.filter(isWarmUsageEntry).map((entry) => entry.id));
    s.lineages = restoreLineageSnapshots(entries, event.reason === "reload" ? s.lineages : undefined);
    const snapshot = findBranchBaseline(entries, leafId, s.lineages);
    s.baseline = {
      ...baselineForLineage({ baseline: snapshot, refresh: snapshot, compatible: [] }),
      lastCallAt: s.records.at(-1)?.at || undefined,
      thinkingLevel: billedThinkingLevel(ctx, entries, leafId),
    };
    // A restored branch can already be mid-switch (billed by a different model than the
    // current one); the forecast must exist before the first widget render.
    refreshSwitchForecast(s, ctx);

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
    updateWidget(s, ctx);
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
    syncWarmEntries(s, ctx.sessionManager);
    s.requests.arm();
  });

  pi.on("cache_warming_decision", async (event, ctx) => {
    if (event.action === "warm") states.get(ctx)?.requests.expectReplay();
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const agent = s.requests.payload(event.payload, () => {
      const requestAt = Date.now();
      const sent = describeRequest(s, ctx, event.payload);
      s.baseline = { ...s.baseline, ...sent.lineage };
      return {
        fingerprint: sent.fingerprint,
        cause: sent.cause,
        requestLeafId: requestLeafFor(new Map(sent.entries.map((entry) => [entry.id, entry])), ctx.sessionManager.getLeafId()),
        requestAt,
        retention: sent.retention,
      };
    }, (pending) => {
      // Replace rejected-payload evidence without restarting the clock.
      const sent = describeRequest(s, ctx, event.payload);
      pending.fingerprint = sent.fingerprint;
      pending.cause = sent.cause;
      pending.retention = sent.retention;
    });
    if (!agent) return;
    const pending = s.requests.inFlight;
    assert(pending);
    if (s.config.missWarnings) {
      const { baseline } = s;
      const d = drift(s, ctx);
      const prediction = predictBreak({
        isFirst: s.records.length === 0,
        compacted: d.compacted,
        gapMs: baseline.refreshedAt === undefined ? undefined : pending.requestAt - baseline.refreshedAt,
        window: baseline.window,
        expectedRead: baseline.expectedRead,
        fingerprintCause: pending.cause,
        thinkingCacheNeutral: thinkingChangesPreserveCache(thinkingRoute(ctx), thinkingEvidence()),
        rates: ctx.model?.cost,
        switchForecast: !d.modelSwitched || s.switchForecast === undefined ? undefined : {
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
    updateWidget(s, ctx);
  });

  // Anthropic sends response headers only after prefill has read and written the cache.
  pi.on("after_provider_response", async (_event, ctx) => {
    states.get(ctx)?.requests.responded(Date.now());
  });

  pi.on("model_select", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    refreshSwitchForecast(s, ctx);
    updateWidget(s, ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    const s = states.get(ctx);
    if (s) updateWidget(s, ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const s = states.get(ctx);
    if (s) s.run = { startedAt: Date.now(), calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };
  });

  pi.on("session_tree", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const pending = s.requests.abandon();
    if (pending) endedWithoutUsage(s, pending.sent);
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
    s.baseline = {
      ...s.baseline,
      ...baselineForLineage(resolution),
      thinkingLevel: billedThinkingLevel(ctx, entries, event.newLeafId),
    };
    // Checking out a branch billed by another model is a switch in lineage terms.
    refreshSwitchForecast(s, ctx);
    updateWidget(s, ctx);
  });

  // The summary request bypasses the provider hooks, so compaction only changes the path.
  pi.on("session_compact", async (_event, ctx) => {
    const s = states.get(ctx);
    if (s) updateWidget(s, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const s = states.get(ctx);
    const message = event.message;
    if (!s || message.role !== "assistant") return;
    const ended = s.requests.settle();
    const pending = ended?.sent;
    const usage = message.usage;
    if (!hasBilledUsage(usage)) {
      if (pending) endedWithoutUsage(s, pending);
      updateWidget(s, ctx);
      return;
    }
    const now = Date.now();
    const previous = s.baseline;
    const d = drift(s, ctx);
    const requestAt = pending?.requestAt ?? now;
    const thinkingLevel = pi.getThinkingLevel();
    const window = confirmedWindow(pending?.retention, usage) ?? UNKNOWN_WINDOW;
    // Anchor at the response start, not its end: a 4m thinking block must not show 5m left
    // on a prefix written before it started.
    const refreshedAt = ended?.respondedAt ?? requestAt;
    const { record, baseline } = bookCall(s.records.length, previous, {
      requestAt,
      at: now,
      refreshedAt,
      usage,
      route: { provider: message.provider, model: message.model, api: message.api },
      window,
      compacted: d.compacted,
      fingerprintCause: pending?.cause,
      thinkingLevel,
      uncachedUsd: uncachedCostUsd(usage, ctx.model?.cost),
    });
    // The billed verdict on an effort change, whatever the payload looked like at
    // Cachemire's hook: a later extension or provider may have transformed it.
    const route = thinkingRoute(ctx);
    const thinkingChange = route && recordBilledThinking(thinkingEvidence(), route, {
      map: ctx.model?.thinkingLevelMap,
      lastCallLevel: previous.thinkingLevel,
      currentLevel: thinkingLevel,
      incomparable: d.modelSwitched || d.compacted,
      classification: record.classification,
      thinkingNamedAtSend: pending?.cause?.kind === "thinking",
      warmPromised: withinWarmPromise(previous.window, previous.refreshedAt === undefined ? undefined : requestAt - previous.refreshedAt),
      usage,
      expectedRead: previous.expectedRead,
    });
    record.thinkingChange = thinkingChange;
    s.records.push(record);
    s.baseline = baseline;
    s.lineages.push({
      requestLeafId: pending?.requestLeafId ?? null,
      responseAt: message.timestamp,
      requestAt,
      responseStartAt: ended?.respondedAt,
      promptTokens: baseline.expectedRead,
      provider: message.provider,
      model: message.model,
      api: message.api,
      fingerprint: pending?.fingerprint,
      window,
    });

    if (s.run) {
      s.run.calls += 1;
      s.run.input += usage.input;
      s.run.cacheRead += usage.cacheRead;
      s.run.cacheWrite += usage.cacheWrite;
      s.run.output += usage.output;
      s.run.costUsd += usage.cost.total;
    }

    const broke = record.classification.kind === "miss" || record.classification.kind === "partial";
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
    } else if (s.config.missWarnings && d.thinkingChanged && thinkingChange?.held) {
      // An expected break that held: say so once; the evidence keeps later ones quiet.
      appendChatLine(s, econLine(s, "success", renderHeldLine(record)));
    }
    updateWidget(s, ctx, now);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    hydrateLineageResponseIds(s.lineages, ctx.sessionManager.getEntries());
    updateWidget(s, ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const pending = s.requests.abandon();
    if (pending) endedWithoutUsage(s, pending.sent);
    updateWidget(s, ctx);
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
      updateWidget(s, ctx);
      const records = s.records.slice();
      const options = {
        providerLabel: s.baseline.billedBy?.provider,
        window: s.baseline.window,
        modelLabel: ctx.model && `${ctx.model.provider}/${ctx.model.id}`,
      };
      appendChatLine(s, () => renderLedger(records, { ...options, theme: s.theme }).join("\n"));
    },
  });
}
