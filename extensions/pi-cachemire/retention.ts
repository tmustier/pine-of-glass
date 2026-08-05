import { isJsonObject } from "../_lib/boundary.ts";
import { formatDuration } from "../_lib/fmt.ts";
import { TTL_LONG_MS, TTL_SHORT_MS } from "./classify.ts";
import type { CacheWindow, UsageLike } from "./types.ts";

export function inferAnthropicTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return env.PI_CACHE_RETENTION === "long" ? TTL_LONG_MS : TTL_SHORT_MS;
}

const OPENAI_MINIMUM_MINOR = 6;
const OPENAI_EXTENDED_VALUE = "24h";

type KnownCacheWindow = Exclude<CacheWindow, { kind: "unknown" }>;
type Activation = "read" | "read-or-write";

export interface RetentionMatch {
  window: KnownCacheWindow;
  activation: Activation;
}

export const OPENAI_MINIMUM_WINDOW = {
  kind: "minimum",
  minMs: 30 * 60 * 1000,
} as const satisfies CacheWindow;

export const OPENAI_EXTENDED_WINDOW = {
  kind: "maximum",
  maxMs: 24 * TTL_LONG_MS,
} as const satisfies CacheWindow;

const GROQ_WINDOW = {
  kind: "contract",
  ttlMs: 2 * TTL_LONG_MS,
  source: "observed",
} as const satisfies CacheWindow;

const CEREBRAS_WINDOW = {
  kind: "maximum",
  maxMs: TTL_LONG_MS,
} as const satisfies CacheWindow;

const MINIMAX_MODELS = new Set(["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);
const GROQ_MODELS = new Set([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b",
]);
const CEREBRAS_MODELS = new Set(["gpt-oss-120b", "zai-glm-4.7"]);
const BEDROCK_CACHE_MODELS = new Set([
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-opus-4-5-20251101-v1:0",
  "anthropic.claude-opus-4-6-v1",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-sonnet-4-6",
]);
const BEDROCK_LONG_MODELS = new Set([
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-opus-4-5-20251101-v1:0",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
]);

export const RETENTION_EVIDENCE_SOURCES = {
  "openai-docs": {
    label: "OpenAI prompt caching",
    url: "https://developers.openai.com/api/docs/guides/prompt-caching",
    reviewedOn: "5 August 2026",
    detail: `GPT-5.${OPENAI_MINIMUM_MINOR} minimum eligibility and legacy extended retention`,
  },
  "anthropic-docs": {
    label: "Anthropic prompt caching",
    url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    reviewedOn: "4 August 2026",
    detail: "ephemeral cache TTL contracts",
  },
  "minimax-docs": {
    label: "MiniMax Anthropic-compatible caching",
    url: "https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache.md",
    reviewedOn: "5 August 2026",
    detail: "M2.7 explicit 5-minute cache entries",
  },
  "bedrock-docs": {
    label: "Amazon Bedrock prompt caching",
    url: "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html",
    reviewedOn: "5 August 2026",
    detail: "Claude cache points, model support and TTLs",
  },
  "groq-docs": {
    label: "Groq prompt caching",
    url: "https://console.groq.com/docs/prompt-caching",
    reviewedOn: "5 August 2026",
    detail: "GPT-OSS cache support and 2-hour inactivity expiry",
  },
  "cerebras-docs": {
    label: "Cerebras prompt caching",
    url: "https://inference-docs.cerebras.ai/capabilities/prompt-caching",
    reviewedOn: "5 August 2026",
    detail: "supported models and the 1-hour maximum",
  },
  "installed-pi": {
    label: "Installed Pi request builders and model records",
    url: undefined,
    reviewedOn: "5 August 2026",
    detail: "Pi 0.83.0 provider payloads, normalized usage and generated model catalogue",
  },
} as const;

type RetentionEvidenceSourceId = keyof typeof RETENTION_EVIDENCE_SOURCES;

interface RetentionIdentity {
  provider?: string;
  model?: string;
  api?: string;
}

interface ModelRetentionEvidence extends RetentionIdentity {
  env: Record<string, string | undefined>;
}

interface RequestRetentionEvidence extends RetentionIdentity {
  ttlMs?: number;
  payload: unknown;
}

interface RetentionPolicy {
  route: string;
  evidence: string;
  behavior: string;
  sourceIds: readonly [RetentionEvidenceSourceId, ...RetentionEvidenceSourceId[]];
  activation: Activation;
  resolveModel?: (input: ModelRetentionEvidence) => KnownCacheWindow | undefined;
  resolveRequest?: (input: RequestRetentionEvidence) => KnownCacheWindow | undefined;
}

function onRoute(input: RetentionIdentity, provider: string, api: string): boolean {
  return input.provider === provider && input.api === api;
}

function gpt5Minor(model: string | undefined): number | undefined {
  const id = (model ?? "").toLowerCase().split("/").at(-1) ?? "";
  if (id === "gpt-5") return 0;
  const version = /^gpt-5\.(\d+)(?:-|$)/.exec(id);
  return version === null ? undefined : Number(version[1]);
}

function usesMinimumRetention(input: RetentionIdentity): boolean {
  const minor = gpt5Minor(input.model);
  const route = onRoute(input, "openai", "openai-responses") ||
    onRoute(input, "openai-codex", "openai-codex-responses");
  return route && minor !== undefined && minor >= OPENAI_MINIMUM_MINOR;
}

function bedrockCacheTtlMs(payload: unknown): number | undefined {
  if (!isJsonObject(payload)) return undefined;
  const blocks: unknown[] = Array.isArray(payload.system) ? [...payload.system] : [];
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (isJsonObject(message) && Array.isArray(message.content)) blocks.push(...message.content);
    }
  }

  let ttlMs: number | undefined;
  for (const block of blocks) {
    if (!isJsonObject(block) || !isJsonObject(block.cachePoint) || block.cachePoint.type !== "default") continue;
    const found = block.cachePoint.ttl === "1h"
      ? TTL_LONG_MS
      : block.cachePoint.ttl === undefined || block.cachePoint.ttl === "5m" ? TTL_SHORT_MS : undefined;
    if (found === undefined || (ttlMs !== undefined && ttlMs !== found)) return undefined;
    ttlMs = found;
  }
  return ttlMs;
}

function groqWindow(input: RetentionIdentity): KnownCacheWindow | undefined {
  return onRoute(input, "groq", "openai-completions") && input.model !== undefined && GROQ_MODELS.has(input.model)
    ? GROQ_WINDOW
    : undefined;
}

function cerebrasWindow(input: RetentionIdentity): KnownCacheWindow | undefined {
  return onRoute(input, "cerebras", "openai-completions") &&
    input.model !== undefined && CEREBRAS_MODELS.has(input.model)
    ? CEREBRAS_WINDOW
    : undefined;
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    route: "Direct Anthropic",
    evidence: "live `cache_control`, or Pi's restored-session retention default",
    behavior: "activate the observed or inferred TTL after a cache read or write",
    sourceIds: ["anthropic-docs", "installed-pi"],
    activation: "read-or-write",
    resolveModel: (input) => onRoute(input, "anthropic", "anthropic-messages")
      ? { kind: "contract", ttlMs: inferAnthropicTtlMs(input.env), source: "inferred" }
      : undefined,
    resolveRequest: (input) => onRoute(input, "anthropic", "anthropic-messages") &&
      (input.ttlMs === TTL_SHORT_MS || input.ttlMs === TTL_LONG_MS)
      ? { kind: "contract", ttlMs: input.ttlMs, source: "observed" }
      : undefined,
  },
  {
    route: `OpenAI or OpenAI Codex, GPT-5.${OPENAI_MINIMUM_MINOR} and later GPT-5 models`,
    evidence: "documented `prompt_cache_options.ttl` default",
    behavior: `after a cache read or write, use the ${formatDuration(OPENAI_MINIMUM_WINDOW.minMs)} minimum; ` +
      "then show that the cache state is unknown",
    sourceIds: ["openai-docs", "installed-pi"],
    activation: "read-or-write",
    resolveModel: (input) => usesMinimumRetention(input) ? OPENAI_MINIMUM_WINDOW : undefined,
    resolveRequest: (input) => usesMinimumRetention(input) ? OPENAI_MINIMUM_WINDOW : undefined,
  },
  {
    route: `Direct official OpenAI API, GPT-5 below GPT-5.${OPENAI_MINIMUM_MINOR}`,
    evidence: `outgoing payload contains \`prompt_cache_retention: "${OPENAI_EXTENDED_VALUE}"\``,
    behavior: `after a cache read, record a ${formatDuration(OPENAI_EXTENDED_WINDOW.maxMs)} maximum ` +
      "with no warmth claim before it",
    sourceIds: ["openai-docs", "installed-pi"],
    activation: "read",
    resolveRequest: (input) => {
      if (!onRoute(input, "openai", "openai-responses") || !isJsonObject(input.payload)) return undefined;
      const minor = gpt5Minor(input.model);
      return minor !== undefined && minor < OPENAI_MINIMUM_MINOR &&
        input.payload.prompt_cache_retention === OPENAI_EXTENDED_VALUE
        ? OPENAI_EXTENDED_WINDOW
        : undefined;
    },
  },
  {
    route: "MiniMax M2.7, global and China routes",
    evidence: "outgoing 5-minute `cache_control` on an M2.7 model",
    behavior: "activate the 5-minute TTL after a cache read or write",
    sourceIds: ["minimax-docs", "installed-pi"],
    activation: "read-or-write",
    resolveModel: (input) => (input.provider === "minimax" || input.provider === "minimax-cn") &&
      input.api === "anthropic-messages" && input.model !== undefined && MINIMAX_MODELS.has(input.model)
      ? { kind: "contract", ttlMs: TTL_SHORT_MS, source: "inferred" }
      : undefined,
    resolveRequest: (input) => (input.provider === "minimax" || input.provider === "minimax-cn") &&
      input.api === "anthropic-messages" && input.model !== undefined && MINIMAX_MODELS.has(input.model) &&
      input.ttlMs === TTL_SHORT_MS
      ? { kind: "contract", ttlMs: TTL_SHORT_MS, source: "observed" }
      : undefined,
  },
  {
    route: "Amazon Bedrock, documented Claude 4.5 and 4.6 models",
    evidence: "outgoing `cachePoint` with a model-supported TTL",
    behavior: "activate the 5-minute or 1-hour TTL after a cache read or write",
    sourceIds: ["bedrock-docs", "installed-pi"],
    activation: "read-or-write",
    resolveRequest: (input) => {
      if (!onRoute(input, "amazon-bedrock", "bedrock-converse-stream")) return undefined;
      const ttlMs = bedrockCacheTtlMs(input.payload);
      const model = (input.model ?? "").replace(/^(?:au|eu|global|jp|us)\./, "");
      if (ttlMs === undefined || !BEDROCK_CACHE_MODELS.has(model) ||
          (ttlMs === TTL_LONG_MS && !BEDROCK_LONG_MODELS.has(model))) return undefined;
      return { kind: "contract", ttlMs, source: "observed" };
    },
  },
  {
    route: "Groq GPT-OSS models",
    evidence: "automatic cache read on a documented GPT-OSS model",
    behavior: "start or refresh the 2-hour inactivity TTL after a cache read",
    sourceIds: ["groq-docs", "installed-pi"],
    activation: "read",
    resolveModel: groqWindow,
    resolveRequest: groqWindow,
  },
  {
    route: "Cerebras GPT-OSS 120B and GLM 4.7",
    evidence: "automatic cache read on a documented model",
    behavior: "after a cache read, record a 1-hour maximum with no prior warmth claim",
    sourceIds: ["cerebras-docs", "installed-pi"],
    activation: "read",
    resolveModel: cerebrasWindow,
    resolveRequest: cerebrasWindow,
  },
];

export function retentionForModel(
  provider: string | undefined,
  model: string | undefined,
  api: string | undefined,
  env: Record<string, string | undefined> = process.env,
): RetentionMatch | undefined {
  const input = { provider, model, api, env };
  for (const policy of RETENTION_POLICIES) {
    const window = policy.resolveModel?.(input);
    if (window !== undefined) return { window, activation: policy.activation };
  }
  return undefined;
}

export function retentionForRequest(input: RequestRetentionEvidence): RetentionMatch | undefined {
  for (const policy of RETENTION_POLICIES) {
    const window = policy.resolveRequest?.(input);
    if (window !== undefined) return { window, activation: policy.activation };
  }
  return undefined;
}

export function confirmedWindow(
  retention: RetentionMatch | undefined,
  usage: Pick<UsageLike, "cacheRead" | "cacheWrite">,
): CacheWindow | undefined {
  if (retention === undefined) return undefined;
  if (usage.cacheRead > 0) return retention.window;
  return retention.activation === "read-or-write" && usage.cacheWrite > 0 ? retention.window : undefined;
}

export function windowLabel(window: CacheWindow): string {
  switch (window.kind) {
    case "contract":
      return `${formatDuration(window.ttlMs)} TTL${window.source === "inferred" ? " (inferred)" : ""}`;
    case "minimum":
      return `${formatDuration(window.minMs)} minimum`;
    case "maximum":
      return `${formatDuration(window.maxMs)} maximum`;
    default:
      return "retention unknown";
  }
}
