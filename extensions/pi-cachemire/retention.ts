import { isJsonObject } from "../_lib/boundary.ts";
import { formatDuration } from "../_lib/fmt.ts";
import { TTL_LONG_MS, TTL_SHORT_MS } from "./classify.ts";
import type { CacheWindow, RequestFingerprint } from "./types.ts";

export function inferAnthropicTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return env.PI_CACHE_RETENTION === "long" ? TTL_LONG_MS : TTL_SHORT_MS;
}

const OPENAI_MINIMUM_MINOR = 6;
const OPENAI_EXTENDED_VALUE = "24h";

export const OPENAI_MINIMUM_WINDOW = {
  kind: "minimum",
  minMs: 30 * 60 * 1000,
} as const satisfies CacheWindow;

export const OPENAI_EXTENDED_WINDOW = {
  kind: "maximum",
  maxMs: 24 * 60 * 60 * 1000,
} as const satisfies CacheWindow;

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
  "installed-pi": {
    label: "Installed Pi request builders and model records",
    url: undefined,
    reviewedOn: "5 August 2026",
    detail: "`pi-ai/dist/api/openai-responses.js`, `openai-codex-responses.js`, " +
      "`anthropic-messages.js` and the OpenAI model records",
  },
} as const;

type RetentionEvidenceSourceId = keyof typeof RETENTION_EVIDENCE_SOURCES;

interface ModelRetentionEvidence {
  provider?: string;
  model?: string;
  env: Record<string, string | undefined>;
}

interface RequestRetentionEvidence {
  provider?: string;
  model?: string;
  fingerprint: Pick<RequestFingerprint, "kind" | "ttlMs">;
  payload: unknown;
}

interface RetentionPolicy {
  route: string;
  evidence: string;
  behavior: string;
  sourceIds: readonly RetentionEvidenceSourceId[];
  resolveModel?: (input: ModelRetentionEvidence) => CacheWindow | undefined;
  resolveRequest?: (input: RequestRetentionEvidence) => CacheWindow | undefined;
}

function gpt5Minor(model: string | undefined): number | undefined {
  const id = (model ?? "").toLowerCase().split("/").at(-1) ?? "";
  if (id === "gpt-5") return 0;
  const version = /^gpt-5\.(\d+)(?:-|$)/.exec(id);
  return version === null ? undefined : Number(version[1]);
}

function usesMinimumRetention(provider: string | undefined, model: string | undefined): boolean {
  const minor = gpt5Minor(model);
  return (provider === "openai" || provider === "openai-codex") &&
    minor !== undefined && minor >= OPENAI_MINIMUM_MINOR;
}

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    route: "Anthropic, live request",
    evidence: `\`cache_control\` contains a ${formatDuration(TTL_SHORT_MS)} or ` +
      `${formatDuration(TTL_LONG_MS)} TTL`,
    behavior: "use the observed TTL",
    sourceIds: ["anthropic-docs", "installed-pi"],
    resolveRequest: ({ provider, fingerprint }) =>
      provider === "anthropic" && fingerprint.kind === "anthropic" && fingerprint.ttlMs !== undefined
        ? { kind: "contract", ttlMs: fingerprint.ttlMs, source: "observed" }
        : undefined,
  },
  {
    route: "Anthropic, restored session",
    evidence: "Pi resolves ordinary calls from `PI_CACHE_RETENTION`",
    behavior: `infer ${formatDuration(TTL_SHORT_MS)}, or ${formatDuration(TTL_LONG_MS)} when set to ` +
      "`long`, until a live payload replaces it",
    sourceIds: ["installed-pi"],
    resolveModel: ({ provider, env }) => provider === "anthropic"
      ? { kind: "contract", ttlMs: inferAnthropicTtlMs(env), source: "inferred" }
      : undefined,
  },
  {
    route: `OpenAI or OpenAI Codex, GPT-5.${OPENAI_MINIMUM_MINOR} and later GPT-5 models`,
    evidence: "documented `prompt_cache_options.ttl` default",
    behavior: `use a ${formatDuration(OPENAI_MINIMUM_WINDOW.minMs)} minimum; after it ends, ` +
      "show that the cache state is unknown",
    sourceIds: ["openai-docs", "installed-pi"],
    resolveModel: ({ provider, model }) => usesMinimumRetention(provider, model)
      ? OPENAI_MINIMUM_WINDOW
      : undefined,
    resolveRequest: ({ provider, model, fingerprint }) =>
      fingerprint.kind === "openai-responses" && usesMinimumRetention(provider, model)
        ? OPENAI_MINIMUM_WINDOW
        : undefined,
  },
  {
    route: `Direct official OpenAI API, GPT-5 below GPT-5.${OPENAI_MINIMUM_MINOR}`,
    evidence: `outgoing payload contains \`prompt_cache_retention: "${OPENAI_EXTENDED_VALUE}"\``,
    behavior: `record a ${formatDuration(OPENAI_EXTENDED_WINDOW.maxMs)} maximum, ` +
      "with no warmth claim before it",
    sourceIds: ["openai-docs", "installed-pi"],
    resolveRequest: ({ provider, model, fingerprint, payload }) => {
      if (provider !== "openai" || fingerprint.kind !== "openai-responses" || !isJsonObject(payload)) {
        return undefined;
      }
      const minor = gpt5Minor(model);
      return minor !== undefined && minor < OPENAI_MINIMUM_MINOR &&
        payload.prompt_cache_retention === OPENAI_EXTENDED_VALUE
        ? OPENAI_EXTENDED_WINDOW
        : undefined;
    },
  },
];

export function windowForModel(
  provider: string | undefined,
  model?: string,
  env: Record<string, string | undefined> = process.env,
): CacheWindow | undefined {
  const input = { provider, model, env };
  for (const policy of RETENTION_POLICIES) {
    const window = policy.resolveModel?.(input);
    if (window !== undefined) return window;
  }
  return undefined;
}

export function windowForRequest(input: RequestRetentionEvidence): CacheWindow | undefined {
  for (const policy of RETENTION_POLICIES) {
    const window = policy.resolveRequest?.(input);
    if (window !== undefined) return window;
  }
  return undefined;
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
