// Explicit development probe for model-switch forecast accuracy (issue #64).
//
//   PI_CACHEMIRE_FORECAST_CAPTURE=/tmp/cachemire-switch.jsonl \
//     pi -e ./scripts/cachemire/model-switch-forecast-probe.ts
//
// The JSONL contains model identities and aggregate counts only. It never records
// prompt text, tool names or schemas, provider payloads, session ids, or cwd.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  forecastHistoryForTarget,
  forecastTargetPrompt,
  type ForecastMessage,
  type TargetModel,
} from "../../extensions/_lib/forecast.ts";
import { activeToolShapes } from "../../extensions/pi-cachemire/forecast.ts";

const outputPath = process.env.PI_CACHEMIRE_FORECAST_CAPTURE ?? "/tmp/pi-cachemire-model-switch-forecast.jsonl";
const runId = randomUUID();
let sequence = 0;

type CanonicalCounts = {
  totalTokens: number;
  staticTokens: number;
  systemTokens: number;
  toolTokens: number;
  historyTokens: number;
  historyTextChars: number;
  historyReasoningChars: number;
  historyImageChars: number;
  systemPromptChars: number;
  activeToolCount: number;
  heuristic: string;
};

type RequestCapture = {
  identity: TargetModel;
  canonical: CanonicalCounts;
};

type ResolvedCapture = RequestCapture & {
  actualPromptTokens: number;
};

let pending: RequestCapture | undefined;
let lastResolved: ResolvedCapture | undefined;
let inCompaction = false;

function append(type: string, data: object): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  appendFileSync(outputPath, `${JSON.stringify({ schema: 1, runId, sequence: ++sequence, type, ...data })}\n`, "utf8");
}

function identity(model: TargetModel): TargetModel {
  return { provider: model.provider, api: model.api, id: model.id, input: model.input };
}

function canonicalCounts(
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
  ctx: Pick<ExtensionContext, "sessionManager" | "getSystemPrompt">,
  target: TargetModel,
  phase: "model_select" | "before_provider_request",
): CanonicalCounts | undefined {
  try {
    const history = convertToLlm(
      buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
    ) as unknown as ForecastMessage[];
    const tools = activeToolShapes(pi);
    const systemPromptChars = ctx.getSystemPrompt().length;
    const historyCounts = forecastHistoryForTarget(history, target);
    const system = forecastTargetPrompt({ history: [], systemPromptChars, tools: [], target });
    const staticPrompt = forecastTargetPrompt({ history: [], systemPromptChars, tools, target });
    const total = forecastTargetPrompt({ history, systemPromptChars, tools, target });
    return {
      totalTokens: total.tokens,
      staticTokens: staticPrompt.tokens,
      systemTokens: system.tokens,
      toolTokens: staticPrompt.tokens - system.tokens,
      historyTokens: total.tokens - staticPrompt.tokens,
      historyTextChars: historyCounts.textChars,
      historyReasoningChars: historyCounts.keptReasoningChars,
      historyImageChars: historyCounts.imageChars,
      systemPromptChars,
      activeToolCount: tools.length,
      heuristic: total.heuristic.label,
    };
  } catch (error) {
    // SAFETY: Pi's session conversion is a runtime seam. Keep the development session
    // alive and record only the error class, never a message that may contain a path.
    append("capture_error", { phase, error: error instanceof Error ? error.name : "UnknownError" });
    return undefined;
  }
}

export default function modelSwitchForecastProbe(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    append("session_start", { model: ctx.model === undefined ? undefined : identity(ctx.model) });
  });

  pi.on("model_select", (event, ctx) => {
    const target = identity(event.model);
    const targetCanonical = canonicalCounts(pi, ctx, target, "model_select");
    const sourceCurrent = lastResolved === undefined
      ? undefined
      : canonicalCounts(pi, ctx, lastResolved.identity, "model_select");
    append("model_select", {
      source: lastResolved?.identity,
      target,
      targetCanonical,
      sourceCurrent,
      sourceRequest: lastResolved === undefined ? undefined : {
        actualPromptTokens: lastResolved.actualPromptTokens,
        canonicalTokens: lastResolved.canonical.totalTokens,
      },
    });
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (ctx.model === undefined) return;
    if (inCompaction) {
      pending = undefined;
      append("compaction_request_skipped", {});
      return;
    }
    const model = identity(ctx.model);
    const canonical = canonicalCounts(pi, ctx, model, "before_provider_request");
    if (canonical === undefined) return;
    pending = { identity: model, canonical };
    append("before_provider_request", pending);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || pending === undefined) return;
    const resolvedIdentity = {
      provider: event.message.provider,
      api: event.message.api,
      id: event.message.model,
    };
    if (resolvedIdentity.provider !== pending.identity.provider ||
        resolvedIdentity.api !== pending.identity.api || resolvedIdentity.id !== pending.identity.id) {
      append("identity_mismatch", { request: pending.identity, response: resolvedIdentity });
      pending = undefined;
      return;
    }
    const actualPromptTokens = event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite;
    if (actualPromptTokens <= 0) {
      append("unbilled_response", { identity: resolvedIdentity });
      pending = undefined;
      return;
    }
    lastResolved = { ...pending, actualPromptTokens };
    append("resolved", lastResolved);
    pending = undefined;
  });

  pi.on("session_before_compact", () => {
    inCompaction = true;
  });

  pi.on("session_compact", () => {
    inCompaction = false;
    pending = undefined;
  });

  pi.on("agent_end", () => {
    pending = undefined;
  });
}
