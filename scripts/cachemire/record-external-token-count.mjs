#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: record-external-token-count.mjs --capture aggregate.jsonl --tokens N --source anthropic-count-tokens");
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
  else usage(`unknown option: ${key}`);
}
if (!options.capture || !Number.isInteger(options.tokens) || options.tokens <= 0 || !options.source) {
  usage("capture, positive whole tokens, and source are required");
}
const records = readFileSync(options.capture, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const resolvedIds = new Set(records.filter((record) => record.type === "resolved").map((record) => record.requestId));
const request = records.toReversed().find((record) => record.type === "request" && !resolvedIds.has(record.requestId));
if (!request) throw new Error("no unresolved request found");
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
};
appendFileSync(options.capture, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`recorded ${options.tokens} exact tokens for ${request.caseId}`);
