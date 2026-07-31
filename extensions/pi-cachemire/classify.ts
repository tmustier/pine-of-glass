// Send-time forensics: payload fingerprinting, the first-divergence diff that names a
// break's cause, best-effort entry matching, and the resolved-call classification
// ladder. Everything here reasons from observed evidence (payloads, usage, windows);
// the wording rules live in the design language (§7) and render.ts speaks them.

import { createHash } from "node:crypto";
import { isJsonObject } from "../_lib/boundary.ts";
import { formatDuration } from "../_lib/fmt.ts";
import type {
  CacheWindow,
  CallCause,
  CallClassification,
  RequestFingerprint,
  UsageLike,
} from "./types.ts";

// Anthropic's two contract retentions; the wire's cache_control ttl names which one.
export const TTL_SHORT_MS = 5 * 60 * 1000;
export const TTL_LONG_MS = 60 * 60 * 1000;

/** Definitely past the window: contract TTL elapsed, or the band's documented hard cap.
 * The band's maybe-zone is deliberately not a claim — expiryCause words it only once an
 * observed miss confirms the eviction. */
export function pastWindow(window: CacheWindow | undefined, gapMs: number | undefined): boolean {
  if (!window || window.kind === "unknown" || gapMs === undefined) return false;
  return gapMs > (window.kind === "contract" ? window.ttlMs : window.hardMs);
}

// Shared cause wording for predictions and resolved classifications.
export function expiryCause(window: CacheWindow | undefined, gapMs: number | undefined): CallCause | undefined {
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
const HIT_RATIO = 0.8;
const MISS_RATIO = 0.2;

// --- fingerprinting --------------------------------------------------------------------

// pi moves its cache_control breakpoint to the last user message on every request, so
// breakpoints MUST be stripped before hashing or every call would diff as "history
// mutated" at the previous breakpoint.
export function stripCacheControl(value: unknown): unknown {
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

export function fingerprintPayload(payload: unknown): RequestFingerprint {
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

export function diffFingerprints(prev: RequestFingerprint, cur: RequestFingerprint): CallCause | undefined {
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

export function matchPriorEntry(
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
  /** expectedRead is denominated in a previous model's tokenizer (model switch). */
  modelSwitched?: boolean;
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

export function classifyCall(args: ClassifyInput): CallClassification {
  if (args.inCompaction) {
    return { kind: "miss", cause: { kind: "compaction-work", detail: "compaction summarizer call" } };
  }
  if (args.isFirst || args.expectedRead <= 0) {
    return { kind: "cold", cause: { kind: "cold", detail: "cold start" } };
  }
  // After a model switch the stored expectation is in the previous model's currency;
  // this call's own prompt is the only same-currency denominator, so the ratio becomes
  // "how much of this prompt was already cached".
  const expected = args.modelSwitched
    ? args.usage.input + args.usage.cacheRead + args.usage.cacheWrite
    : args.expectedRead;
  const ratio = expected > 0 ? args.usage.cacheRead / expected : 0;
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

