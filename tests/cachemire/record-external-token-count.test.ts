import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { providerPayloadSha256 } from "../../scripts/cachemire/token-estimator-capture.ts";
import { jsonSha256 } from "../../scripts/contextimate/check-provider-tokens.mjs";

const payloadHash = "a".repeat(64);

function request(requestId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: "request",
    runId: "fixture-run",
    caseId: "fixture-case",
    split: "holdout",
    route: "direct",
    strata: [],
    requestId,
    target: { provider: "anthropic", api: "anthropic-messages", model: "claude-fable-5" },
    providerPayloadSha256: payloadHash,
  };
}

function exactResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "anthropic",
    api: "anthropic-messages",
    source: "anthropic-count-tokens",
    model: "claude-fable-5",
    exactTokens: 123,
    capturedPayloadSha256: payloadHash,
    countRequestSha256: "b".repeat(64),
    ...overrides,
  };
}

function runRecorder(capture: string, result: string, requestId?: string) {
  const args = [
    "scripts/cachemire/record-external-token-count.mjs",
    "--capture", capture,
    "--result", result,
  ];
  if (requestId !== undefined) args.push("--request-id", requestId);
  return spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
}

test("aggregate and sensitive capture paths hash one provider payload identically", () => {
  const payload = { model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] };
  assert.equal(providerPayloadSha256(payload), jsonSha256(payload));
});

test("external counts bind provider identity and the counted payload to one captured request", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-token-count-"));
  const capture = join(directory, "capture.jsonl");
  const result = join(directory, "result.json");
  writeFileSync(capture, `${JSON.stringify(request("request-a"))}\n${JSON.stringify(request("request-b"))}\n`);
  writeFileSync(result, JSON.stringify(exactResult()));

  const ambiguous = runRecorder(capture, result);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /more than one unresolved request/);

  const exact = runRecorder(capture, result, "request-a");
  assert.equal(exact.status, 0, exact.stderr);
  const records: unknown[] = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  // SAFETY: the last line is emitted by the helper under test.
  const resolved = records.at(-1) as {
    type: string;
    requestId: string;
    actualPromptTokens: number;
    countedProvider: string;
    countedApi: string;
    capturedPayloadSha256: string;
  };
  assert.equal(resolved.type, "resolved");
  assert.equal(resolved.requestId, "request-a");
  assert.equal(resolved.actualPromptTokens, 123);
  assert.equal(resolved.countedProvider, "anthropic");
  assert.equal(resolved.countedApi, "anthropic-messages");
  assert.equal(resolved.capturedPayloadSha256, payloadHash);

  for (const [field, value, message] of [
    ["provider", "other", /provider does not match/],
    ["api", "other-api", /API does not match/],
    ["model", "wrong-model", /model does not match/],
    ["capturedPayloadSha256", "c".repeat(64), /captured payload does not match/],
  ] as const) {
    writeFileSync(result, JSON.stringify(exactResult({ [field]: value })));
    const mismatch = runRecorder(capture, result, "request-b");
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, message);
  }
});
