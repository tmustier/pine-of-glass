import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

type JsonObject = { [key: string]: unknown };

function request(runId: string, requestId: string, actual: number): JsonObject[] {
  const target = { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-sol" };
  return [
    {
      schemaVersion: 1,
      type: "request",
      runId,
      caseId: "parser-fixture",
      split: "holdout",
      route: "direct",
      strata: ["direction:none"],
      configuredTurn: 1,
      requestId,
      requestOrdinal: 1,
      compaction: false,
      target,
      canonical: { flatTokens: 120, totalTokens: 110 },
      provider: {
        normalizedTokens: 105,
        messageCount: 1,
        toolCount: 0,
        opaqueReasoningChars: 0,
        imageCount: 0,
        imageChars: 0,
        retainedReasoningChars: 0,
      },
      currentProviderTokens: 115,
    },
    {
      schemaVersion: 1,
      type: "resolved",
      runId,
      caseId: "parser-fixture",
      split: "holdout",
      route: "direct",
      strata: ["direction:none"],
      requestId,
      target,
      actualPromptTokens: actual,
      usage: { input: actual, cacheRead: 0, cacheWrite: 0 },
    },
  ];
}

test("committed Anthropic count-endpoint cross-checks match response usage", () => {
  const dataset = JSON.parse(readFileSync(
    join(process.cwd(), "scripts/cachemire/token-estimator-study-data.json"),
    "utf8",
  )) as { rows: Array<{ studyRun: string; caseId: string; actualPromptTokens: number; exactSource: string }> };
  const crossChecks = JSON.parse(readFileSync(
    join(process.cwd(), "scripts/cachemire/token-estimator-exact-cross-checks.json"),
    "utf8",
  )) as {
    checks: Array<{
      studyRun: string;
      caseId: string;
      providerResponseTokens: number;
      countEndpointTokens: number;
    }>;
  };
  assert.equal(crossChecks.checks.length, 3);
  for (const check of crossChecks.checks) {
    const row = dataset.rows.find((candidate) =>
      candidate.studyRun === check.studyRun && candidate.caseId === check.caseId
    );
    assert.equal(row?.exactSource, "provider-response");
    assert.equal(row?.actualPromptTokens, check.providerResponseTokens);
    assert.equal(check.countEndpointTokens, check.providerResponseTokens);
  }
});

test("study analyzer joins exact-identity captures and emits deterministic aggregate reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-estimator-analysis-"));
  const capture = join(directory, "capture.jsonl");
  const datasetPath = join(directory, "dataset.json");
  const reportPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  const records = [...request("run-a", "request-a", 100), ...request("run-b", "request-b", 102)];
  writeFileSync(capture, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const result = spawnSync(process.execPath, [
    "scripts/cachemire/analyze-token-estimator-study.mjs",
    "--input", capture,
    "--dataset", datasetPath,
    "--json", reportPath,
    "--markdown", markdownPath,
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsedDataset: unknown = JSON.parse(readFileSync(datasetPath, "utf8"));
  const parsedReport: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
  // SAFETY: these files are emitted by the analyzer in this test and the asserted fields
  // below are the analyzer's output contract.
  const dataset = parsedDataset as { rows: JsonObject[] };
  const report = parsedReport as {
    dataset: { requests: number; studyRuns: number };
    validation: { identityFailures: number; privacyViolations: string[]; splitFailures: string[] };
    groups: Array<{
      dimension: string;
      value: string;
      metrics: Record<string, { meanAbsolutePercent?: number; rawAbsoluteErrors?: number[] } | undefined>;
      comparisons: Record<string, { lower: number; upper: number } | undefined>;
    }>;
  };
  assert.equal(dataset.rows.length, 2);
  assert.deepEqual(report.dataset, { requests: 2, studyRuns: 2 });
  assert.equal(report.validation.identityFailures, 0);
  assert.deepEqual(report.validation.privacyViolations, []);
  assert.deepEqual(report.validation.splitFailures, []);
  const overall = report.groups.find((group) => group.dimension === "overall");
  assert.equal(overall?.comparisons["B1-send -> C1-normalized-send"], undefined);
  const smallStratum = report.groups.find((group) => group.dimension === "detailed-declared-stratum");
  assert.equal(smallStratum?.metrics["B1-send"]?.meanAbsolutePercent, undefined);
  assert.deepEqual(smallStratum?.metrics["B1-send"]?.rawAbsoluteErrors, [10, 8]);
  assert.match(readFileSync(markdownPath, "utf8"), /2 resolved requests across 2 study runs/);
});
