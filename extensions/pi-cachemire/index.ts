import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
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
import { promptTokens, renderBreakingLine, renderHeldLine, renderMissLine, renderRunSummary } from "./render.ts";

/**
 * pi-cachemire — explains the cache and loop economics of a pi session.
 *
 * pi's footer already *counts* (input/output/cache read/write/cost); cachemire *explains*:
 *   1. "Am I past TTL?"            → a live cache clock above the editor, counting down the
 *      provider cache TTL from the last request, with the re-write bill once likely cold.
 *   2. "Why did the cache break?"  → forensics: every provider request is fingerprinted
 *      (system / tools / history segments, cache_control stripped); on a miss the diff
 *      names the culprit — TTL expiry, compaction, model switch, system prompt edit,
 *      tool-list change, history mutation, or (on best-effort caches) a stale replica
 *      identified by entry arithmetic — with the exact re-written tokens and cost.
 *   3. "Am I using too many calls?"→ a one-line ledger entry per user turn (auto-shown for
 *      multi-call turns) and a /cache command with the full per-call table plus actual vs
 *      counterfactual-uncached spend ("caching saved $X").
 *
 * Numbers are provider-exact (assistant-message usage) — never estimated. Display is
 * UI-only: nothing cachemire renders enters LLM context, session entries, or exports.
 * Anthropic gets the full treatment (explicit breakpoints, 5m/1h TTL, priced writes);
 * other providers degrade honestly to observed reads and soft "likely warm/cold" wording.
 */

// --- shared shapes ---------------------------------------------------------------------

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
} // USD per Mtok

export interface RequestFingerprint {
  kind: "anthropic" | "openai-responses" | "unknown";
  model?: string;
  systemHash?: string;
  toolHashes: Array<{ name: string; hash: string }>;
  messageHashes: string[];
  ttlMs?: number; // from observed cache_control: 5m default, 1h when ttl:"1h"; undefined = implicit/unknown
  /** Canonical description of the thinking/reasoning request params (e.g. "thinking budget
   * 8192", "effort high"). Anthropic documents that changing these invalidates message
   * cache breakpoints (system/tools stay cached); OpenAI's effort lives outside the
   * prompt prefix, so there it is forensic context, not a predicted break. */
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
  /** Request-start anchor (when the provider wrote/refreshed this call's cache entry);
   * `at` is response end. Absent on restored records, whose timestamps are response-ish. */
  requestAt?: number;
  gapMs?: number;
  usage: UsageLike;
  expectedRead: number;
  classification: CallClassification;
  rewroteTokens: number;
  /** Context for the first billed provider call after session compaction. */
  postCompaction?: { modelSwitched: boolean };
  costUsd?: number;
  uncachedUsd?: number; // counterfactual without caching, at this call's rates
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

const DEFAULT_CONFIG: CachemireConfig = {
  widget: true,
  turnSummary: true,
  turnSummaryMinCalls: 1, // every turn: a single-call turn omitting the line felt inconsistent
  missWarnings: true,
  missWarnUsd: 0.05,
  missWarnTokens: 20_000,
};

const TTL_SHORT_MS = 5 * 60 * 1000;
const TTL_LONG_MS = 60 * 60 * 1000;

// pi-coding-agent never passes cacheRetention to pi-ai, so pi-ai's resolveCacheRetention
// falls through to this env var alone ("long" → 1h where the model supports it, else 5m).
// Mirroring that rule lets a restored session show a definite TTL before any live request;
// the observed cache_control from the first real request replaces the inference (and also
// covers models without long-retention support).
function inferAnthropicTtlMs(env: Record<string, string | undefined> = process.env): number {
  return env.PI_CACHE_RETENTION === "long" ? TTL_LONG_MS : TTL_SHORT_MS;
}

// One cross-provider model for cache freshness. The *anchor* is universal (both Anthropic
// and OpenAI refresh on use, measured from request processing); what varies is the
// strength of the window:
//   contract — Anthropic's explicit cache_control TTL (observed from the payload, or
//              inferred for restored sessions via the same env rule pi-ai uses)
//   band     — OpenAI's documented behaviour: typically evicted after ~5–10m idle,
//              "always removed within one hour of the cache's last use" (a hard cap, so
//              past it "cold" is definite even without a TTL contract)
//   unknown  — anything else: soft language only
export type CacheWindow =
  | { kind: "contract"; ttlMs: number; source: "observed" | "inferred" }
  | { kind: "band"; softMs: number; hardMs: number }
  | { kind: "unknown" };

const OPENAI_WINDOW: CacheWindow = { kind: "band", softMs: TTL_SHORT_MS, hardMs: TTL_LONG_MS };
const UNKNOWN_WINDOW: CacheWindow = { kind: "unknown" };

function windowForProvider(provider: string | undefined): CacheWindow | undefined {
  if (provider === "anthropic") return { kind: "contract", ttlMs: inferAnthropicTtlMs(), source: "inferred" };
  if (provider !== undefined && provider.startsWith("openai")) return OPENAI_WINDOW;
  return undefined;
}

function windowLabel(window: CacheWindow): string {
  switch (window.kind) {
    case "contract":
      return `${formatDuration(window.ttlMs)} TTL${window.source === "inferred" ? " (inferred)" : ""}`;
    case "band":
      return `${formatDuration(window.softMs)}\u2013${formatDuration(window.hardMs)} window`;
    default:
      return "TTL unknown";
  }
}

/** Definitely past the window: contract TTL elapsed, or the band's documented hard cap.
 * The band's maybe-zone is deliberately not a claim — expiryCause words it only once an
 * observed miss confirms the eviction. */
function pastWindow(window: CacheWindow | undefined, gapMs: number | undefined): boolean {
  if (!window || window.kind === "unknown" || gapMs === undefined) return false;
  return gapMs > (window.kind === "contract" ? window.ttlMs : window.hardMs);
}

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

// Shared cause wording for predictions and resolved classifications.
function expiryCause(window: CacheWindow | undefined, gapMs: number | undefined): CallCause | undefined {
  if (!window || gapMs === undefined) return undefined;
  if (window.kind === "contract" && gapMs > window.ttlMs) {
    return { kind: "ttl", detail: `idle ${formatDuration(gapMs)} > ${formatDuration(window.ttlMs)} TTL` };
  }
  if (window.kind === "band") {
    if (gapMs > window.hardMs) {
      return { kind: "ttl", detail: `idle ${formatDuration(gapMs)} > ${formatDuration(window.hardMs)} cache cap` };
    }
    if (gapMs > window.softMs) {
      return { kind: "ttl", detail: `evicted after idle ${formatDuration(gapMs)} (typical window ${formatDuration(window.softMs)}\u2013${formatDuration(window.hardMs)})` };
    }
  }
  return undefined;
}
const UNKNOWN_TTL_WARM_MS = 10 * 60 * 1000; // soft "likely cold" horizon for implicit caches
const HIT_RATIO = 0.8;
const MISS_RATIO = 0.2;

// Glyphs and ink come from the family style (_lib/style.ts, design language §§1–3):
// ◍ opens every loop-economics line, ○ ● ◑ ◌ are the status scale, and all colour
// is theme-derived through ink() with raw-ANSI fallbacks before a Theme handle exists.

// --- fingerprinting --------------------------------------------------------------------

// pi moves its cache_control breakpoint to the last user message on every request, so
// breakpoints MUST be stripped before hashing or every call would diff as "history
// mutated" at the previous breakpoint.
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!isJsonObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "cache_control") continue;
    out[key] = stripCacheControl(entry);
  }
  return out;
}

function hashOf(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function findTtlMs(payload: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [];
  const system = payload.system;
  if (Array.isArray(system)) candidates.push(...system);
  const tools = payload.tools;
  if (Array.isArray(tools)) candidates.push(...tools);
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const message of messages as Array<{ content?: unknown }>) {
      if (Array.isArray(message?.content)) candidates.push(...message.content);
    }
  }
  for (const block of candidates) {
    const control = (block as { cache_control?: { type?: string; ttl?: string } })?.cache_control;
    if (control?.type === "ephemeral") return control.ttl === "1h" ? TTL_LONG_MS : TTL_SHORT_MS;
  }
  return undefined;
}

function fingerprintPayload(payload: unknown): RequestFingerprint {
  const body = isJsonObject(payload) ? payload : {};
  if (Array.isArray(body.input) || typeof body.instructions === "string") {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    return {
      kind: "openai-responses",
      model: typeof body.model === "string" ? body.model : undefined,
      systemHash: body.instructions !== undefined ? hashOf(body.instructions) : undefined,
      toolHashes: tools.map((tool) => {
        const t = tool as { name?: string; function?: { name?: string } };
        return { name: t.name ?? t.function?.name ?? "?", hash: hashOf(tool) };
      }),
      messageHashes: (Array.isArray(body.input) ? body.input : []).map((item) => hashOf(item)),
      ttlMs: undefined,
      thinking: `effort ${(body.reasoning as { effort?: string } | undefined)?.effort ?? "default"}`,
    };
  }
  if (Array.isArray(body.messages)) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    return {
      kind: "anthropic",
      model: typeof body.model === "string" ? body.model : undefined,
      systemHash: body.system !== undefined ? hashOf(stripCacheControl(body.system)) : undefined,
      toolHashes: tools.map((tool) => ({
        name: (tool as { name?: string }).name ?? "?",
        hash: hashOf(stripCacheControl(tool)),
      })),
      messageHashes: (body.messages as unknown[]).map((message) => hashOf(stripCacheControl(message))),
      ttlMs: findTtlMs(body),
      thinking: describeAnthropicThinking(body.thinking, body.output_config),
    };
  }
  return { kind: "unknown", toolHashes: [], messageHashes: [] };
}

// pi-ai puts thinking on the anthropic wire three ways: budget models get
// thinking:{type:"enabled",budget_tokens}, adaptive models (forceAdaptiveThinking) get
// thinking:{type:"adaptive"} plus output_config:{effort}, and off is {type:"disabled"}
// or absent. All three must be told apart, or effort changes diff as no-ops.
function describeAnthropicThinking(thinking: unknown, outputConfig: unknown): string {
  const t = thinking as { type?: string; budget_tokens?: number } | undefined;
  if (t?.type === "enabled") return `thinking budget ${t.budget_tokens ?? "?"}`;
  if (t?.type === "adaptive") {
    const effort = (outputConfig as { effort?: string } | undefined)?.effort;
    return effort ? `thinking effort ${effort}` : "thinking adaptive";
  }
  return "thinking off";
}

// --- forensics: name the first divergent prefix segment --------------------------------

function diffFingerprints(prev: RequestFingerprint, cur: RequestFingerprint): CallCause | undefined {
  if (prev.model && cur.model && prev.model !== cur.model) {
    return { kind: "model", detail: `model switched ${prev.model} \u2192 ${cur.model}` };
  }
  if (prev.systemHash !== cur.systemHash) {
    return { kind: "system", detail: "system prompt changed" };
  }
  const prevTools = new Map(prev.toolHashes.map((tool) => [tool.name, tool.hash]));
  const curTools = new Map(cur.toolHashes.map((tool) => [tool.name, tool.hash]));
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const [name, hash] of curTools) {
    if (!prevTools.has(name)) added++;
    else if (prevTools.get(name) !== hash) modified++;
  }
  for (const name of prevTools.keys()) if (!curTools.has(name)) removed++;
  if (added || removed || modified) {
    const parts: string[] = [];
    if (added) parts.push(`+${added} added`);
    if (removed) parts.push(`${removed} removed`);
    if (modified) parts.push(`${modified} modified`);
    return { kind: "tools", detail: `tools changed (${parts.join(", ")})` };
  }
  // Before history: a thinking change is the root cause; any history-rendering churn it
  // drags along (e.g. thinking blocks stripped on disable) is a side effect.
  if (prev.thinking !== cur.thinking) {
    return { kind: "thinking", detail: `thinking changed (${prev.thinking ?? "?"} \u2192 ${cur.thinking ?? "?"})` };
  }
  // History: the previous request's messages must be a prefix of the current ones.
  const checkable = Math.min(prev.messageHashes.length, cur.messageHashes.length);
  for (let i = 0; i < checkable; i++) {
    if (prev.messageHashes[i] !== cur.messageHashes[i]) {
      return { kind: "history", detail: `history rewritten at message ${i + 1} of ${prev.messageHashes.length}` };
    }
  }
  if (cur.messageHashes.length < prev.messageHashes.length) {
    return { kind: "history", detail: `history truncated (${prev.messageHashes.length} \u2192 ${cur.messageHashes.length} messages)` };
  }
  return undefined;
}

// --- forensics: which entry did a best-effort read hit? --------------------------------

// OpenAI's backend checkpoints cache entries at 512-token granularity: in live gpt-5.5
// sessions (the README's double-break case; session 019e9758's burst of breaks within
// seconds) every hit read exactly floor512 of an earlier call's prompt total. Matching a
// later cacheRead against stored prompt totals therefore names *which* entry the request
// hit — and a match behind the latest write is the replica-routing tell: a single cache
// could not serve an older, shorter entry between two reads of a newer, longer one. The
// public API documents 128-token increments; matching stays at the observed 512 until
// live evidence demands widening (a looser bucket would multiply coincidental matches).
const ENTRY_GRANULARITY = 512;

export interface PriorEntry { index: number; at: number; promptTokens: number }
export interface EntryMatch { index: number; ageMs: number }

function matchPriorEntry(
  cacheRead: number,
  priors: PriorEntry[],
  now: number,
  maxAgeMs: number,
): EntryMatch | undefined {
  if (cacheRead <= 0 || cacheRead % ENTRY_GRANULARITY !== 0) return undefined;
  // Newest match wins: several prompts can share a 512-token bucket, and recent entries
  // are the ones still alive. Age-gates on write time (read-refreshes are not tracked):
  // an entry older than the hard cap cannot be asserted, so the match degrades to the
  // generic unknown hint rather than naming a dead entry.
  for (let i = priors.length - 1; i >= 0; i--) {
    const prior = priors[i]!;
    if (now - prior.at > maxAgeMs) break;
    if (Math.floor(prior.promptTokens / ENTRY_GRANULARITY) * ENTRY_GRANULARITY === cacheRead) {
      return { index: prior.index, ageMs: Math.max(0, now - prior.at) };
    }
  }
  return undefined;
}

// --- classification --------------------------------------------------------------------

export interface ClassifyInput {
  isFirst: boolean;
  gapMs?: number;
  window?: CacheWindow;
  usage: UsageLike;
  expectedRead: number;
  compacted?: boolean;
  inCompaction?: boolean;
  fingerprintCause?: CallCause;
  /** The previous call re-wrote the prefix (was itself a miss/cold write). */
  prevWrote?: boolean;
  /** This read equals floor512 of an earlier call's prompt total (see matchPriorEntry). */
  entryMatch?: EntryMatch;
}

// Hint wording for a miss nothing else explains. Window-aware: under a contract TTL
// (Anthropic) an unexplained miss points at provider-side eviction. Under a best-effort
// band (OpenAI) the cache is prefix-hash routed across replicas, so an entry can simply
// be unreachable — most often right after the previous call wrote it (cacheRead 0 with a
// byte-identical early prefix means the entry was not found, not that content changed;
// a real content change would still hit the unchanged first increments).
function unknownMissDetail(args: ClassifyInput): string {
  if (args.window?.kind === "band") {
    return args.prevWrote && args.usage.cacheRead === 0
      ? "unknown (best-effort cache: fresh write not yet readable, or replica routing)"
      : "unknown (best-effort cache: replica routing or early eviction)";
  }
  return "unknown (provider-side eviction?)";
}

function classifyCall(args: ClassifyInput): CallClassification {
  if (args.inCompaction) {
    return { kind: "miss", cause: { kind: "compaction-work", detail: "compaction summarizer call" } };
  }
  if (args.isFirst || args.expectedRead <= 0) {
    return { kind: "cold", cause: { kind: "cold", detail: "cold start" } };
  }
  const ratio = args.usage.cacheRead / args.expectedRead;
  if (ratio >= HIT_RATIO) return { kind: "hit" };

  let cause: CallCause | undefined;
  const idleCause = expiryCause(args.window, args.gapMs);
  if (args.compacted) {
    cause = { kind: "compaction", detail: "compaction rewrote history" };
  } else if (args.fingerprintCause) {
    cause = pastWindow(args.window, args.gapMs)
      ? { ...args.fingerprintCause, detail: `${args.fingerprintCause.detail} (also idle past TTL)` }
      : args.fingerprintCause;
  } else if (idleCause) {
    // For a band window's "maybe" zone the observed miss is itself the confirmation:
    // the prefix was evicted within the documented typical window. An entry match refines
    // it: the newer entries were evicted, and the read fell back to a surviving older one.
    cause = args.entryMatch
      ? { ...idleCause, detail: `${idleCause.detail} \u00b7 fell back to call #${args.entryMatch.index}'s entry (${formatDuration(args.entryMatch.ageMs)} old)` }
      : idleCause;
  } else if (args.entryMatch && args.window?.kind === "band") {
    // Nothing else explains the miss, but the arithmetic names the entry it hit. Behind
    // the latest write with no idle gap, a different replica is the only consistent story.
    cause = {
      kind: "replica",
      detail: `read matches call #${args.entryMatch.index}'s entry (${formatDuration(args.entryMatch.ageMs)} old)` +
        " \u00b7 likely a different replica from the last write",
    };
  } else {
    // Rendered behind "cause: " — the detail must not restate the word.
    cause = { kind: "unknown", detail: unknownMissDetail(args) };
  }
  return { kind: ratio <= MISS_RATIO ? "miss" : "partial", cause };
}

// --- break prediction (at request time, before usage exists) ---------------------------
// Almost every break cause is knowable when the request is sent: the idle gap vs TTL,
// pi's compact events, and the payload fingerprint diff. Predicting at send time lets the
// notice sit between the user's action and the response — where the causality lives —
// and the resolved actuals replace it in place when usage arrives.

export interface BreakPrediction {
  cause: CallCause;
  /** Expected re-write size (last call's prompt). undefined when unknowable (compaction). */
  expectedRewriteTokens?: number;
  expectedUsd?: number;
}

function predictBreak(args: {
  isFirst: boolean;
  inCompaction: boolean;
  compacted: boolean;
  gapMs?: number;
  window?: CacheWindow;
  expectedRead: number;
  fingerprintCause?: CallCause;
  rates?: ModelRates;
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
    // Model switches break the cache for certain (caches are per-model on every provider)
    // but the stored size is denominated in the *old* model's tokenizer — withhold it
    // rather than show a number in the wrong currency.
    if (args.fingerprintCause.kind === "model") return { cause: args.fingerprintCause };
    if (args.fingerprintCause.kind === "thinking") {
      // Anthropic documents this break (messages invalidate; system/tools stay cached), so
      // a contract window earns an in-flight claim — unsized, because the surviving
      // system/tools share of expectedRead is unknowable. OpenAI's effort lives outside
      // the prompt prefix: no claim until usage proves a miss.
      return args.window?.kind === "contract" ? { cause: args.fingerprintCause } : undefined;
    }
    return sized(args.fingerprintCause);
  }
  // Only a *definite* expiry earns an in-flight "breaking" line: contract TTL passed, or
  // the band's hard cap passed. The band's maybe-zone stays silent — if the prefix was
  // evicted, the resolved line appears when usage proves it.
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
  return (tokens * (rates.cacheWrite || rates.input)) / 1_000_000;
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

// --- cache clock (pure state → text; tones applied by the widget layer) -----------------

export interface ClockState {
  phase: "idle" | "fresh" | "closing" | "cold" | "stale" | "fading" | "warm-unknown" | "cold-unknown";
  text: string;
}

export interface ClockInput {
  now: number;
  lastRequestAt?: number;
  window?: CacheWindow;
  cachedTokens?: number;
  rewriteUsd?: number;
  /** History was compacted since the last call: the next send re-writes regardless of TTL. */
  compacted?: boolean;
  /** Model changed since the last billed call: caches are per-model, so the cache is dead.
   * The stored size is in the old tokenizer's currency, so it is shown only with an
   * explicit old-model denomination tag (and no $, which would compound the error). */
  modelSwitched?: boolean;
  /** Currency tag for the stored size while modelSwitched: the model id that billed it. */
  oldModelId?: string;
  /** Thinking level changed since the last billed call. Material only under a contract
   * window (Anthropic documents message-breakpoint invalidation; system/tools survive). */
  thinkingChanged?: boolean;
}

function rewriteSuffix(verb: string, cachedTokens?: number, rewriteUsd?: number, qualifier = ""): string {
  if (!cachedTokens) return "";
  const bill = rewriteUsd !== undefined ? ` (~${formatUsd(rewriteUsd)})` : "";
  return ` \u00b7 next send ${verb} ~${compactCount(cachedTokens)}${qualifier}${bill}`;
}

function cacheClock(input: ClockInput): ClockState {
  if (input.lastRequestAt === undefined) return { phase: "idle", text: "" };
  if (input.modelSwitched) {
    const scale = input.cachedTokens && input.oldModelId
      ? ` (~${compactCount(input.cachedTokens)} ${input.oldModelId} tokens)`
      : "";
    return { phase: "cold", text: `cache cold \u00b7 model switched \u00b7 next send re-writes the full prompt${scale}` };
  }
  if (input.compacted) {
    // The prefix the clock was timing no longer exists; TTL is moot until the next send.
    return { phase: "stale", text: "cache stale \u00b7 history compacted \u00b7 next send re-writes the new prefix" };
  }
  const since = input.now - input.lastRequestAt;
  const window = input.window ?? UNKNOWN_WINDOW;
  if (input.thinkingChanged && window.kind === "contract") {
    // No survival promise here: docs say system/tools outlive *budget* changes, but a
    // live adaptive-effort change on claude-fable-5 re-wrote 100% of the prompt.
    return { phase: "stale", text: "cache stale \u00b7 thinking level changed \u00b7 next send re-writes the prompt" };
  }
  if (window.kind === "contract") {
    const remaining = window.ttlMs - since;
    if (remaining <= 0) {
      return { phase: "cold", text: `cache cold${rewriteSuffix("re-writes", input.cachedTokens, input.rewriteUsd)}` };
    }
    // Coarse display above 90s so the widget only re-renders when the label changes.
    const display = remaining > 90_000 ? Math.floor(remaining / 15_000) * 15_000 : remaining;
    return {
      phase: remaining <= 60_000 ? "closing" : "fresh",
      text: `cache ${formatDuration(display)}`,
    };
  }
  if (window.kind === "band") {
    if (since > window.hardMs) {
      // The hard cap is documented ("always removed within one hour of last use"), so
      // past it "cold" is definite even without a per-request TTL contract.
      const suffix = rewriteSuffix("re-sends", input.cachedTokens, input.rewriteUsd, " uncached");
      return { phase: "cold", text: `cache cold (idle ${formatDuration(since)} > ${formatDuration(window.hardMs)} cap)${suffix}` };
    }
    if (since > window.softMs) {
      const suffix = rewriteSuffix("may re-send", input.cachedTokens, input.rewriteUsd);
      return {
        phase: "fading",
        text: `cache fading \u00b7 idle ${formatDuration(since)} of ${formatDuration(window.softMs)}\u2013${formatDuration(window.hardMs)} window${suffix}`,
      };
    }
    return { phase: "warm-unknown", text: `cache likely warm \u00b7 ${formatDuration(since)} since last call` };
  }
  // Unknown window: no contract, only soft language — but past the soft horizon we still
  // know exactly how much prompt would be re-sent uncached.
  if (since > UNKNOWN_TTL_WARM_MS) {
    const suffix = rewriteSuffix("re-sends", input.cachedTokens, input.rewriteUsd, " uncached");
    return { phase: "cold-unknown", text: `cache likely cold (idle ${formatDuration(since)})${suffix}` };
  }
  return { phase: "warm-unknown", text: `cache likely warm \u00b7 ${formatDuration(since)} since last call` };
}

// --- aborted sends ----------------------------------------------------------------------

/** Settle the clock anchor for a send that ended without billed usage (abort or error).
 * before_provider_request moves the anchor to the in-flight request optimistically —
 * right for every send whose usage arrives, including mid-stream aborts (Anthropic
 * delivers prompt-side usage in message_start, which survives an abort). What lands here
 * is the remainder: fast aborts and errors where usage never arrived, so nothing proves
 * the provider processed — and so refreshed or wrote — the prefix (on a first send there
 * may be no entry at all). The anchor rolls back to the last billed request, the only
 * provider-confirmed refresh; a first-send abort clears it outright (the clock hides).
 * If the aborted send did touch the cache after all, the next call resolves green
 * ("cache held") — the same correction path as any wrong prediction. */
function settleDanglingSend(state: {
  pendingRequestAt?: number;
  prevCallRequestAt?: number;
  lastRequestAt?: number;
}): { changed: boolean; lastRequestAt?: number } {
  if (state.pendingRequestAt === undefined) return { changed: false, lastRequestAt: state.lastRequestAt };
  return { changed: true, lastRequestAt: state.prevCallRequestAt };
}

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

// --- ledger restore (so --continue sessions keep their totals) --------------------------

function restoreFromMessages(messages: Array<Record<string, unknown>>): CallRecord[] {
  const records: CallRecord[] = [];
  let previousAt: number | undefined;
  let expectedRead = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = message.usage as UsageLike | undefined;
    if (!usage || (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0)) continue;
    const at = typeof message.timestamp === "number" ? message.timestamp : 0;
    const isFirst = records.length === 0;
    const classification = classifyCall({
      isFirst,
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
  prevFingerprint?: RequestFingerprint;
  pendingFingerprint?: RequestFingerprint;
  pendingRequestAt?: number;
  prevCallRequestAt?: number;
  lastRequestAt?: number;
  window: CacheWindow;
  /** Model id at the time of the last billed call — the currency of cachedTokens. */
  lastCallModelId?: string;
  currentModelId?: string;
  modelSwitched: boolean;
  /** Thinking level at the last billed call vs now; mirrors the model-switch pair. */
  lastCallThinkingLevel?: string;
  currentThinkingLevel?: string;
  thinkingChanged: boolean;
  expectedRead: number;
  cachedTokens?: number;
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
  /** Records before this index belong to a dead cache lineage (pre-compaction, or before
   * a model/system/tools/history/thinking change): entries the current prefix cannot
   * read, so entry matching never names them. */
  lineageStart: number;
  /** In-flight break notice placed at request time; resolved in place when usage arrives. */
  pendingNotice?: Text;
  run?: RunAggregate;
  /** Theme handle (captured at session_start) — all chat/widget ink flows through ink(). */
  theme?: Theme;
  ui?: Pick<ExtensionUIContext, "setWidget" | "notify">;
  tui?: { requestRender?: (force?: boolean) => void };
  lastWidgetText?: string;
}

type CachemireGlobal = typeof globalThis & {
  __piCachemire?: CachemireState;
  __piCachemireTimer?: ReturnType<typeof setInterval>;
};
const g = globalThis as CachemireGlobal;

function state(): CachemireState {
  if (!g.__piCachemire) {
    g.__piCachemire = {
      config: DEFAULT_CONFIG,
      records: [],
      window: UNKNOWN_WINDOW,
      modelSwitched: false,
      thinkingChanged: false,
      expectedRead: 0,
      compacted: false,
      inCompaction: false,
      anchored: [],
      lineageStart: 0,
    };
  }
  return g.__piCachemire;
}

function toneFor(phase: ClockState["phase"]): Tone {
  switch (phase) {
    case "fresh":
    case "warm-unknown":
      return "success";
    case "closing":
      return "warning";
    default: // cold, stale, cold-unknown, idle
      return "dim";
  }
}

// One-line loop-economics facts (design language §§1, 6): ◍ opens the line; the status
// tone is theme-derived. These are transient signals, so the tone covers the whole line.
function econLine(tone: Tone, text: string): string {
  return ink(state().theme, tone, `${GLYPH.econ} ${text}`);
}

function updateWidget(now = Date.now()): void {
  const s = state();
  if (!s.ui || !s.config.widget) return;
  const clock = cacheClock({
    now,
    lastRequestAt: s.lastRequestAt,
    window: s.window,
    cachedTokens: s.cachedTokens,
    rewriteUsd: s.cachedTokens !== undefined ? rewriteCostUsd(s.cachedTokens, s.rates) : undefined,
    compacted: s.compacted,
    modelSwitched: s.modelSwitched,
    oldModelId: s.lastCallModelId,
    thinkingChanged: s.thinkingChanged,
  });
  const text = clock.phase === "idle" ? "" : econLine(toneFor(clock.phase), clock.text);
  if (text === s.lastWidgetText) return;
  s.lastWidgetText = text;
  s.ui.setWidget("pi-cachemire", text === "" ? undefined : [text]);
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

// --- extension entry --------------------------------------------------------------------

export default function piCachemire(pi: ExtensionAPI): void {
  const s = state();

  pi.on("session_start", async (_event, ctx) => {
    s.config = loadConfig(process.cwd());
    const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    s.records = restoreFromMessages(messages as unknown as Array<Record<string, unknown>>);
    let restoredModelId: string | undefined;
    for (let i = messages.length - 1; i >= 0 && restoredModelId === undefined; i--) {
      const message = messages[i]!;
      if (message.role === "assistant") restoredModelId = message.model;
    }
    const model = ctx.model;
    if (model) {
      s.rates = model.cost;
      s.currentModelId = model.id;
      s.modelLabel = `${model.provider}/${model.id}`;
    }
    // Settings restore with the session, so the current level stands in for the level of
    // the session's last billed call. Note: getThinkingLevel lives on the runtime API
    // (`pi`), not the per-event ctx (contract-pinned in tests/contract).
    s.lastCallThinkingLevel = s.currentThinkingLevel = pi.getThinkingLevel();
    // Restored sessions get the provider's real freshness window immediately (anthropic:
    // inferred contract TTL; openai: documented band); the first live request's observed
    // payload replaces the inference.
    if (s.window.kind === "unknown") s.window = windowForProvider(model?.provider) ?? UNKNOWN_WINDOW;
    if (s.records.length > 0) {
      const last = s.records[s.records.length - 1]!;
      s.expectedRead = last.usage.input + last.usage.cacheRead + last.usage.cacheWrite;
      s.cachedTokens = s.expectedRead;
      // Message timestamps are response-end-ish; the true TTL anchor (request processing
      // start) is slightly earlier, so this is marginally optimistic — irrelevant at the
      // hours-scale gaps where restore matters.
      s.lastRequestAt = last.at || undefined;
      s.prevCallRequestAt = last.at || undefined;
      // Caches are per-model: a restored session resumed under a different model is cold,
      // and cachedTokens is denominated in the old model's tokenizer.
      s.lastCallModelId = restoredModelId ?? s.lastCallModelId;
      s.modelSwitched = s.lastCallModelId !== undefined && model?.id !== undefined && s.lastCallModelId !== model.id;
      // Restored under a different model: the restored entries are unreadable (caches are
      // per-model), so they are out of lineage for entry matching from the start.
      if (s.modelSwitched) s.lineageStart = s.records.length;
    }
    if (!ctx.hasUI) return;
    s.ui = ctx.ui;
    s.theme = ctx.ui.theme;
    captureTui(ctx.ui, "__pi_cachemire_capture", (tui) => {
      s.tui = tui as CachemireState["tui"];
    });
    if (g.__piCachemireTimer) clearInterval(g.__piCachemireTimer);
    g.__piCachemireTimer = s.config.widget ? setInterval(() => updateWidget(), 1000) : undefined;
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    if (g.__piCachemireTimer) clearInterval(g.__piCachemireTimer);
    g.__piCachemireTimer = undefined;
  });

  pi.on("before_provider_request", async (event) => {
    s.pendingFingerprint = fingerprintPayload(event.payload);
    s.pendingRequestAt = Date.now();
    // TTL anchor = request start: providers read/refresh/write cache entries while
    // processing the request input (entries become available once the response *begins*),
    // so the freshness window burns during generation — a long thinking block eats into it.
    s.lastRequestAt = s.pendingRequestAt;
    // Observation is authoritative per provider kind: anthropic payloads carry the real
    // cache_control TTL; openai-responses requests get the documented eviction band.
    if (s.pendingFingerprint.kind === "anthropic") {
      s.window = s.pendingFingerprint.ttlMs !== undefined
        ? { kind: "contract", ttlMs: s.pendingFingerprint.ttlMs, source: "observed" }
        : UNKNOWN_WINDOW; // cacheRetention "none": no breakpoints were sent
      s.providerLabel = "anthropic";
    } else if (s.pendingFingerprint.kind === "openai-responses") {
      s.window = OPENAI_WINDOW;
      s.providerLabel = "openai";
    }

    // Place the break notice where the causality lives: between the user's action and the
    // response. It shows the expectation now and is resolved in place when usage arrives.
    if (s.config.missWarnings) {
      const prediction = predictBreak({
        isFirst: s.records.length === 0,
        inCompaction: s.inCompaction,
        compacted: s.compacted,
        gapMs: s.prevCallRequestAt !== undefined ? s.pendingRequestAt - s.prevCallRequestAt : undefined,
        window: s.window,
        expectedRead: s.expectedRead,
        fingerprintCause: s.prevFingerprint ? diffFingerprints(s.prevFingerprint, s.pendingFingerprint) : undefined,
        rates: s.rates,
      });
      const material = prediction !== undefined && (
        prediction.expectedRewriteTokens === undefined || // unsized (compaction/model/thinking): explicit user action, the notice is its explanation
        prediction.expectedRewriteTokens >= s.config.missWarnTokens ||
        (prediction.expectedUsd ?? 0) >= s.config.missWarnUsd
      );
      if (material) {
        const text = econLine("warning", renderBreakingLine(prediction));
        if (s.pendingNotice) s.pendingNotice.setText(text); // provider retry: reuse the line
        else s.pendingNotice = appendChatLine(text);
      }
    }
    updateWidget();
  });

  pi.on("model_select", async (event) => {
    const model = event.model;
    s.rates = model.cost;
    s.modelLabel = `${model.provider}/${model.id}`;
    s.currentModelId = model.id;
    // Caches are per-model on every provider; the stored token count is also in the old
    // tokenizer's currency. Switching back before the next call revives both.
    s.modelSwitched = s.lastCallModelId !== undefined && model.id !== s.lastCallModelId;
    // Keep the freshness window honest across provider switches until the next
    // observation lands; an anthropic TTL observed from a live payload stays valid.
    if (!(model.provider === "anthropic" && s.window.kind === "contract" && s.window.source === "observed")) {
      s.window = windowForProvider(model.provider) ?? UNKNOWN_WINDOW;
    }
    updateWidget();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
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
    s.run = { startedAt: Date.now(), calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };
  });

  pi.on("session_before_compact", async () => {
    s.inCompaction = true;
  });

  pi.on("session_compact", async () => {
    s.inCompaction = false;
    s.compacted = true;
  });

  pi.on("message_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const usage = message.usage;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) return;
    const now = Date.now();
    // Idle gap between the previous request (which refreshed the TTL) and this one.
    const requestAt = s.pendingRequestAt ?? now;
    const gapMs = s.prevCallRequestAt !== undefined ? requestAt - s.prevCallRequestAt : undefined;

    const fingerprintCause = s.prevFingerprint && s.pendingFingerprint
      ? diffFingerprints(s.prevFingerprint, s.pendingFingerprint)
      : undefined;
    // Any invalidating change re-keys the cache: records before it are a dead lineage
    // whose entries this prefix cannot read, and a 512-bucket collision with one would
    // name an unreadable entry. Conservative on purpose — a mutation that happened to
    // leave the cache warm still advances the boundary (false negatives degrade to the
    // generic unknown hint; false positives would be dishonest).
    if (s.compacted || fingerprintCause) s.lineageStart = s.records.length;
    // Entry ages use the request-start anchor (entries are written/refreshed during
    // request processing); restored records fall back to their response-ish message
    // timestamp — marginally optimistic, same caveat as the restore-time TTL anchor.
    const entryMatch = s.window.kind === "band"
      ? matchPriorEntry(
          usage.cacheRead,
          s.records.slice(s.lineageStart).map((record) => ({ index: record.index, at: record.requestAt ?? record.at, promptTokens: promptTokens(record.usage) })),
          requestAt,
          s.window.hardMs,
        )
      : undefined;
    const classification = classifyCall({
      isFirst: s.records.length === 0,
      gapMs,
      window: s.window,
      usage,
      expectedRead: s.expectedRead,
      compacted: s.compacted,
      inCompaction: s.inCompaction,
      fingerprintCause,
      prevWrote: ["miss", "cold", "partial"].includes(s.records.at(-1)?.classification.kind ?? ""),
      entryMatch,
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
      postCompaction: s.compacted ? { modelSwitched: s.modelSwitched } : undefined,
      costUsd: usage.cost.total,
      uncachedUsd: uncachedCostUsd(usage, s.rates),
    };
    s.records.push(record);
    s.compacted = false;
    s.prevFingerprint = s.pendingFingerprint ?? s.prevFingerprint;
    s.prevCallRequestAt = requestAt;
    // Usage arrived: the anchor this request claimed at send time is provider-confirmed.
    // Consume the pending pair — whatever is still pending at agent_end never got usage.
    s.pendingFingerprint = undefined;
    s.pendingRequestAt = undefined;
    s.expectedRead = usage.input + usage.cacheRead + usage.cacheWrite;
    s.cachedTokens = s.expectedRead;
    // Fresh usage re-baselines the currency: counts are now denominated in this model.
    s.lastCallModelId = s.currentModelId ?? s.lastCallModelId;
    s.modelSwitched = false;
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
      // Unpredicted break (e.g. provider-side eviction): append at resolution time.
      appendChatLine(econLine("warning", renderMissLine(record)));
    }
    updateWidget(now);
  });

  pi.on("agent_end", async () => {
    // A notice whose call never produced usage (abort/error) must not dangle as "breaking".
    resolveNotice(econLine("dim", "cache \u00b7 send ended without usage (aborted?) \u00b7 outcome unknown"));
    // Same honesty for the clock: a send that never produced usage must not keep the TTL
    // anchor it optimistically claimed at request start — a fast abort can cancel before
    // the provider ever touched the cache, and the countdown would then be fiction.
    const settled = settleDanglingSend(s);
    if (settled.changed) {
      s.lastRequestAt = settled.lastRequestAt;
      s.pendingRequestAt = undefined;
      s.pendingFingerprint = undefined;
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
      if (!ctx.hasUI) return;
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
  stripCacheControl,
  fingerprintPayload,
  inferAnthropicTtlMs,
  wireThinkingEffort,
  thinkingLevelsDiffer,
  windowForProvider,
  windowLabel,
  pastWindow,
  expiryCause,
  OPENAI_WINDOW,
  UNKNOWN_WINDOW,
  predictBreak,
  renderBreakingLine,
  renderHeldLine,
  diffFingerprints,
  matchPriorEntry,
  classifyCall,
  settleDanglingSend,
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
  renderRunSummary,
  renderMissLine,
  renderLedger,
  restoreFromMessages,
  loadConfig,
  DEFAULT_CONFIG,
};
