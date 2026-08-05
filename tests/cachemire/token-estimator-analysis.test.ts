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
      requestId,
      target,
      actualPromptTokens: actual,
      usage: { input: actual, cacheRead: 0, cacheWrite: 0 },
    },
  ];
}

test("study analyzer joins exact-identity captures and emits deterministic aggregate reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-estimator-analysis-"));
  const capture = join(directory, "capture.jsonl");
  const datasetPath = join(directory, "dataset.json");
  const reportPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  const abortedRequest = request("run-c", "request-c", 0)[0]!;
  const records = [
    ...request("run-a", "request-a", 100),
    ...request("run-b", "request-b", 102),
    abortedRequest,
    {
      schemaVersion: 1,
      type: "aborted",
      runId: "run-c",
      caseId: "parser-fixture",
      split: "holdout",
      route: "direct",
      strata: ["direction:none"],
      requestId: "request-c",
    },
  ];
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
    dataset: { requests: number; studyRuns: number; sessionClusters: number };
    validation: {
      identityFailures: number;
      unresolvedRequests: number;
      privacyViolations: string[];
      splitFailures: string[];
      skipCounts: Record<string, number>;
    };
    groups: Array<{
      dimension: string;
      value: string;
      metrics: Record<string, { meanAbsolutePercent?: number; rawAbsoluteErrors?: number[] } | undefined>;
      comparisons: Record<string, { lower: number; upper: number } | undefined>;
    }>;
  };
  assert.equal(dataset.rows.length, 2);
  assert.deepEqual(report.dataset, { requests: 2, studyRuns: 2, sessionClusters: 2 });
  assert.equal(report.validation.identityFailures, 0);
  assert.equal(report.validation.unresolvedRequests, 0);
  assert.equal(report.validation.skipCounts.aborted, 1);
  assert.deepEqual(report.validation.privacyViolations, []);
  assert.deepEqual(report.validation.splitFailures, []);
  const overall = report.groups.find((group) => group.dimension === "overall");
  assert.equal(overall?.comparisons["B1-send -> C1-normalized-send"], undefined);
  const smallStratum = report.groups.find((group) => group.dimension === "detailed-declared-stratum");
  assert.equal(smallStratum?.metrics["B1-send"]?.meanAbsolutePercent, undefined);
  assert.deepEqual(smallStratum?.metrics["B1-send"]?.rawAbsoluteErrors, [10, 8]);
  assert.match(readFileSync(markdownPath, "utf8"), /2 resolved requests across 2 session clusters/);
});

test("committed aggregate data deterministically regenerates corrected estimates", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-estimator-regenerate-"));
  const datasetPath = join(directory, "dataset.json");
  const reportPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  const committedDataset = join(process.cwd(), "scripts/cachemire/token-estimator-study-data.json");
  const result = spawnSync(process.execPath, [
    "scripts/cachemire/analyze-token-estimator-study.mjs",
    "--input-dataset", committedDataset,
    "--candidates", "scripts/cachemire/token-estimator-candidates.json",
    "--clusters", "scripts/cachemire/token-estimator-session-clusters.json",
    "--dataset", datasetPath,
    "--json", reportPath,
    "--markdown", markdownPath,
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(datasetPath, "utf8"), readFileSync(committedDataset, "utf8"));
  assert.match(readFileSync(markdownPath, "utf8"), /68 resolved requests across 37 session clusters/);
  const parsedAnalysis: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
  // SAFETY: this report is emitted by the analyzer under test; assertions below pin
  // the exact fields used by the deterministic committed-data contract.
  const analysis = parsedAnalysis as {
    validation: { countEndpointUnverified: number };
    acceptance: { summaries: Array<{ target: string; phase: string; estimator: string; acceptable: boolean; failures: string[] }> };
    groups: Array<{
      dimension: string;
      value: string;
      metrics: Record<string, { requests: number; sessionClusters: number; meanAbsolutePercent?: number } | undefined>;
      comparisons: Record<string, { mean: number } | undefined>;
    }>;
  };
  assert.equal(analysis.validation.countEndpointUnverified, 14);
  assert.equal(analysis.acceptance.summaries.some((summary) => summary.acceptable), false);
  const openAISelection = analysis.acceptance.summaries.find((summary) =>
    summary.target.startsWith("openai-codex/") && summary.phase === "selection" && summary.estimator === "B1-selection");
  assert.deepEqual(openAISelection?.failures, ["bias", "coverage"]);
  const openAIHoldout = analysis.groups.find((group) =>
    group.dimension === "split-route-target" && group.value.startsWith("holdout / direct / openai-codex/"));
  assert.equal(openAIHoldout?.metrics["B1-selection"]?.sessionClusters, 5);
  assert.ok((openAIHoldout?.comparisons["B1-selection -> P0-current-send"]?.mean ?? 0) < 0);
  for (const group of analysis.groups) {
    for (const metrics of Object.values(group.metrics)) {
      if (metrics && metrics.requests < 3) assert.equal(metrics.meanAbsolutePercent, undefined);
    }
  }
});
