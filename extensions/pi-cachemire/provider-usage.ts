import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { isJsonObject } from "../_lib/boundary.ts";

const PROVIDERS = ["moonshotai", "moonshotai-cn", "together"] as const;
const openAICompletions = openAICompletionsApi();

type ProviderUsageRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "getRegisteredNativeProvider" | "getRegisteredProviderConfig"
>;

export function normalizeCachedTokenSseLine(line: string): string {
  const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
  const body = ending === "" ? line : line.slice(0, -ending.length);
  const prefix = body.match(/^data:\s*/)?.[0];
  if (!prefix) return line;

  let frame: unknown;
  try {
    frame = JSON.parse(body.slice(prefix.length));
  } catch {
    return line;
  }
  if (!isJsonObject(frame)) return line;

  const usage = frame.usage;
  if (!isJsonObject(usage)) return line;
  const details = usage.prompt_tokens_details;
  if (details != null && !isJsonObject(details)) return line;
  if (usage.prompt_cache_hit_tokens != null || details?.cached_tokens != null) return line;
  const cachedTokens = usage.cached_tokens;
  if (typeof cachedTokens !== "number" || !Number.isInteger(cachedTokens) || cachedTokens < 0) return line;

  usage.prompt_tokens_details = { ...details, cached_tokens: cachedTokens };
  return `${prefix}${JSON.stringify(frame)}${ending}`;
}

function normalizeCachedTokenSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      pending += decoder.decode(chunk, { stream: true });
      let output = "";
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        output += normalizeCachedTokenSseLine(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (output !== "") controller.enqueue(encoder.encode(output));
    },
    flush(controller): void {
      pending += decoder.decode();
      if (pending !== "") controller.enqueue(encoder.encode(normalizeCachedTokenSseLine(pending)));
    },
  }));
}

export function cachedTokenNormalizingFetch(fetchImpl: FetchFunction): FetchFunction {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.ok || response.body === null) return response;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(normalizeCachedTokenSse(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

const normalizedStreamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) =>
  openAICompletions.streamSimple(model, context, {
    ...options,
    fetch: cachedTokenNormalizingFetch(options?.fetch ?? globalThis.fetch),
  });

export function installProviderUsageOverlays(
  pi: Pick<ExtensionAPI, "registerProvider" | "unregisterProvider">,
  registry: ProviderUsageRegistry,
): () => void {
  const installed: Array<{ provider: typeof PROVIDERS[number]; previous?: ProviderConfig }> = [];
  for (const provider of PROVIDERS) {
    if (registry.getRegisteredNativeProvider(provider)) continue;
    const previous = registry.getRegisteredProviderConfig(provider);
    if (previous?.streamSimple) continue;
    pi.registerProvider(provider, {
      api: "openai-completions",
      streamSimple: normalizedStreamSimple,
    });
    installed.push({ provider, previous });
  }

  return () => {
    for (const { provider, previous } of installed) {
      if (registry.getRegisteredProviderConfig(provider)?.streamSimple !== normalizedStreamSimple) continue;
      pi.unregisterProvider(provider);
      if (previous) pi.registerProvider(provider, previous);
    }
  };
}

export function bindProviderUsageOverlays(pi: ExtensionAPI): void {
  let cleanup: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    cleanup = installProviderUsageOverlays(pi, ctx.modelRegistry);
  });
  pi.on("session_shutdown", () => cleanup?.());
}
