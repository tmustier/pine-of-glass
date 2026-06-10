import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi-cachemire — explains the cache and loop economics of a pi session.
 *
 * pi's footer already *counts* (input/output/cache read/write/cost); cachemire *explains*:
 *   1. "Am I past TTL?"            → a live cache clock above the editor, counting down the
 *      provider cache TTL from the last request, with the re-write bill once likely cold.
 *   2. "Why did the cache break?"  → forensics: every provider request is fingerprinted
 *      (system / tools / history segments, cache_control stripped); on a miss the diff
 *      names the culprit — TTL expiry, compaction, model switch, system prompt edit,
 *      tool-list change, or history mutation — with the exact re-written tokens and cost.
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
  totalTokens?: number;
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
}

export type CauseKind =
  | "cold" | "ttl" | "compaction" | "compaction-work" | "model" | "system" | "tools"
  | "history" | "restored" | "unknown";

export interface CallCause { kind: CauseKind; detail: string }

export interface CallClassification {
  kind: "cold" | "hit" | "partial" | "miss";
  cause?: CallCause;
}

export interface CallRecord {
  index: number;
  at: number;
  gapMs?: number;
  usage: UsageLike;
  expectedRead: number;
  classification: CallClassification;
  rewroteTokens: number;
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

export const DEFAULT_CONFIG: CachemireConfig = {
  widget: true,
  turnSummary: true,
  turnSummaryMinCalls: 2,
  missWarnings: true,
  missWarnUsd: 0.05,
  missWarnTokens: 20_000,
};

const TTL_SHORT_MS = 5 * 60 * 1000;
const TTL_LONG_MS = 60 * 60 * 1000;
const UNKNOWN_TTL_WARM_MS = 10 * 60 * 1000; // soft "likely cold" horizon for implicit caches
const HIT_RATIO = 0.8;
const MISS_RATIO = 0.2;

// --- ANSI (family style: raw SGR like pi-traceline) ------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MUTED_GREY = "\x1b[38;2;128;128;128m";
const GLYPH = "\u25cd"; // ◍

// --- fingerprinting --------------------------------------------------------------------

// pi moves its cache_control breakpoint to the last user message on every request, so
// breakpoints MUST be stripped before hashing or every call would diff as "history
// mutated" at the previous breakpoint.
export function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "cache_control") continue;
      out[key] = stripCacheControl(entry);
    }
    return out;
  }
  return value;
}

function hashOf(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
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
  const body = (payload ?? {}) as Record<string, unknown>;
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
    };
  }
  return { kind: "unknown", toolHashes: [], messageHashes: [] };
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
  ttlMs?: number;
  usage: UsageLike;
  expectedRead: number;
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
  const ratio = args.usage.cacheRead / args.expectedRead;
  if (ratio >= HIT_RATIO) return { kind: "hit" };

  let cause: CallCause | undefined;
  const pastTtl = args.ttlMs !== undefined && args.gapMs !== undefined && args.gapMs > args.ttlMs;
  if (args.compacted) {
    cause = { kind: "compaction", detail: "compaction rewrote history" };
  } else if (args.fingerprintCause) {
    cause = pastTtl
      ? { ...args.fingerprintCause, detail: `${args.fingerprintCause.detail} (also idle past TTL)` }
      : args.fingerprintCause;
  } else if (pastTtl) {
    cause = { kind: "ttl", detail: `idle ${formatDuration(args.gapMs!)} > ${formatDuration(args.ttlMs!)} TTL` };
  } else {
    cause = { kind: "unknown", detail: "cause unknown (provider-side eviction?)" };
  }
  return { kind: ratio <= MISS_RATIO ? "miss" : "partial", cause };
}

// --- economics -------------------------------------------------------------------------

export function uncachedCostUsd(usage: UsageLike, rates?: ModelRates): number | undefined {
  if (!rates) return undefined;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return (inputTokens * rates.input + usage.output * rates.output) / 1_000_000;
}

export function rewriteCostUsd(tokens: number, rates?: ModelRates): number | undefined {
  if (!rates) return undefined;
  return (tokens * (rates.cacheWrite || rates.input)) / 1_000_000;
}

export function sessionSavings(records: CallRecord[]): { actual: number; uncached: number; saved: number; pct: number } | undefined {
  const usable = records.filter((record) => record.costUsd !== undefined && record.uncachedUsd !== undefined);
  if (usable.length === 0) return undefined;
  const actual = usable.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  const uncached = usable.reduce((sum, record) => sum + (record.uncachedUsd ?? 0), 0);
  if (uncached <= 0) return undefined;
  return { actual, uncached, saved: uncached - actual, pct: (1 - actual / uncached) * 100 };
}

// --- formatting ------------------------------------------------------------------------

export function formatTokensK(value: number): string {
  if (!Number.isFinite(value)) return "?";
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

export function formatUsd(value: number): string {
  return value >= 0.10 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}m${rest.toString().padStart(2, "0")}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

// --- cache clock (pure state → text; tones applied by the widget layer) -----------------

export interface ClockState {
  phase: "idle" | "fresh" | "closing" | "cold" | "warm-unknown" | "cold-unknown";
  text: string;
}

export interface ClockInput {
  now: number;
  lastRequestAt?: number;
  ttlMs?: number;
  cachedTokens?: number;
  rewriteUsd?: number;
}

export function cacheClock(input: ClockInput): ClockState {
  if (input.lastRequestAt === undefined) return { phase: "idle", text: "" };
  const since = input.now - input.lastRequestAt;
  if (input.ttlMs === undefined) {
    // Implicit caching (OpenAI etc.): no contract, only soft language.
    if (since > UNKNOWN_TTL_WARM_MS) {
      return { phase: "cold-unknown", text: `cache likely cold (idle ${formatDuration(since)})` };
    }
    return { phase: "warm-unknown", text: `cache likely warm \u00b7 ${formatDuration(since)} since last call` };
  }
  const remaining = input.ttlMs - since;
  if (remaining <= 0) {
    const size = input.cachedTokens ? ` \u00b7 next send re-writes ~${formatTokensK(input.cachedTokens)}` : "";
    const bill = input.rewriteUsd !== undefined ? ` (~${formatUsd(input.rewriteUsd)})` : "";
    return { phase: "cold", text: `cache cold${size}${bill}` };
  }
  // Coarse display above 90s so the widget only re-renders when the label changes.
  const display = remaining > 90_000 ? Math.floor(remaining / 15_000) * 15_000 : remaining;
  return {
    phase: remaining <= 60_000 ? "closing" : "fresh",
    text: `cache ${formatDuration(display)}`,
  };
}

// --- ledger lines ----------------------------------------------------------------------

export function renderRunSummary(run: RunAggregate, endedAt: number): string {
  const promptTokens = run.input + run.cacheRead;
  const cachedPct = promptTokens > 0 ? (run.cacheRead / promptTokens) * 100 : 0;
  const parts = [
    `turn: ${run.calls} calls`,
    formatDuration(endedAt - run.startedAt),
    `read ${formatTokensK(run.cacheRead)} (${cachedPct.toFixed(1)}% cached)`,
    `wrote ${formatTokensK(run.cacheWrite)}`,
    `out ${formatTokensK(run.output)}`,
  ];
  if (run.costUsd > 0) parts.push(formatUsd(run.costUsd));
  return parts.join(" \u00b7 ");
}

export function renderMissLine(record: CallRecord): string {
  const what = record.classification.kind === "partial"
    ? `cache partial \u00b7 read ${formatTokensK(record.usage.cacheRead)} of ${formatTokensK(record.expectedRead)}`
    : `cache broke \u00b7 re-wrote ${formatTokensK(record.rewroteTokens)}${record.costUsd !== undefined ? ` (${formatUsd(record.costUsd)})` : ""}`;
  return `${what} \u00b7 cause: ${record.classification.cause?.detail ?? "unknown"}`;
}

const EVENT_GLYPHS: Record<CallClassification["kind"], string> = {
  cold: "\u25cb", // ○
  hit: "\u25cf", // ●
  partial: "\u25d1", // ◑
  miss: "\u25cc", // ◌
};

export function renderLedger(
  records: CallRecord[],
  options: { providerLabel?: string; ttlMs?: number; modelLabel?: string } = {},
): string[] {
  const profile: string[] = [];
  if (options.providerLabel) profile.push(options.providerLabel);
  profile.push(options.ttlMs !== undefined ? `${formatDuration(options.ttlMs)} TTL` : "TTL unknown");
  if (options.modelLabel) profile.push(options.modelLabel);
  const lines: string[] = [`Cachemire \u2014 cache & loop ledger   ${profile.join(" \u00b7 ")}`];
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
      ` ${col(formatTokensK(usage.input), 8)} ${col(formatTokensK(usage.cacheRead), 8)}` +
      ` ${col(formatTokensK(usage.cacheWrite), 8)} ${col(formatTokensK(usage.output), 7)}` +
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
    `  totals: ${totals.calls} calls \u00b7 input ${formatTokensK(totals.input)} \u00b7 read ${formatTokensK(totals.read)}` +
    ` \u00b7 wrote ${formatTokensK(totals.wrote)} \u00b7 out ${formatTokensK(totals.out)} \u00b7 ${formatUsd(totals.cost)}`,
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

export function restoreFromMessages(messages: Array<Record<string, unknown>>): CallRecord[] {
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
      fingerprintCause: undefined,
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

function readConfigFile(filePath: string): Partial<CachemireConfig> | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(cwd: string): CachemireConfig {
  return {
    ...DEFAULT_CONFIG,
    ...readConfigFile(join(homedir(), ".pi", "agent", "pi-cachemire.json")),
    ...readConfigFile(join(cwd, ".pi", "pi-cachemire.json")),
  };
}

// --- chat scrollback append (display-only; never touches LLM context) -------------------
// ctx.ui.notify force-dims and replaces consecutive status lines, so ledger lines are
// appended straight to pi's chat container (found structurally, like pi-traceline).

function isChatRow(component: unknown): boolean {
  const c = component as { setHideThinkingBlock?: unknown; setExpanded?: unknown; toolName?: unknown };
  if (!c || typeof c !== "object") return false;
  if (typeof c.setHideThinkingBlock === "function") return true; // assistant row
  return typeof c.setExpanded === "function" && "toolName" in c; // tool row
}

function findChat(node: unknown, seen = new Set<unknown>()): { children: unknown[]; addChild?: (c: unknown) => void } | undefined {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  const kids = (node as { children?: unknown[] }).children;
  if (Array.isArray(kids)) {
    if (kids.some(isChatRow)) return node as { children: unknown[]; addChild?: (c: unknown) => void };
    for (const kid of kids) {
      const found = findChat(kid, seen);
      if (found) return found;
    }
  }
  return undefined;
}

// --- live state ------------------------------------------------------------------------

interface CachemireState {
  config: CachemireConfig;
  records: CallRecord[];
  prevFingerprint?: RequestFingerprint;
  pendingFingerprint?: RequestFingerprint;
  pendingRequestAt?: number;
  prevCallRequestAt?: number;
  lastRequestAt?: number;
  ttlMs?: number;
  expectedRead: number;
  cachedTokens?: number;
  rates?: ModelRates;
  modelLabel?: string;
  providerLabel?: string;
  compacted: boolean;
  inCompaction: boolean;
  run?: RunAggregate;
  ui?: {
    setWidget: (key: string, content: string[] | undefined) => void;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
  };
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
      expectedRead: 0,
      compacted: false,
      inCompaction: false,
    };
  }
  return g.__piCachemire;
}

function toneFor(phase: ClockState["phase"]): string {
  switch (phase) {
    case "fresh":
    case "warm-unknown":
      return GREEN;
    case "closing":
      return YELLOW;
    default:
      return MUTED_GREY;
  }
}

function updateWidget(now = Date.now()): void {
  const s = state();
  if (!s.ui || !s.config.widget) return;
  const clock = cacheClock({
    now,
    lastRequestAt: s.lastRequestAt,
    ttlMs: s.ttlMs,
    cachedTokens: s.cachedTokens,
    rewriteUsd: s.cachedTokens !== undefined ? rewriteCostUsd(s.cachedTokens, s.rates) : undefined,
  });
  const text = clock.phase === "idle" ? "" : `${toneFor(clock.phase)}${GLYPH} ${clock.text}${RESET}`;
  if (text === s.lastWidgetText) return;
  s.lastWidgetText = text;
  s.ui.setWidget("pi-cachemire", text === "" ? undefined : [text]);
}

function appendChatLine(text: string): void {
  const s = state();
  const chat = s.tui ? findChat(s.tui) : undefined;
  if (chat?.addChild) {
    try {
      chat.addChild(new Spacer(1));
      chat.addChild(new Text(text, 1, 0));
      s.tui?.requestRender?.(true);
      return;
    } catch {
      // fall through to notify
    }
  }
  s.ui?.notify(text.replace(/\u001b\[[0-9;]*m/g, ""), "info");
}

// --- extension entry --------------------------------------------------------------------

export default function piCachemire(pi: ExtensionAPI): void {
  const s = state();

  pi.on("session_start", async (_event, ctx) => {
    s.config = loadConfig(process.cwd());
    try {
      const manager = ctx.sessionManager as { getEntries?: () => unknown[]; getLeafId?: () => string | null };
      const entries = manager.getEntries?.() ?? [];
      const { messages } = buildSessionContext(entries as never, manager.getLeafId?.());
      s.records = restoreFromMessages(messages as unknown as Array<Record<string, unknown>>);
    } catch {
      s.records = [];
    }
    const model = ctx.model as { id?: string; provider?: string; cost?: ModelRates } | undefined;
    if (model?.cost) s.rates = model.cost;
    if (model?.id) s.modelLabel = model.provider ? `${model.provider}/${model.id}` : model.id;
    if (s.records.length > 0) {
      const last = s.records[s.records.length - 1]!;
      s.expectedRead = last.usage.input + last.usage.cacheRead + last.usage.cacheWrite;
      s.cachedTokens = s.expectedRead;
      s.lastRequestAt = last.at || undefined;
      s.prevCallRequestAt = last.at || undefined;
    }
    if (!ctx.hasUI) return;
    s.ui = ctx.ui as unknown as CachemireState["ui"];
    ctx.ui.setWidget("__pi_cachemire_capture", ((tui: CachemireState["tui"]) => {
      s.tui = tui;
      return { render: () => [] as string[], invalidate: () => {} };
    }) as never);
    ctx.ui.setWidget("__pi_cachemire_capture", undefined);
    if (g.__piCachemireTimer) clearInterval(g.__piCachemireTimer);
    g.__piCachemireTimer = setInterval(() => updateWidget(), 1000);
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    if (g.__piCachemireTimer) clearInterval(g.__piCachemireTimer);
    g.__piCachemireTimer = undefined;
  });

  pi.on("before_provider_request", async (event) => {
    s.pendingFingerprint = fingerprintPayload(event.payload);
    s.pendingRequestAt = Date.now();
    s.lastRequestAt = s.pendingRequestAt;
    if (s.pendingFingerprint.ttlMs !== undefined) s.ttlMs = s.pendingFingerprint.ttlMs;
    if (s.pendingFingerprint.kind === "anthropic") s.providerLabel = "anthropic";
    else if (s.pendingFingerprint.kind === "openai-responses") s.providerLabel = "openai";
    updateWidget();
  });

  pi.on("model_select", async (event) => {
    const model = event.model as { id?: string; provider?: string; cost?: ModelRates } | undefined;
    if (model?.cost) s.rates = model.cost;
    if (model?.id) s.modelLabel = model.provider ? `${model.provider}/${model.id}` : model.id;
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
    const message = event.message as { role?: string; usage?: UsageLike };
    if (message.role !== "assistant" || !message.usage) return;
    const usage = message.usage;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) return;
    const now = Date.now();
    // Idle gap between the previous request (which refreshed the TTL) and this one.
    const requestAt = s.pendingRequestAt ?? now;
    const gapMs = s.prevCallRequestAt !== undefined ? requestAt - s.prevCallRequestAt : undefined;

    const fingerprintCause = s.prevFingerprint && s.pendingFingerprint
      ? diffFingerprints(s.prevFingerprint, s.pendingFingerprint)
      : undefined;
    const classification = classifyCall({
      isFirst: s.records.length === 0,
      gapMs,
      ttlMs: s.ttlMs,
      usage,
      expectedRead: s.expectedRead,
      compacted: s.compacted,
      inCompaction: s.inCompaction,
      fingerprintCause,
    });
    const record: CallRecord = {
      index: s.records.length + 1,
      at: now,
      gapMs,
      usage,
      expectedRead: s.expectedRead,
      classification,
      rewroteTokens: usage.cacheWrite > 0 ? usage.cacheWrite : usage.input,
      costUsd: usage.cost?.total,
      uncachedUsd: uncachedCostUsd(usage, s.rates),
    };
    s.records.push(record);
    s.compacted = false;
    s.prevFingerprint = s.pendingFingerprint ?? s.prevFingerprint;
    s.prevCallRequestAt = requestAt;
    s.expectedRead = usage.input + usage.cacheRead + usage.cacheWrite;
    s.cachedTokens = s.expectedRead;
    s.lastRequestAt = now;

    if (s.run) {
      s.run.calls += 1;
      s.run.input += usage.input;
      s.run.cacheRead += usage.cacheRead;
      s.run.cacheWrite += usage.cacheWrite;
      s.run.output += usage.output;
      s.run.costUsd += usage.cost?.total ?? 0;
    }

    if (
      s.config.missWarnings &&
      (classification.kind === "miss" || classification.kind === "partial") &&
      classification.cause?.kind !== "compaction-work" &&
      ((record.costUsd ?? 0) >= s.config.missWarnUsd || record.rewroteTokens >= s.config.missWarnTokens)
    ) {
      appendChatLine(`${YELLOW}${GLYPH} ${renderMissLine(record)}${RESET}`);
    }
    updateWidget(now);
  });

  pi.on("agent_end", async () => {
    const run = s.run;
    s.run = undefined;
    if (!run || !s.config.turnSummary || run.calls < s.config.turnSummaryMinCalls) return;
    appendChatLine(`${MUTED_GREY}${GLYPH} ${renderRunSummary(run, Date.now())}${RESET}`);
  });

  pi.registerCommand("cache", {
    description: "Show the cachemire cache & loop ledger",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const lines = renderLedger(s.records, {
        providerLabel: s.providerLabel,
        ttlMs: s.ttlMs,
        modelLabel: s.modelLabel,
      });
      appendChatLine(`${MUTED_GREY}${GLYPH} ${lines[0]}${RESET}\n${lines.slice(1).join("\n")}`);
    },
  });
}

// Test-only surface. Pi's loader imports only the default export, so this is runtime-inert.
export const internals = {
  stripCacheControl,
  fingerprintPayload,
  diffFingerprints,
  classifyCall,
  uncachedCostUsd,
  rewriteCostUsd,
  sessionSavings,
  formatTokensK,
  formatUsd,
  formatDuration,
  cacheClock,
  renderRunSummary,
  renderMissLine,
  renderLedger,
  restoreFromMessages,
  loadConfig,
  DEFAULT_CONFIG,
};
