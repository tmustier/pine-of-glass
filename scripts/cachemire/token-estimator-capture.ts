import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TargetModel } from "../../extensions/_lib/forecast.ts";
import { forecastProviderPrompt } from "../../extensions/_lib/provider-prompt.ts";
import { measureCanonicalPrompt, measureProviderPrompt } from "./token-estimator-measure.ts";

const SCHEMA_VERSION = 1;

type StudyMetadata = {
  runId: string;
  caseId: string;
  split: "development" | "holdout" | "smoke";
  route: "direct" | "gateway" | "smoke";
  strata: string[];
  configuredTurn?: number;
};

type PendingRequest = {
  requestId: string;
  target: TargetModel;
};

type PendingSelection = {
  selectionId: string;
  target: TargetModel;
};

type ModelLike = {
  provider: string;
  api: string;
  id: string;
  input?: ("text" | "image")[];
};

function targetFromModel(model: ModelLike): TargetModel {
  return { provider: model.provider, api: model.api, id: model.id, input: model.input };
}

function sameTarget(left: TargetModel, right: TargetModel): boolean {
  return left.provider === right.provider && left.api === right.api && left.id === right.id;
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

export function providerPayloadSha256(payload: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(payload);
    return serialized === undefined ? undefined : createHash("sha256").update(serialized).digest("hex");
  } catch {
    return undefined;
  }
}

function metadata(): StudyMetadata {
  const runId = process.env.PI_TOKEN_ESTIMATOR_RUN_ID?.trim() || randomUUID();
  const caseId = process.env.PI_TOKEN_ESTIMATOR_CASE?.trim() || "unlabeled";
  const split = enumValue(
    process.env.PI_TOKEN_ESTIMATOR_SPLIT,
    ["development", "holdout", "smoke"] as const,
    "smoke",
  );
  const route = enumValue(
    process.env.PI_TOKEN_ESTIMATOR_ROUTE,
    ["direct", "gateway", "smoke"] as const,
    "smoke",
  );
  const strata = (process.env.PI_TOKEN_ESTIMATOR_STRATA ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const rawTurn = Number(process.env.PI_TOKEN_ESTIMATOR_TURN);
  const configuredTurn = Number.isInteger(rawTurn) && rawTurn > 0 ? rawTurn : undefined;
  return { runId, caseId, split, route, strata, configuredTurn };
}

export default function tokenEstimatorCapture(pi: ExtensionAPI): void {
  const outputPath = process.env.PI_TOKEN_ESTIMATOR_CAPTURE;
  if (outputPath === undefined || outputPath.trim() === "") return;
  const meta = metadata();
  let pendingRequest: PendingRequest | undefined;
  let pendingSelection: PendingSelection | undefined;
  let inCompaction = false;
  let compacted = false;
  let recordSequence = 0;
  let requestOrdinal = 0;
  mkdirSync(dirname(outputPath), { recursive: true });

  const append = (record: object): void => {
    try {
      appendFileSync(outputPath, `${JSON.stringify({ ...record, sequence: ++recordSequence })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Study capture must never change or block the production request path.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const switchTarget = process.env.PI_TOKEN_ESTIMATOR_SWITCH_TARGET;
    if (switchTarget === undefined) return;
    const separator = switchTarget.indexOf("/");
    const provider = switchTarget.slice(0, separator);
    const modelId = switchTarget.slice(separator + 1);
    const model = separator > 0 ? ctx.modelRegistry.find(provider, modelId) : undefined;
    if (model === undefined || !await pi.setModel(model)) {
      append({ schemaVersion: SCHEMA_VERSION, type: "switch_failure", ...meta });
    }
  });

  pi.on("model_select", (event, ctx) => {
    const target = targetFromModel(event.model);
    const selectionId = randomUUID();
    pendingSelection = { selectionId, target };
    append({
      schemaVersion: SCHEMA_VERSION,
      type: "selection",
      capturedAt: new Date().toISOString(),
      ...meta,
      selectionId,
      source: event.source,
      target: { provider: target.provider, api: target.api, model: target.id },
      canonical: measureCanonicalPrompt(pi, ctx, target),
    });
  });

  pi.on("session_before_compact", () => {
    inCompaction = true;
    if (pendingRequest !== undefined) {
      append({ schemaVersion: SCHEMA_VERSION, type: "compaction_skip", ...meta, requestId: pendingRequest.requestId });
      pendingRequest = undefined;
    }
  });

  pi.on("session_compact", () => {
    inCompaction = false;
    compacted = true;
  });

  pi.on("agent_start", () => {
    // A cancelled or failed compaction has no completion event. The next agent run is
    // the first boundary that proves subsequent provider traffic is conversational.
    inCompaction = false;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (inCompaction) {
      append({ schemaVersion: SCHEMA_VERSION, type: "compaction_skip", ...meta });
      return;
    }
    if (ctx.model === undefined) return;
    const target = targetFromModel(ctx.model);
    const requestId = randomUUID();
    const selectionId = pendingSelection !== undefined && sameTarget(pendingSelection.target, target)
      ? pendingSelection.selectionId
      : undefined;
    pendingSelection = undefined;
    if (pendingRequest !== undefined) {
      append({ schemaVersion: SCHEMA_VERSION, type: "superseded", ...meta, requestId: pendingRequest.requestId });
    }
    pendingRequest = { requestId, target };
    const providerPayloadHash = providerPayloadSha256(event.payload);
    append({
      schemaVersion: SCHEMA_VERSION,
      type: "request",
      capturedAt: new Date().toISOString(),
      ...meta,
      requestId,
      requestOrdinal: ++requestOrdinal,
      compaction: compacted,
      ...(selectionId === undefined ? {} : { selectionId }),
      target: { provider: target.provider, api: target.api, model: target.id },
      canonical: measureCanonicalPrompt(pi, ctx, target),
      provider: measureProviderPrompt(event.payload, target),
      currentProviderTokens: forecastProviderPrompt(event.payload, target)?.tokens,
      ...(providerPayloadHash === undefined ? {} : { providerPayloadSha256: providerPayloadHash }),
    });
  });

  pi.on("message_end", (event) => {
    if (inCompaction || pendingRequest === undefined || event.message.role !== "assistant") return;
    const message = event.message;
    if (message.stopReason === "aborted" || message.stopReason === "error") {
      append({ schemaVersion: SCHEMA_VERSION, type: message.stopReason, ...meta, requestId: pendingRequest.requestId });
      pendingRequest = undefined;
      return;
    }
    const responseTarget: TargetModel = {
      provider: message.provider,
      api: message.api,
      id: message.model,
    };
    if (!sameTarget(pendingRequest.target, responseTarget)) {
      append({
        schemaVersion: SCHEMA_VERSION,
        type: "identity_mismatch",
        ...meta,
        requestId: pendingRequest.requestId,
        responseTarget: { provider: responseTarget.provider, api: responseTarget.api, model: responseTarget.id },
      });
      pendingRequest = undefined;
      return;
    }
    const actualPromptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    if (actualPromptTokens > 0) {
      append({
        schemaVersion: SCHEMA_VERSION,
        type: "resolved",
        capturedAt: new Date().toISOString(),
        requestId: pendingRequest.requestId,
        target: { provider: pendingRequest.target.provider, api: pendingRequest.target.api, model: pendingRequest.target.id },
        actualPromptTokens,
        usage: {
          input: message.usage.input,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
        },
      });
    } else {
      append({ schemaVersion: SCHEMA_VERSION, type: "unbilled", ...meta, requestId: pendingRequest.requestId });
    }
    pendingRequest = undefined;
  });

  pi.on("agent_end", () => {
    if (pendingRequest !== undefined) {
      append({ schemaVersion: SCHEMA_VERSION, type: "unresolved", ...meta, requestId: pendingRequest.requestId });
      pendingRequest = undefined;
    }
  });
}
