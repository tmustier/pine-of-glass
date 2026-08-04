#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: record-external-token-count.mjs --capture aggregate.jsonl --tokens N --source anthropic-count-tokens --counted-model MODEL [--request-id ID]");
  process.exit(message ? 1 : 0);
}

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];
  if (key === "--help" || key === "-h") usage();
  if (value === undefined) usage(`missing value for ${key}`);
  if (key === "--capture") options.capture = value;
  else if (key === "--tokens") options.tokens = Number(value);
  else if (key === "--source") options.source = value;
  else if (key === "--request-id") options.requestId = value;
  else if (key === "--counted-model") options.countedModel = value;
  else usage(`unknown option: ${key}`);
}
if (!options.capture || !Number.isInteger(options.tokens) || options.tokens <= 0 || !options.source || !options.countedModel) {
  usage("capture, positive whole tokens, source, and counted model are required");
}
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
if (request.target?.model !== options.countedModel) {
  throw new Error(`counted model does not match captured target model ${request.target?.model ?? "unknown"}`);
}
const record = {
  schemaVersion: 1,
  type: "resolved",
  runId: request.runId,
  caseId: request.caseId,
  split: request.split,
  route: request.route,
  strata: request.strata,
  requestId: request.requestId,
  target: request.target,
  actualPromptTokens: options.tokens,
  usage: { input: options.tokens, cacheRead: 0, cacheWrite: 0 },
  exactSource: options.source,
  countedModel: options.countedModel,
};
appendFileSync(options.capture, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`recorded ${options.tokens} exact tokens for ${request.caseId}`);
