import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { booleanValue, isJsonObject, positiveNumberValue } from "../_lib/boundary.ts";
import { captureTui } from "../_lib/capture.ts";
import { type ContainerLike } from "../_lib/chat.ts";
import {
  anchorForAppend,
  appendAnchoredLine,
  childAnchorKey,
  reattachAnchored,
  type AnchoredLine,
} from "../_lib/chatline.ts";
import { configPaths, readJsonConfig } from "../_lib/config.ts";
import { compactCount, formatDuration, formatUsd } from "../_lib/fmt.ts";
import { GLYPH, SCALE, SEP, ink, panelHeader, type Tone } from "../_lib/style.ts";
import {
  classifyCall,
  diffFingerprints,
  expiryCause,
  fingerprintPayload,
  pastWindow,
  stripCacheMarkers,
} from "./classify.ts";
import { UNKNOWN_WINDOW, cacheClock, nextClockUpdateMs, withinWarmHorizon } from "./clock.ts";
import { activeToolShapes, computeSwitchForecast, type SwitchForecast, type SwitchTarget } from "./forecast.ts";
import { restoreBranchRecords } from "./ledger.ts";
import {
  cacheStateForLineage,
  findBranchBaseline,
  hydrateLineageResponseIds,
  resolveCacheLineage,
  restoreLineageSnapshots,
} from "./lineage.ts";
import { renderBreakingLine, renderHeldLine, renderMissLine, renderRunSummary } from "./render.ts";
import {
  confirmedWindow,
  inferAnthropicTtlMs,
  OPENAI_EXTENDED_WINDOW,
  OPENAI_MINIMUM_WINDOW,
  retentionForModel,
  retentionForRequest,
  type RetentionMatch,
  windowLabel,
} from "./retention.ts";
import { clearCacheWidgetTimer, type CacheWidgetRuntime, updateCacheWidget } from "./widget.ts";
import type {
  BreakPrediction,
  CacheLineageSnapshot,
  CacheWindow,
  CachemireConfig,
  CallCause,
  CallClassification,
  CallRecord,
  ModelRates,
  RequestFingerprint,
  RunAggregate,
  UsageLike,
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

/**
 * pi-cachemire — explains the cache and loop economics of a pi session.
 *
 * pi's footer already *counts* (input/output/cache read/write/cost); cachemire *explains*:
 *   1. "Am I past TTL?"            → a warning above the editor shortly before a known
 *      cache window closes, with the possible re-write bill once stale.
 *   2. "Why did the cache break?"  → forensics: every provider request is fingerprinted
 *      (system / tools / history segments, cache_control stripped); on a miss the diff
 *      names supported causes such as retention expiry, compaction, model switch,
 *      system prompt edits, tool-list changes, or history mutations, and otherwise
 *      reports the cause as unknown.
 *   3. "Am I using too many calls?"→ a one-line ledger entry per user turn (auto-shown for
 *      multi-call turns) and a /cache command with the full per-call table plus actual vs
 *      counterfactual-uncached spend ("caching saved $X").
 *
 * Numbers are provider-exact (assistant-message usage), except after a model switch:
 * the exact counts on hand are old-model currency, so the prompt is forecast in the
 * target tokenizer and marked est (issue #57). Display is UI-only: nothing cachemire
 * renders enters LLM context, session entries, or exports.
 */

const DEFAULT_CONFIG: CachemireConfig = {
  widget: true,
  turnSummary: true,
  turnSummaryMinCalls: 1, // every turn: a single-call turn omitting the line felt inconsistent
  missWarnings: true,
  missWarnUsd: 0.05,
  missWarnTokens: 20_000,
};

/**
 * What a pi thinking level becomes on the anthropic wire — mirrors pi-ai's
 * mapThinkingLevelToEffort (model map override first, then minimal/low→low,
 * medium→medium, high→high, anything else→high) plus the off→disabled case.
 */
function wireThinkingEffort(
  map: Partial<Record<string, string | null>> | undefined,
  level: string,
): string {
  if (level === "off") return "off";
  const mapped = map?.[level];
  if (typeof mapped === "string") return mapped;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return level;
  return "high";
}

/**
 * Whether switching pi thinking levels changes what actually goes on the wire. Two
 * levels mapping to the same effort are a wire no-op: live-verified on claude-fable-5,
 * where minimal→low (both effort "low") produced a byte-identical payload and a 100%
 * cache hit — a naive "any level change breaks cache" flip would have lied. This is the
 * effort-based (adaptive) view; budget models can differ where efforts collide, which
 * under-flips the widget — the send-time fingerprint diff still catches those exactly.
 */
function thinkingLevelsDiffer(
  map: Partial<Record<string, string | null>> | undefined,
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  return wireThinkingEffort(map, a) !== wireThinkingEffort(map, b);
}

// Glyphs and ink come from the family style (_lib/style.ts, design language §§1–3):
// ◍ opens every loop-economics line, ○ ● ◑ ◌ are the status scale, and all colour
// is theme-derived through ink() with raw-ANSI fallbacks before a Theme handle exists.

// --- break prediction (at request time, before usage exists) ---------------------------
// Almost every break cause is knowable when the request is sent: the idle gap vs TTL,
// pi's compact events, and the payload fingerprint diff. Predicting at send time lets the
// notice sit between the user's action and the response — where the causality lives —
// and the resolved actuals replace it in place when usage arrives.

function predictBreak(args: {
  isFirst: boolean;
  inCompaction: boolean;
  compacted: boolean;
  gapMs?: number;
  window?: CacheWindow;
  expectedRead: number;
  fingerprintCause?: CallCause;
  rates?: ModelRates;
  /** Target-currency estimate while a model switch is pending (issue #57). */
  switchForecast?: Pick<SwitchForecast, "estTokens" | "basis" | "targetProvider"> & { priorMayBeWarm: boolean };
}): BreakPrediction | undefined {
  // Cold starts are healthy and the compaction summarizer call is labelled, not warned.
  if (args.isFirst || args.inCompaction || args.expectedRead <= 0) return undefined;
  if (args.compacted) {
    // The old prefix is gone; the new one's size is unknowable until usage arrives.
    return { cause: { kind: "compaction", detail: "history compacted" } };
  }
  const sized = (cause: CallCause): BreakPrediction => ({
    cause,
    expectedRewriteTokens: args.expectedRead,
    expectedUsd: rewriteCostUsd(args.expectedRead, args.rates),
  });
  if (args.fingerprintCause) {
    // Model switches break the cache vs the *last* call for certain (caches are
    // per-model on every provider), but the stored size is denominated in the old
    // model's tokenizer — never show that number. When the shared heuristics produced
    // a target-currency estimate, claim that instead, marked est. When the target
    // model's own prior cache entry may still be warm (A→B→A), stay silent: the
    // resolved line reports the truth when usage arrives.
    if (args.fingerprintCause.kind === "model") {
      const forecast = args.switchForecast;
      if (forecast?.priorMayBeWarm) return undefined;
      if (forecast?.estTokens === undefined) return { cause: args.fingerprintCause };
      return {
        cause: args.fingerprintCause,
        estimatedRewriteTokens: forecast.estTokens,
        estimatedUsd: rewriteCostUsd(forecast.estTokens, args.rates),
        estimateBasis: forecast.basis,
        targetProvider: forecast.targetProvider,
      };
    }
    if (args.fingerprintCause.kind === "compaction") return { cause: args.fingerprintCause };
    if (args.fingerprintCause.kind === "thinking") {
      // Only an Anthropic contract window earns an in-flight claim. The affected share
      // of expectedRead is unknowable, so the prediction stays unsized.
      return args.window?.kind === "contract" ? { cause: args.fingerprintCause } : undefined;
    }
    return sized(args.fingerprintCause);
  }
  // Only a definite contract expiry or reached maximum earns an in-flight line.
  if (pastWindow(args.window, args.gapMs)) {
    return sized(expiryCause(args.window, args.gapMs)!);
  }
  return undefined;
}

// --- economics -------------------------------------------------------------------------

function uncachedCostUsd(usage: UsageLike, rates?: ModelRates): number | undefined {
  if (!rates) return undefined;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return (inputTokens * rates.input + usage.output * rates.output) / 1_000_000;
}

function rewriteCostUsd(tokens: number, rates?: ModelRates): number | undefined {
  if (!rates) return undefined;
  // Request-wide pricing tiers: the highest matching threshold prices the whole request.
  const tier = (rates.tiers ?? [])
    .filter((candidate) => tokens > candidate.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? rates;
  return (tokens * (tier.cacheWrite || tier.input)) / 1_000_000;
}

function sessionSavings(records: CallRecord[]): { actual: number; uncached: number; saved: number; pct: number } | undefined {
  const usable = records.filter((record) => record.costUsd !== undefined && record.uncachedUsd !== undefined);
  if (usable.length === 0) return undefined;
  const actual = usable.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  const uncached = usable.reduce((sum, record) => sum + (record.uncachedUsd ?? 0), 0);
  if (uncached <= 0) return undefined;
  return { actual, uncached, saved: uncached - actual, pct: (1 - actual / uncached) * 100 };
}

// All number formatting lives in _lib/fmt.ts (family number grammar); the test suite
// reaches it through this module's internals surface.

// --- ledger lines ----------------------------------------------------------------------

// The family status scale (design language §1): ○ cold · ● hit · ◑ partial · ◌ miss.
const EVENT_GLYPHS: Record<CallClassification["kind"], string> = {
  cold: SCALE.cold,
  hit: SCALE.hit,
  partial: SCALE.partial,
  miss: SCALE.miss,
};

function renderLedger(
  records: CallRecord[],
  options: { providerLabel?: string; window?: CacheWindow; modelLabel?: string; theme?: Theme } = {},
): string[] {
  // The family panel-header form (design language §8): [Cachemire] brand line, with the
  // descriptive title and provider profile demoted to the dim hint. The appended chat
  // line carries its own spacer, so panelHeader's leading blank is dropped.
  const profile: string[] = ["cache & loop ledger"];
  if (options.providerLabel) profile.push(options.providerLabel);
  profile.push(windowLabel(options.window ?? UNKNOWN_WINDOW));
  if (options.modelLabel) profile.push(options.modelLabel);
  const lines: string[] = panelHeader(options.theme, "Cachemire", { hint: profile.join(SEP) }).slice(1);
  if (records.length === 0) {
    lines.push("  no model calls yet");
    return lines;
  }
  const col = (value: string, width: number) => value.padStart(width);
  lines.push(
    `  ${col("call", 4)} ${col("gap", 7)} ${col("input", 8)} ${col("read", 8)} ${col("wrote", 8)} ${col("out", 7)} ${col("cost", 7)}  event`,
  );
  for (const record of records) {
    const { usage } = record;
    const eventText = record.classification.kind === "hit"
      ? "hit"
      : record.classification.kind === "cold"
        ? "cold start"
        : `${record.classification.kind} \u2014 ${record.classification.cause?.detail ?? "unknown"}`;
    lines.push(
      `  ${col(String(record.index), 4)} ${col(record.gapMs !== undefined ? formatDuration(record.gapMs) : "\u2014", 7)}` +
      ` ${col(compactCount(usage.input), 8)} ${col(compactCount(usage.cacheRead), 8)}` +
      ` ${col(compactCount(usage.cacheWrite), 8)} ${col(compactCount(usage.output), 7)}` +
      ` ${col(record.costUsd !== undefined ? formatUsd(record.costUsd) : "\u2014", 7)}` +
      `  ${EVENT_GLYPHS[record.classification.kind]} ${eventText}${record.restored ? " (restored)" : ""}`,
    );
  }
  const totals = records.reduce(
    (sum, record) => ({
      calls: sum.calls + 1,
      input: sum.input + record.usage.input,
      read: sum.read + record.usage.cacheRead,
      wrote: sum.wrote + record.usage.cacheWrite,
      out: sum.out + record.usage.output,
      cost: sum.cost + (record.costUsd ?? 0),
    }),
    { calls: 0, input: 0, read: 0, wrote: 0, out: 0, cost: 0 },
  );
  lines.push(
    `  totals: ${totals.calls} calls \u00b7 input ${compactCount(totals.input)} \u00b7 read ${compactCount(totals.read)}` +
    ` \u00b7 wrote ${compactCount(totals.wrote)} \u00b7 out ${compactCount(totals.out)} \u00b7 ${formatUsd(totals.cost)}`,
  );
  const savings = sessionSavings(records);
  if (savings && savings.saved > 0.001) {
    lines.push(
      `  caching saved ~${formatUsd(savings.saved)} vs uncached ${formatUsd(savings.uncached)}` +
      ` (\u2212${savings.pct.toFixed(0)}%) \u00b7 API-priced; notional on subscription`,
    );
  }
  return lines;
}

// --- config ----------------------------------------------------------------------------

function parseCachemireConfig(value: unknown): Partial<CachemireConfig> {
  if (!isJsonObject(value)) return {};
  const config: Partial<CachemireConfig> = {};
  const widget = booleanValue(value.widget);
  const turnSummary = booleanValue(value.turnSummary);
  const turnSummaryMinCalls = positiveNumberValue(value.turnSummaryMinCalls);
  const missWarnings = booleanValue(value.missWarnings);
  const missWarnUsd = positiveNumberValue(value.missWarnUsd);
  const missWarnTokens = positiveNumberValue(value.missWarnTokens);
  if (widget !== undefined) config.widget = widget;
  if (turnSummary !== undefined) config.turnSummary = turnSummary;
  if (turnSummaryMinCalls !== undefined) config.turnSummaryMinCalls = Math.floor(turnSummaryMinCalls);
  if (missWarnings !== undefined) config.missWarnings = missWarnings;
  if (missWarnUsd !== undefined) config.missWarnUsd = missWarnUsd;
  if (missWarnTokens !== undefined) config.missWarnTokens = Math.floor(missWarnTokens);
  return config;
}

function loadConfig(cwd: string): CachemireConfig {
  return configPaths("pi-cachemire", cwd).reduce(
    (config, filePath) => ({ ...config, ...readJsonConfig(filePath, parseCachemireConfig) }),
    { ...DEFAULT_CONFIG },
  );
}

// --- chat scrollback append (display-only; never touches LLM context) -------------------
// Anchored-line machinery lives in _lib/chatline.ts (shared with pi-meantime): lines
// are appended straight to pi's chat container and re-attached across pi's chat
// rebuilds via durable anchors. Cachemire re-exports the shape for its tests.

export type { AnchoredLine } from "../_lib/chatline.ts";

// --- live state ------------------------------------------------------------------------

interface CachemireState {
  config: CachemireConfig;
  notifyFallback?: (plainText: string) => void;
  records: CallRecord[];
  lineages: CacheLineageSnapshot[];
  pendingFingerprint?: RequestFingerprint;
  pendingFingerprintCause?: CallCause;
  pendingRequestLeafId?: string | null;
  pendingRetention?: RetentionMatch;
  pendingRequestAt?: number;
  pendingPreviousRequestAt?: number;
  pendingPreviousWindow?: CacheWindow;
  pendingCacheGapMs?: number;
  prevCallRequestAt?: number;
  lastRequestAt?: number;
  window: CacheWindow;
  /** Model id at the time of the last billed call, and therefore of expectedRead. */
  lastCallModelId?: string;
  /** Provider/api that billed the last call: the same id through a different
   * provider or wire api is a different cache (and possibly a different tokenizer). */
  lastCallProvider?: string;
  lastCallApi?: string;
  currentModelId?: string;
  modelSwitched: boolean;
  /** Target-currency forecast while modelSwitched (issue #57); cleared by usage. */
  switchForecast?: SwitchForecast;
  /** Thinking level at the last billed call vs now; mirrors the model-switch pair. */
  lastCallThinkingLevel?: string;
  currentThinkingLevel?: string;
  thinkingChanged: boolean;
  expectedRead: number;
  rates?: ModelRates;
  modelLabel?: string;
  providerLabel?: string;
  compacted: boolean;
  inCompaction: boolean;
  /** Chat lines cachemire appended, with anchors for re-attachment after pi rebuilds. */
  anchored: AnchoredLine[];
  /** Cached chat container: rebuilds empty it of recognizable rows, but the instance
   * lives for the whole interactive session, so the first find stays valid. */
  chat?: ContainerLike;
  /** In-flight break notice placed at request time; resolved in place when usage arrives. */
  pendingNotice?: Text;
  run?: RunAggregate;
  /** Theme handle (captured at session_start) — all chat/widget ink flows through ink(). */
  theme?: Theme;
  ui?: Pick<ExtensionUIContext, "setWidget" | "notify">;
  tui?: { requestRender?: (force?: boolean) => void };
}

type CachemireGlobal = typeof globalThis & {
  __piCachemire?: CachemireState;
  __piCachemireWidget?: CacheWidgetRuntime;
  __piCachemireOwner?: symbol;
};
const g = globalThis as CachemireGlobal;
const cacheWidget = g.__piCachemireWidget ??= {};
function state(): CachemireState {
  if (!g.__piCachemire) {
    g.__piCachemire = {
      config: DEFAULT_CONFIG,
      records: [],
      lineages: [],
      window: UNKNOWN_WINDOW,
      modelSwitched: false,
      thinkingChanged: false,
      expectedRead: 0,
      compacted: false,
      inCompaction: false,
      anchored: [],
    };
  }
  return g.__piCachemire;
}

// One-line loop-economics facts (design language §§1, 6): ◍ opens the line; the status
// tone is theme-derived. These are transient signals, so the tone covers the whole line.
function econLine(tone: Tone, text: string): string {
  return ink(state().theme, tone, `${GLYPH.econ} ${text}`);
}
function updateWidget(now = Date.now()): void {
  const s = state();
  updateCacheWidget(cacheWidget, {
    enabled: s.config.widget,
    ui: s.ui,
    renderLine: econLine,
    clock: {
      now,
      lastRequestAt: s.lastRequestAt,
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
function appendChatLine(text: string): Text | undefined {
  const s = state();
  s.notifyFallback ??= (plainText) => s.ui?.notify(plainText, "info");
  return appendAnchoredLine(s, "cachemire", text);
}

function resolveNotice(text: string): void {
  const s = state();
  if (!s.pendingNotice) return;
  s.pendingNotice.setText(text);
  s.pendingNotice = undefined;
  s.tui?.requestRender?.(true);
}

/** Recompute (or clear) the switch forecast from the current canonical history. */
function refreshSwitchForecast(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "sessionManager" | "getSystemPrompt">,
  activeLeafId: string | null,
  target: SwitchTarget | undefined,
  providerPayload?: unknown,
): void {
  const s = state();
  if (!s.modelSwitched || !target) {
    s.switchForecast = undefined;
    return;
  }
  s.switchForecast = computeSwitchForecast({
    target,
    entries: ctx.sessionManager.getEntries(),
    activeLeafId,
    systemPromptChars: ctx.getSystemPrompt().length,
    tools: activeToolShapes(pi),
    snapshots: s.lineages,
    providerPayload,
  });
}

// --- extension entry --------------------------------------------------------------------

export default function piCachemire(pi: ExtensionAPI): void {
  const s = state();
  const ownerToken = Symbol("pi-cachemire-owner");
  const ownsState = () => g.__piCachemireOwner === ownerToken;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (g.__piCachemireOwner !== undefined && !ownsState()) return;
    g.__piCachemireOwner = ownerToken;
    s.config = loadConfig(process.cwd());
    const entries = ctx.sessionManager.getEntries();
    const { messages } = buildSessionContext(entries, ctx.sessionManager.getLeafId());
    s.records = restoreBranchRecords(messages as unknown as Array<Record<string, unknown>>, classifyCall);
    s.lineages = restoreLineageSnapshots(entries);
    const baseline = findBranchBaseline(entries, ctx.sessionManager.getLeafId(), s.lineages);
    const model = ctx.model;
    if (model) {
      s.rates = model.cost;
      s.currentModelId = model.id;
      s.modelLabel = `${model.provider}/${model.id}`;
    }
    Object.assign(s, cacheStateForLineage(
      { baseline, refresh: baseline, compatible: [] },
      { provider: model?.provider, model: model?.id, api: model?.api },
    ));
    s.prevCallRequestAt = s.records.at(-1)?.at || undefined;
    // A restored branch can already be mid-switch (billed by a different model than the
    // current one); the forecast must exist before the first widget render.
    refreshSwitchForecast(pi, ctx, ctx.sessionManager.getLeafId(), model);
    s.lastCallThinkingLevel = s.currentThinkingLevel = pi.getThinkingLevel();
    s.compacted = false;
    s.inCompaction = false;
    s.pendingFingerprint = undefined;
    s.pendingFingerprintCause = undefined;
    s.pendingRequestAt = s.pendingPreviousRequestAt = s.pendingCacheGapMs = undefined;
    s.pendingRequestLeafId = undefined;
    s.pendingRetention = s.pendingPreviousWindow = undefined;
    s.ui = ctx.ui;
    s.theme = ctx.ui.theme;
    captureTui(ctx.ui, "__pi_cachemire_capture", (tui) => {
      s.tui = tui as CachemireState["tui"];
    });
    cacheWidget.lastText = undefined;
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    if (!ownsState()) return;
    clearCacheWidgetTimer(cacheWidget);
    g.__piCachemireOwner = undefined;
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!ownsState()) return;
    const firstAttempt = s.pendingRequestAt === undefined;
    s.pendingFingerprint = fingerprintPayload(event.payload);
    const requestAt = Date.now();
    const entries = ctx.sessionManager.getEntries();
    hydrateLineageResponseIds(s.lineages, entries);
    const resolution = resolveCacheLineage({
      entries,
      activeLeafId: ctx.sessionManager.getLeafId(),
      snapshots: s.lineages,
      currentProvider: ctx.model?.provider,
      currentModel: ctx.model?.id ?? s.pendingFingerprint.model,
      currentApi: ctx.model?.api,
      currentFingerprint: s.pendingFingerprint,
      compareFingerprints: diffFingerprints,
    });
    Object.assign(s, cacheStateForLineage(
      resolution,
      { provider: ctx.model?.provider, model: ctx.model?.id ?? s.pendingFingerprint.model, api: ctx.model?.api },
    ));
    s.pendingFingerprintCause = resolution.cause;
    // Re-forecast at send time from the actual provider body. This captures pi's
    // normalization and payload transforms; unknown shapes fall back to history.
    refreshSwitchForecast(pi, ctx, ctx.sessionManager.getLeafId(), ctx.model, event.payload);
    s.pendingRequestLeafId = ctx.sessionManager.getLeafId();
    if (firstAttempt) {
      s.pendingPreviousRequestAt = s.lastRequestAt;
      s.pendingPreviousWindow = s.window;
    }
    s.pendingCacheGapMs = s.lastRequestAt !== undefined ? requestAt - s.lastRequestAt : undefined;
    s.pendingRetention = retentionForRequest({
      provider: ctx.model?.provider,
      model: ctx.model?.id ?? s.pendingFingerprint.model,
      api: ctx.model?.api,
      ttlMs: s.pendingFingerprint.ttlMs,
      payload: event.payload,
    });
    s.providerLabel = ctx.model?.provider;
    s.pendingRequestAt = requestAt;
    s.lastRequestAt = requestAt;
    s.window = UNKNOWN_WINDOW;

    // Place the break notice where the causality lives: between the user's action and the
    // response. It shows the expectation now and is resolved in place when usage arrives.
    if (s.config.missWarnings) {
      const prediction = predictBreak({
        isFirst: s.records.length === 0,
        inCompaction: s.inCompaction,
        compacted: s.compacted,
        gapMs: s.pendingCacheGapMs,
        window: s.pendingPreviousWindow ?? s.window,
        expectedRead: s.expectedRead,
        fingerprintCause: s.pendingFingerprintCause,
        rates: s.rates,
        switchForecast: s.switchForecast === undefined ? undefined : {
          ...s.switchForecast,
          priorMayBeWarm: s.switchForecast.prior !== undefined && (
            s.switchForecast.prior.window === undefined ||
            s.switchForecast.prior.window.kind === "unknown" || s.switchForecast.prior.window.kind === "minimum" ||
            (s.switchForecast.prior.window.kind === "maximum" &&
              requestAt - s.switchForecast.prior.requestAt < s.switchForecast.prior.window.maxMs) ||
            withinWarmHorizon(s.switchForecast.prior.window, requestAt - s.switchForecast.prior.requestAt)
          ),
        },
      });
      const sizedTokens = prediction?.expectedRewriteTokens ?? prediction?.estimatedRewriteTokens;
      const sizedUsd = prediction?.expectedUsd ?? prediction?.estimatedUsd;
      const material = prediction !== undefined && (
        sizedTokens === undefined || // unsized (compaction/model/thinking): explicit user action, the notice is its explanation
        sizedTokens >= s.config.missWarnTokens ||
        (sizedUsd ?? 0) >= s.config.missWarnUsd
      );
      if (material) {
        const text = econLine("warning", renderBreakingLine(prediction));
        if (s.pendingNotice) s.pendingNotice.setText(text); // provider retry: reuse the line
        else s.pendingNotice = appendChatLine(text);
      }
    }
    updateWidget();
  });

  pi.on("model_select", async (event, ctx) => {
    if (!ownsState()) return;
    const model = event.model;
    s.rates = model.cost;
    s.modelLabel = `${model.provider}/${model.id}`;
    s.currentModelId = model.id;
    // Caches are per-model on every provider, and the same id through a different
    // provider or wire api is a different cache too; the stored token count is also in
    // the old tokenizer's currency. Switching back before the next call revives both.
    s.modelSwitched = s.lastCallModelId !== undefined && (
      model.id !== s.lastCallModelId ||
      (s.lastCallProvider !== undefined && model.provider !== s.lastCallProvider) ||
      (s.lastCallApi !== undefined && model.api !== s.lastCallApi)
    );
    refreshSwitchForecast(pi, ctx, ctx.sessionManager.getLeafId(), model);
    updateWidget();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (!ownsState()) return;
    // First flip in a session: the event's own previousLevel is the level every billed
    // call so far used — a baseline that needs no session_start timing assumptions.
    s.lastCallThinkingLevel ??= event.previousLevel;
    s.currentThinkingLevel = event.level;
    // Material only when something was billed at the old level AND the new level changes
    // the wire params for this model (see thinkingLevelsDiffer); cycling back before the
    // next call revives the cache. The send-time fingerprint diff remains the authority.
    s.thinkingChanged = s.records.length > 0 && ctx.model?.reasoning === true &&
      thinkingLevelsDiffer(ctx.model.thinkingLevelMap, s.lastCallThinkingLevel, event.level);
    updateWidget();
  });

  pi.on("agent_start", async () => {
    if (!ownsState()) return;
    s.run = { startedAt: Date.now(), calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };
  });

  pi.on("session_tree", async (event, ctx) => {
    if (!ownsState()) return;
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
    // Checking out a branch billed by another model is a switch in lineage terms.
    refreshSwitchForecast(pi, ctx, event.newLeafId, ctx.model);
    updateWidget();
  });

  pi.on("session_before_compact", async () => {
    if (!ownsState()) return;
    s.inCompaction = true;
  });

  pi.on("session_compact", async () => {
    if (!ownsState()) return;
    s.inCompaction = false;
    s.compacted = true;
    updateWidget();
  });

  pi.on("message_end", async (event) => {
    if (!ownsState()) return;
    const message = event.message;
    if (message.role !== "assistant") return;
    const usage = message.usage;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) return;
    const now = Date.now();
    // Idle gap between the previous request (which refreshed the TTL) and this one.
    const requestAt = s.pendingRequestAt ?? now;
    const gapMs = s.prevCallRequestAt !== undefined ? requestAt - s.prevCallRequestAt : undefined;
    const cacheGapMs = s.pendingCacheGapMs ?? gapMs;

    const fingerprintCause = s.pendingFingerprintCause;
    const classification = classifyCall({
      isFirst: s.records.length === 0,
      gapMs: cacheGapMs,
      window: s.pendingPreviousWindow ?? s.window,
      usage,
      expectedRead: s.expectedRead,
      modelSwitched: s.modelSwitched,
      compacted: s.compacted,
      inCompaction: s.inCompaction,
      fingerprintCause,
    });
    const activeWindow = confirmedWindow(s.pendingRetention, usage) ?? UNKNOWN_WINDOW;
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
      costUsd: usage.cost.total,
      uncachedUsd: uncachedCostUsd(usage, s.rates),
    };
    s.records.push(record);
    const promptSize = usage.input + usage.cacheRead + usage.cacheWrite;
    s.lineages.push({
      requestLeafId: s.pendingRequestLeafId ?? null,
      responseAt: typeof message.timestamp === "number" ? message.timestamp : now,
      requestAt,
      promptTokens: promptSize,
      provider: message.provider,
      model: message.model,
      api: message.api,
      fingerprint: s.pendingFingerprint,
      window: activeWindow,
      recordIndex: record.index,
    });
    s.compacted = false;
    s.prevCallRequestAt = requestAt;
    s.pendingFingerprint = undefined;
    s.pendingFingerprintCause = undefined;
    s.pendingRequestAt = undefined;
    s.pendingRequestLeafId = undefined;
    s.pendingPreviousRequestAt = s.pendingPreviousWindow = undefined;
    s.pendingCacheGapMs = undefined;
    s.expectedRead = promptSize;
    s.window = activeWindow;
    s.pendingRetention = undefined;
    s.lastCallModelId = message.model ?? s.currentModelId ?? s.lastCallModelId;
    s.lastCallProvider = message.provider ?? s.lastCallProvider;
    s.lastCallApi = message.api ?? s.lastCallApi;
    s.modelSwitched = false;
    s.switchForecast = undefined;
    s.lastCallThinkingLevel = s.currentThinkingLevel ?? s.lastCallThinkingLevel;
    s.thinkingChanged = false;
    // Keep the request-start anchor: resetting to response end here would credit the cache
    // with the whole generation time (a 4m thinking block would show 5m TTL remaining when
    // the prefix written at request start has ~1m left).
    s.lastRequestAt = requestAt;

    if (s.run) {
      s.run.calls += 1;
      s.run.input += usage.input;
      s.run.cacheRead += usage.cacheRead;
      s.run.cacheWrite += usage.cacheWrite;
      s.run.output += usage.output;
      s.run.costUsd += usage.cost.total;
    }

    const broke = (classification.kind === "miss" || classification.kind === "partial") &&
      classification.cause?.kind !== "compaction-work";
    if (s.pendingNotice) {
      // Resolve the in-flight notice with actuals — yellow when the break happened, green
      // when the prediction was wrong and the prefix held (shared-prefix warmth).
      resolveNotice(broke
        ? econLine("warning", renderMissLine(record))
        : econLine("success", renderHeldLine(record)));
    } else if (
      s.config.missWarnings && broke &&
      ((record.costUsd ?? 0) >= s.config.missWarnUsd || record.rewroteTokens >= s.config.missWarnTokens)
    ) {
      // Append an unpredicted break once provider usage proves it.
      appendChatLine(econLine("warning", renderMissLine(record)));
    }
    updateWidget(now);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!ownsState()) return;
    hydrateLineageResponseIds(s.lineages, ctx.sessionManager.getEntries());
  });

  pi.on("agent_end", async () => {
    if (!ownsState()) return;
    resolveNotice(econLine("dim", "cache \u00b7 send ended without usage (aborted?) \u00b7 outcome unknown"));
    if (s.pendingRequestAt !== undefined) {
      s.lastRequestAt = s.pendingPreviousRequestAt;
      s.window = s.pendingPreviousWindow ?? s.window;
      s.pendingRequestAt = undefined;
      s.pendingRequestLeafId = undefined;
      s.pendingPreviousRequestAt = s.pendingPreviousWindow = undefined;
      s.pendingFingerprint = undefined;
      s.pendingFingerprintCause = undefined;
      s.pendingRetention = undefined;
      s.pendingCacheGapMs = undefined;
      updateWidget();
    }
    const run = s.run;
    s.run = undefined;
    if (!run || !s.config.turnSummary || run.calls < s.config.turnSummaryMinCalls) return;
    appendChatLine(econLine("dim", renderRunSummary(run, Date.now())));
  });

  pi.registerCommand("cache", {
    description: "Show the cachemire cache & loop ledger",
    handler: async (_args, ctx) => {
      if (!ownsState() || !ctx.hasUI) return;
      const lines = renderLedger(s.records, {
        providerLabel: s.providerLabel,
        window: s.window,
        modelLabel: s.modelLabel,
        theme: s.theme,
      });
      appendChatLine(lines.join("\n"));
    },
  });
}

// Test-only surface. Pi's loader imports only the default export, so this is runtime-inert.
export const internals = {
  stripCacheMarkers,
  fingerprintPayload,
  inferAnthropicTtlMs,
  wireThinkingEffort,
  thinkingLevelsDiffer,
  retentionForModel,
  retentionForRequest,
  confirmedWindow,
  windowLabel,
  pastWindow,
  OPENAI_EXTENDED_WINDOW,
  OPENAI_MINIMUM_WINDOW,
  predictBreak,
  renderBreakingLine,
  withinWarmHorizon,
  renderHeldLine,
  diffFingerprints,
  findBranchBaseline,
  hydrateLineageResponseIds,
  resolveCacheLineage,
  restoreLineageSnapshots,
  classifyCall,
  uncachedCostUsd,
  rewriteCostUsd,
  sessionSavings,
  compactCount,
  formatUsd,
  formatDuration,
  childAnchorKey,
  anchorForAppend,
  reattachAnchored,
  cacheClock,
  nextClockUpdateMs,
  renderRunSummary,
  renderMissLine,
  renderLedger,
  restoreFromMessages: (messages: Array<Record<string, unknown>>) => restoreBranchRecords(messages, classifyCall),
  DEFAULT_CONFIG,
};
