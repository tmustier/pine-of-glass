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

export function pastWindow(window: CacheWindow | undefined, gapMs: number | undefined): boolean {
  if (!window || gapMs === undefined) return false;
  if (window.kind === "contract") return gapMs >= window.ttlMs;
  if (window.kind === "maximum") return gapMs >= window.maxMs;
  return false;
}

// Shared cause wording for predictions and resolved classifications.
export function expiryCause(window: CacheWindow | undefined, gapMs: number | undefined): CallCause | undefined {
  if (!window || gapMs === undefined) return undefined;
  if (window.kind === "contract" && gapMs >= window.ttlMs) {
    return { kind: "ttl", detail: `${formatDuration(window.ttlMs)} TTL reached after ${formatDuration(gapMs)} idle` };
  }
  if (window.kind === "maximum" && gapMs >= window.maxMs) {
    return { kind: "ttl", detail: `${formatDuration(window.maxMs)} retention maximum reached after ${formatDuration(gapMs)} idle` };
  }
  return undefined;
}
const HIT_RATIO = 0.8;
const MISS_RATIO = 0.2;

// --- fingerprinting --------------------------------------------------------------------

// Pi moves Anthropic and Bedrock breakpoints as the conversation grows. They are
// placement metadata, not prompt mutations.
function stripCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isJsonObject(entry) || !isJsonObject(entry.cachePoint) ||
        entry.cachePoint.type !== "default" || Object.keys(entry).length !== 1)
      .map(stripCacheMarkers);
  }
  if (!isJsonObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "cache_control") out[key] = stripCacheMarkers(entry);
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
    const toolConfig = isJsonObject(body.toolConfig) ? body.toolConfig : undefined;
    const tools = Array.isArray(body.tools)
      ? body.tools
      : Array.isArray(toolConfig?.tools) ? toolConfig.tools : [];
    const additional = isJsonObject(body.additionalModelRequestFields)
      ? body.additionalModelRequestFields
      : undefined;
    return {
      kind: "anthropic",
      model: typeof body.model === "string"
        ? body.model
        : typeof body.modelId === "string" ? body.modelId : undefined,
      systemHash: body.system !== undefined ? hashOf(stripCacheMarkers(body.system)) : undefined,
      toolHashes: tools.map((tool) => {
        const value = tool as { name?: string; toolSpec?: { name?: string } };
        return { name: value.name ?? value.toolSpec?.name ?? "?", hash: hashOf(stripCacheMarkers(tool)) };
      }),
      messageHashes: (body.messages as unknown[]).map((message) => hashOf(stripCacheMarkers(message))),
      ttlMs: findTtlMs(body),
      thinking: describeAnthropicThinking(
        body.thinking ?? additional?.thinking,
        body.output_config ?? additional?.output_config,
      ),
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
    const expiry = args.window?.kind === "maximum"
      ? "retention maximum reached"
      : "TTL reached";
    cause = pastWindow(args.window, args.gapMs)
      ? { ...args.fingerprintCause, detail: `${args.fingerprintCause.detail} (also ${expiry})` }
      : args.fingerprintCause;
  } else if (idleCause) {
    cause = idleCause;
  } else {
    cause = { kind: "unknown", detail: "unknown (provider did not expose why)" };
  }
  return { kind: ratio <= MISS_RATIO ? "miss" : "partial", cause };
}
