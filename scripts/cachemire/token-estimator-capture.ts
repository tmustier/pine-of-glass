import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TargetModel } from "../../extensions/_lib/forecast.ts";
import { forecastProviderPrompt } from "../../extensions/_lib/provider-prompt.ts";
import {
  measureCanonicalPrompt,
  measureProviderPrompt,
  type CanonicalPromptMeasurement,
  type ProviderPromptMeasurement,
} from "./token-estimator-measure.ts";

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

type AssistantLike = {
  role: "assistant";
  provider: string;
  api: string;
  model: string;
  usage: { input: number; cacheRead: number; cacheWrite: number };
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

function assistantMessage(value: unknown): AssistantLike | undefined {
  if (!value || typeof value !== "object" || !("role" in value) || value.role !== "assistant") return undefined;
  // SAFETY: message_end is a Pi-owned event boundary. The role refinement above is
  // the contract discriminator; the remaining fields are fixed by Pi's assistant message contract.
  return value as AssistantLike;
}

function selectionRecord(
  meta: StudyMetadata,
  selectionId: string,
  source: string,
  target: TargetModel,
  canonical: CanonicalPromptMeasurement,
): object {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: "selection",
    capturedAt: new Date().toISOString(),
    ...meta,
    selectionId,
    source,
    target: { provider: target.provider, api: target.api, model: target.id },
    canonical,
  };
}

function requestRecord(
  meta: StudyMetadata,
  requestId: string,
  selectionId: string | undefined,
  target: TargetModel,
  canonical: CanonicalPromptMeasurement,
  provider: ProviderPromptMeasurement | undefined,
  currentProviderTokens: number | undefined,
  requestOrdinal: number,
): object {
  return {
    schemaVersion: SCHEMA_VERSION,
    type: "request",
    capturedAt: new Date().toISOString(),
    ...meta,
    requestId,
    requestOrdinal,
    compaction: false,
    ...(selectionId === undefined ? {} : { selectionId }),
    target: { provider: target.provider, api: target.api, model: target.id },
    canonical,
    provider,
    currentProviderTokens,
  };
}

function resolvedRecord(meta: StudyMetadata, pending: PendingRequest, message: AssistantLike): object {
  const actualPromptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  return {
    schemaVersion: SCHEMA_VERSION,
    type: "resolved",
    capturedAt: new Date().toISOString(),
    ...meta,
    requestId: pending.requestId,
    target: { provider: pending.target.provider, api: pending.target.api, model: pending.target.id },
    actualPromptTokens,
    usage: {
      input: message.usage.input,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
    },
  };
}

export default function tokenEstimatorCapture(pi: ExtensionAPI): void {
  const outputPath = process.env.PI_TOKEN_ESTIMATOR_CAPTURE;
  if (outputPath === undefined || outputPath.trim() === "") return;
  const meta = metadata();
  let pendingRequest: PendingRequest | undefined;
  let pendingSelection: PendingSelection | undefined;
  let inCompaction = false;
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

  pi.on("model_select", (event, ctx) => {
    const target = targetFromModel(event.model);
    const selectionId = randomUUID();
    const canonical = measureCanonicalPrompt(pi, ctx, target);
    const source = typeof event.source === "string" ? event.source : "unknown";
    pendingSelection = { selectionId, target };
    append(selectionRecord(meta, selectionId, source, target, canonical));
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
    const canonical = measureCanonicalPrompt(pi, ctx, target);
    const provider = measureProviderPrompt(event.payload, target);
    const providerForecast = forecastProviderPrompt(event.payload, target);
    pendingRequest = { requestId, target };
    append(requestRecord(
      meta,
      requestId,
      selectionId,
      target,
      canonical,
      provider,
      providerForecast?.tokens,
      ++requestOrdinal,
    ));
  });

  pi.on("message_end", (event, _ctx: ExtensionContext) => {
    if (inCompaction || pendingRequest === undefined) return;
    const message = assistantMessage(event.message);
    if (message === undefined) return;
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
    const total = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    if (total > 0) append(resolvedRecord(meta, pendingRequest, message));
    else append({ schemaVersion: SCHEMA_VERSION, type: "unbilled", ...meta, requestId: pendingRequest.requestId });
    pendingRequest = undefined;
  });

  pi.on("agent_end", () => {
    if (pendingRequest !== undefined) {
      append({ schemaVersion: SCHEMA_VERSION, type: "unresolved", ...meta, requestId: pendingRequest.requestId });
      pendingRequest = undefined;
    }
  });
}
