import { isJsonObject } from "../_lib/boundary.ts";
import { formatDuration } from "../_lib/fmt.ts";
import { TTL_LONG_MS, TTL_SHORT_MS } from "./classify.ts";
import type { CacheWindow } from "./types.ts";

export function inferAnthropicTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return env.PI_CACHE_RETENTION === "long" ? TTL_LONG_MS : TTL_SHORT_MS;
}

export const OPENAI_MINIMUM_WINDOW: CacheWindow = {
  kind: "minimum",
  minMs: 6 * TTL_SHORT_MS,
};

export const OPENAI_EXTENDED_WINDOW: CacheWindow = {
  kind: "maximum",
  maxMs: 24 * TTL_LONG_MS,
};

function gpt5Minor(model: string | undefined): number | undefined {
  const id = (model ?? "").toLowerCase().split("/").at(-1) ?? "";
  if (id === "gpt-5") return 0;
  const version = /^gpt-5\.(\d+)(?:-|$)/.exec(id);
  return version === null ? undefined : Number(version[1]);
}

function usesMinimumRetention(provider: string | undefined, model: string | undefined): boolean {
  const minor = gpt5Minor(model);
  return (provider === "openai" || provider === "openai-codex") && minor !== undefined && minor >= 6;
}

export function windowForModel(
  provider: string | undefined,
  model?: string,
): CacheWindow | undefined {
  if (provider === "anthropic") {
    return { kind: "contract", ttlMs: inferAnthropicTtlMs(), source: "inferred" };
  }
  return usesMinimumRetention(provider, model) ? OPENAI_MINIMUM_WINDOW : undefined;
}

function supportsExtendedRetention(model: string | undefined): boolean {
  const minor = gpt5Minor(model);
  return minor !== undefined && minor < 6;
}

export function windowForRequest(
  provider: string | undefined,
  model: string | undefined,
  payload: unknown,
): CacheWindow | undefined {
  if (usesMinimumRetention(provider, model)) return OPENAI_MINIMUM_WINDOW;
  if (provider !== "openai" || !supportsExtendedRetention(model) || !isJsonObject(payload)) return undefined;
  return payload.prompt_cache_retention === "24h" ? OPENAI_EXTENDED_WINDOW : undefined;
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
