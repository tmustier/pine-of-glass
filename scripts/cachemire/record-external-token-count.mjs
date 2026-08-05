#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: record-external-token-count.mjs --capture aggregate.jsonl --result exact-count.json [--request-id ID]");
  process.exit(message ? 1 : 0);
}

function parseExactResult(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const stringFields = ["provider", "api", "source", "model", "capturedPayloadSha256", "countRequestSha256"];
  const digest = /^[0-9a-f]{64}$/;
  if (!value || typeof value !== "object" || stringFields.some((key) => typeof value[key] !== "string") ||
      !Number.isInteger(value.exactTokens) || value.exactTokens <= 0 ||
      !digest.test(value.capturedPayloadSha256) || !digest.test(value.countRequestSha256)) {
    throw new Error("result must be structured --exact --live --json output from check-provider-tokens.mjs");
  }
  return value;
}

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (key === "--help" || key === "-h") usage();
  if (value === undefined) usage(`missing value for ${key}`);
  if (key === "--capture") options.capture = value;
  else if (key === "--result") options.result = value;
  else if (key === "--request-id") options.requestId = value;
  else usage(`unknown option: ${key}`);
}
if (!options.capture || !options.result) usage("capture and result are required");

const exact = parseExactResult(options.result);
const records = readFileSync(options.capture, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const resolvedIds = new Set(records.filter((record) => record.type === "resolved").map((record) => record.requestId));
const candidates = records.filter((record) => record.type === "request" &&
  !resolvedIds.has(record.requestId) && (options.requestId === undefined || record.requestId === options.requestId));
if (candidates.length === 0) throw new Error("no matching unresolved request found");
if (candidates.length > 1) throw new Error("more than one unresolved request; pass --request-id");
const [request] = candidates;
const mismatches = [
  ["provider", request.target?.provider, exact.provider],
  ["API", request.target?.api, exact.api],
  ["model", request.target?.model, exact.model],
  ["captured payload", request.providerPayloadSha256, exact.capturedPayloadSha256],
].filter(([, captured, counted]) => captured !== counted);
if (mismatches.length > 0) {
  throw new Error(mismatches.map(([field]) => `${field} does not match captured request`).join("; "));
}
const acceptedSource = exact.provider === "anthropic" && exact.api === "anthropic-messages" &&
  exact.source === "anthropic-count-tokens";
if (!acceptedSource) throw new Error("result source is not a supported exact-count route");
const record = {
  schemaVersion: 1,
  type: "resolved",
  requestId: request.requestId,
  target: request.target,
  actualPromptTokens: exact.exactTokens,
  usage: { input: exact.exactTokens, cacheRead: 0, cacheWrite: 0 },
  exactSource: exact.source,
  countedProvider: exact.provider,
  countedApi: exact.api,
  countedModel: exact.model,
  capturedPayloadSha256: exact.capturedPayloadSha256,
  countRequestSha256: exact.countRequestSha256,
};
appendFileSync(options.capture, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`recorded ${exact.exactTokens} exact tokens for ${request.caseId}`);
