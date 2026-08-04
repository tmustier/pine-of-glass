import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
  };
}

test("external counts require an exact request when several captures are unresolved", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-token-count-"));
  const capture = join(directory, "capture.jsonl");
  writeFileSync(capture, `${JSON.stringify(request("request-a"))}\n${JSON.stringify(request("request-b"))}\n`);
  const command = "scripts/cachemire/record-external-token-count.mjs";
  const ambiguous = spawnSync(process.execPath, [
    command, "--capture", capture, "--tokens", "123", "--source", "fixture", "--counted-model", "claude-fable-5",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /more than one unresolved request/);

  const exact = spawnSync(process.execPath, [
    command,
    "--capture", capture,
    "--tokens", "123",
    "--source", "fixture",
    "--counted-model", "claude-fable-5",
    "--request-id", "request-a",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(exact.status, 0, exact.stderr);
  const records: unknown[] = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  // SAFETY: the last line is emitted by the helper under test.
  const resolved = records.at(-1) as { type: string; requestId: string; actualPromptTokens: number };
  assert.equal(resolved.type, "resolved");
  assert.equal(resolved.requestId, "request-a");
  assert.equal(resolved.actualPromptTokens, 123);

  const mismatch = spawnSync(process.execPath, [
    command,
    "--capture", capture,
    "--tokens", "124",
    "--source", "fixture",
    "--counted-model", "wrong-model",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /counted model does not match captured target/);
});
