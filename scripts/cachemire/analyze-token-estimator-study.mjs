#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  builtInHeuristicForModel,
  estimateCharsAsTokens,
  fallbackHeuristicNumbers,
} from "../../extensions/_lib/heuristics.ts";

const BOOTSTRAP_SAMPLES = 4000;
const BOOTSTRAP_SEED = 20260804;

function usage(message) {
  if (message) console.error(message);
  console.error("usage: analyze-token-estimator-study.mjs --input capture.jsonl [--input more.jsonl] --dataset rows.json --json report.json --markdown report.md [--candidates candidates.json]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = { inputs: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    const value = argv[++index];
    if (value === undefined) usage(`missing value for ${arg}`);
    if (arg === "--input") options.inputs.push(value);
    else if (arg === "--dataset") options.dataset = value;
    else if (arg === "--json") options.json = value;
    else if (arg === "--markdown") options.markdown = value;
    else if (arg === "--candidates") options.candidates = value;
    else usage(`unknown option: ${arg}`);
  }
  if (options.inputs.length === 0 || !options.dataset || !options.json || !options.markdown) usage("missing required option");
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(paths) {
  const records = [];
  for (const path of paths) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch (error) {
        throw new Error(`${basename(path)}:${index + 1}: ${error.message}`);
      }
    }
  }
  return records;
}

function sameTarget(left, right) {
  return left?.provider === right?.provider && left?.api === right?.api && left?.model === right?.model;
}

function privacyViolations(value, path = "$", found = []) {
  if (typeof value === "string") {
    const localPath = /(?:^|\s)(?:\/Users\/|\/private\/tmp\/|\/tmp\/)/;
    const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
    if (localPath.test(value) || uuid.test(value)) found.push(path);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => privacyViolations(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const forbidden = /^(prompt|promptText|payload|messages|toolNames|toolSchemas|sessionId|cwd|workingDirectory|responseText)$/i;
  for (const [key, nested] of Object.entries(value)) {
    if (forbidden.test(key)) found.push(`${path}.${key}`);
    privacyViolations(nested, `${path}.${key}`, found);
  }
  return found;
}

function candidateDefinitions(path) {
  if (!path) return [];
  const parsed = readJson(path);
  if (!Array.isArray(parsed)) throw new Error("candidate config must be an array");
  return parsed.map((candidate) => {
    const mechanisms = ["perMessageTokens", "toolBlockTokens", "opaqueCarrierDenominator", "imageTokens"]
      .filter((key) => candidate[key] !== undefined);
    if (typeof candidate.name !== "string" || !Array.isArray(candidate.providers) || mechanisms.length !== 1) {
      throw new Error("each candidate needs name, providers, and exactly one structural correction");
    }
    const key = mechanisms[0];
    const value = candidate[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid ${key} in ${candidate.name}`);
    if ((key === "perMessageTokens" || key === "toolBlockTokens" || key === "imageTokens") && !Number.isInteger(value)) {
      throw new Error(`${key} must be a whole token count`);
    }
    if (key === "opaqueCarrierDenominator" && Math.round(value * 10) !== value * 10) {
      throw new Error("opaqueCarrierDenominator must be rounded to one decimal");
    }
    return { ...candidate, mechanism: key };
  });
}

function flatSelectionEstimate(selection, request) {
  if (!selection) return undefined;
  const toolChars = request.provider?.toolJsonChars ?? selection.toolChars ?? 0;
  const chars = selection.systemChars + toolChars + selection.historyTextChars +
    selection.historyReasoningChars + selection.historyImageChars;
  return Math.ceil(chars / 4);
}

function candidateEstimate(candidate, request) {
  if (!candidate.providers.includes(request.target.provider) || !request.provider) return undefined;
  const provider = request.provider;
  let estimate = provider.normalizedTokens;
  if (candidate.mechanism === "perMessageTokens") estimate += provider.messageCount * candidate.perMessageTokens;
  if (candidate.mechanism === "toolBlockTokens" && provider.toolCount > 0) estimate += candidate.toolBlockTokens;
  const heuristic = builtInHeuristicForModel({
    provider: request.target.provider,
    api: request.target.api,
    id: request.target.model,
  }) ?? fallbackHeuristicNumbers();
  if (candidate.mechanism === "opaqueCarrierDenominator" && provider.opaqueReasoningChars > 0) {
    estimate -= estimateCharsAsTokens(provider.opaqueReasoningChars, heuristic.sessionDenominator);
    estimate += estimateCharsAsTokens(provider.opaqueReasoningChars, candidate.opaqueCarrierDenominator);
  }
  if (candidate.mechanism === "imageTokens" && provider.imageCount > 0) {
    estimate -= estimateCharsAsTokens(provider.imageChars, heuristic.sessionDenominator);
    estimate += provider.imageCount * candidate.imageTokens;
  }
  return estimate;
}

function joinRecords(records, candidates) {
  const requests = new Map();
  const selections = new Map();
  const resolutions = new Map();
  let duplicateResolutions = 0;
  const skipRecords = [];
  const skipCounts = {};
  const identityFailures = [];
  for (const record of records) {
    if (record.type === "request") requests.set(record.requestId, record);
    else if (record.type === "selection") selections.set(record.selectionId, record);
    else if (record.type === "resolved") {
      if (resolutions.has(record.requestId)) duplicateResolutions++;
      resolutions.set(record.requestId, record);
    }
    else skipRecords.push(record);
  }
  for (const record of skipRecords) {
    if (record.requestId && resolutions.has(record.requestId)) continue;
    skipCounts[record.type ?? "unknown"] = (skipCounts[record.type ?? "unknown"] ?? 0) + 1;
  }
  const rows = [];
  for (const [requestId, request] of requests) {
    const resolved = resolutions.get(requestId);
    if (!resolved) continue;
    if (!sameTarget(request.target, resolved.target)) {
      identityFailures.push(requestId);
      continue;
    }
    const externalCount = resolved.exactSource !== undefined;
    if (externalCount && resolved.countedModel !== request.target.model) {
      identityFailures.push(requestId);
      continue;
    }
    const selection = request.selectionId ? selections.get(request.selectionId) : undefined;
    if (selection && !sameTarget(selection.target, request.target)) identityFailures.push(requestId);
    const userTurn = request.configuredTurn ?? request.requestOrdinal;
    const requestOrdinal = request.requestOrdinal ?? 1;
    const estimates = {
      "B0-selection": flatSelectionEstimate(selection?.canonical, request),
      "B1-selection": selection?.canonical?.totalTokens,
      "B0-send": request.provider?.flatTokens ?? request.canonical?.flatTokens,
      "B1-send": request.canonical?.totalTokens,
      "P0-current-send": request.currentProviderTokens,
      "C1-normalized-send": request.provider?.normalizedTokens,
    };
    for (const candidate of candidates) estimates[candidate.name] = candidateEstimate(candidate, request);
    rows.push({
      studyRun: request.runId,
      caseId: request.caseId,
      split: request.split,
      route: request.route,
      strata: request.strata ?? [],
      userTurn,
      requestOrdinal,
      firstRequest: userTurn === 1 && requestOrdinal === 1,
      compaction: request.compaction,
      target: request.target,
      actualPromptTokens: resolved.actualPromptTokens,
      exactSource: resolved.exactSource ?? "provider-response",
      identityVerification: externalCount ? "count-endpoint-model" : "provider-response",
      usage: resolved.usage,
      canonical: request.canonical,
      provider: request.provider,
      selection: selection?.canonical,
      estimates,
    });
  }
  const unresolvedRequests = [...requests.keys()].filter((requestId) => !resolutions.has(requestId)).length;
  return { rows, skipCounts, identityFailures, unresolvedRequests, duplicateResolutions };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(probability * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function displayedBand(tokens) {
  return Math.round(tokens / 100);
}

function sizeBand(tokens) {
  if (tokens < 10_000) return "under-10k";
  if (tokens < 50_000) return "10k-to-50k";
  return "50k-plus";
}

function estimateMetrics(rows, estimator, suppressPercentages = false) {
  const comparable = rows.filter((row) => Number.isFinite(row.estimates[estimator]) && row.actualPromptTokens > 0);
  if (comparable.length === 0) return undefined;
  const errors = comparable.map((row) => row.estimates[estimator] - row.actualPromptTokens);
  const percentages = errors.map((error, index) => error / comparable[index].actualPromptTokens * 100);
  const absolutePercentages = percentages.map(Math.abs);
  const absoluteErrors = errors.map(Math.abs);
  const referenceEstimator = estimator.endsWith("selection") ? "B1-selection" : "B1-send";
  const referenceComparable = comparable.filter((row) => Number.isFinite(row.estimates[referenceEstimator]));
  return {
    requests: comparable.length,
    studyRuns: new Set(comparable.map((row) => row.studyRun)).size,
    signedMeanTokens: mean(errors),
    meanAbsoluteTokens: mean(absoluteErrors),
    medianAbsoluteTokens: quantile(absoluteErrors, 0.5),
    rawAbsoluteErrors: comparable.length < 3 ? absoluteErrors : undefined,
    ...(suppressPercentages ? {} : {
      signedMeanPercent: mean(percentages),
      meanAbsolutePercent: mean(absolutePercentages),
      medianAbsolutePercent: quantile(absolutePercentages, 0.5),
      p95AbsolutePercent: quantile(absolutePercentages, 0.95),
      within10Percent: mean(absolutePercentages.map((value) => value <= 10 ? 100 : 0)),
      within20Percent: mean(absolutePercentages.map((value) => value <= 20 ? 100 : 0)),
      displayDiffersFromActual: mean(comparable.map((row) => displayedBand(row.estimates[estimator]) !== displayedBand(row.actualPromptTokens) ? 100 : 0)),
      changesB1Display: referenceComparable.length === 0 ? undefined : mean(referenceComparable.map((row) =>
        displayedBand(row.estimates[estimator]) !== displayedBand(row.estimates[referenceEstimator]) ? 100 : 0,
      )),
      wrong10kBand: mean(comparable.map((row) => Math.floor(row.estimates[estimator] / 10_000) !== Math.floor(row.actualPromptTokens / 10_000) ? 100 : 0)),
    }),
  };
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function bootstrapImprovement(rows, simple, complex) {
  const comparable = rows.filter((row) => Number.isFinite(row.estimates[simple]) && Number.isFinite(row.estimates[complex]));
  const clusters = [...Map.groupBy(comparable, (row) => row.studyRun).values()];
  if (clusters.length < 2) return undefined;
  const random = randomGenerator(BOOTSTRAP_SEED);
  const values = [];
  for (let iteration = 0; iteration < BOOTSTRAP_SAMPLES; iteration++) {
    const sampled = [];
    for (let index = 0; index < clusters.length; index++) sampled.push(...clusters[Math.floor(random() * clusters.length)]);
    values.push(mean(sampled.map((row) => {
      const simpleError = Math.abs(row.estimates[simple] - row.actualPromptTokens) / row.actualPromptTokens * 100;
      const complexError = Math.abs(row.estimates[complex] - row.actualPromptTokens) / row.actualPromptTokens * 100;
      return simpleError - complexError;
    })));
  }
  return { lower: quantile(values, 0.025), upper: quantile(values, 0.975), samples: BOOTSTRAP_SAMPLES, seed: BOOTSTRAP_SEED };
}

function groupDefinitions(rows) {
  const groups = [];
  const addGroups = (dimension, valueFor, detailed = false) => {
    const byValue = Map.groupBy(rows, valueFor);
    for (const [value, members] of byValue) groups.push({ dimension, value, rows: members, detailed });
  };
  const context = (row) => `${row.split} / ${row.route} / ${row.target.provider}/${row.target.api}/${row.target.model}`;
  addGroups("overall", () => "all");
  addGroups("split-route-target", (row) => `${row.split} / ${row.route} / ${row.target.provider}/${row.target.api}/${row.target.model}`);
  addGroups("target", (row) => `${row.target.provider}/${row.target.api}/${row.target.model}`);
  addGroups("route", (row) => row.route);
  addGroups("split", (row) => row.split);
  addGroups("size", (row) => sizeBand(row.actualPromptTokens));
  addGroups("turn", (row) => row.firstRequest ? "first" : "later");
  addGroups("reasoning", (row) => row.provider?.retainedReasoningChars > 0 ? "present" : "absent");
  addGroups("image", (row) => row.provider?.imageCount > 0 ? "present" : "absent");
  addGroups("detailed-size", (row) => `${context(row)} / ${sizeBand(row.actualPromptTokens)}`, true);
  addGroups("detailed-turn", (row) => `${context(row)} / ${row.firstRequest ? "first" : "later"}`, true);
  addGroups("detailed-compaction", (row) => `${context(row)} / ${row.compaction ? "compacted" : "not-compacted"}`, true);
  addGroups("detailed-reasoning", (row) => `${context(row)} / ${row.provider?.retainedReasoningChars > 0 ? "present" : "absent"}`, true);
  addGroups("detailed-image", (row) => `${context(row)} / ${row.provider?.imageCount > 0 ? "present" : "absent"}`, true);
  const tags = new Set(rows.flatMap((row) => row.strata));
  for (const tag of tags) {
    const members = rows.filter((row) => row.strata.includes(tag));
    groups.push({ dimension: "declared-stratum", value: tag, rows: members, detailed: false });
    const contextual = Map.groupBy(members, context);
    for (const [value, contextualRows] of contextual) {
      groups.push({ dimension: "detailed-declared-stratum", value: `${value} / ${tag}`, rows: contextualRows, detailed: true });
    }
  }
  return groups;
}

function summarize(rows, estimatorNames) {
  return groupDefinitions(rows).map((group) => {
    const metrics = Object.fromEntries(estimatorNames.map((name) => [
      name,
      estimateMetrics(group.rows, name, group.rows.length < 3),
    ]));
    const comparisons = {};
    const pairs = [
      ["B0-selection", "B1-selection"],
      ["B0-send", "B1-send"],
      ["B1-send", "C1-normalized-send"],
      ["B1-send", "P0-current-send"],
    ];
    for (const name of estimatorNames.filter((name) => ![
      "B0-selection", "B1-selection", "B0-send", "B1-send", "P0-current-send", "C1-normalized-send",
    ].includes(name))) {
      pairs.push(["C1-normalized-send", name]);
    }
    for (const [simple, complex] of pairs) {
      comparisons[`${simple} -> ${complex}`] = group.rows.length < 3
        ? undefined
        : bootstrapImprovement(group.rows, simple, complex);
    }
    return { dimension: group.dimension, value: group.value, requests: group.rows.length, metrics, comparisons };
  });
}

function acceptanceSummary(groups, validation) {
  const limits = { absoluteBiasPercent: 5, medianAbsolutePercent: 10, p95AbsolutePercent: 25, directionMapePercent: 15 };
  const summaries = [];
  for (const group of groups.filter((item) => item.dimension === "split-route-target" && item.value.startsWith("holdout / direct / "))) {
    const prefix = `${group.value} / `;
    const directionGroups = groups.filter((item) => item.dimension === "detailed-declared-stratum" &&
      item.value.startsWith(prefix) && item.value.includes("direction:") && item.requests >= 3);
    for (const [phase, estimators] of Object.entries({
      selection: ["B0-selection", "B1-selection"],
      send: ["B0-send", "B1-send", "P0-current-send", "C1-normalized-send", "C2-anthropic-tool-block"],
    })) {
      for (const estimator of estimators) {
        const metrics = group.metrics[estimator];
        if (!metrics) continue;
        const populatedDirections = directionGroups
          .map((item) => ({ value: item.value.slice(prefix.length), metrics: item.metrics[estimator] }))
          .filter((item) => item.metrics);
        const failures = [];
        if (Math.abs(metrics.signedMeanPercent) > limits.absoluteBiasPercent) failures.push("bias");
        if (metrics.medianAbsolutePercent > limits.medianAbsolutePercent) failures.push("median");
        if (metrics.p95AbsolutePercent > limits.p95AbsolutePercent) failures.push("p95");
        if (populatedDirections.some((item) => item.metrics.meanAbsolutePercent > limits.directionMapePercent)) failures.push("direction");
        if (metrics.requests < 12 || metrics.studyRuns < 6) failures.push("coverage");
        if (validation.identityFailures > 0 || validation.unresolvedRequests > 0 ||
            validation.duplicateResolutions > 0 || validation.privacyViolations.length > 0) failures.push("validation");
        summaries.push({
          target: group.value.slice("holdout / direct / ".length),
          phase,
          estimator,
          acceptable: failures.length === 0,
          failures,
          metrics,
          populatedDirections,
        });
      }
    }
  }
  return { limits, summaries };
}

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function markdownReport(report) {
  const lines = [
    "# Token estimator study analysis",
    "",
    `Dataset: ${report.dataset.requests} resolved requests across ${report.dataset.studyRuns} study runs.`,
    `Identity failures: ${report.validation.identityFailures}; unresolved requests: ${report.validation.unresolvedRequests}; duplicate resolutions: ${report.validation.duplicateResolutions}; privacy violations: ${report.validation.privacyViolations.length}; split failures: ${report.validation.splitFailures.length}.`,
    "",
    "## Primary metrics",
    "",
    "| Split / route / target | Estimator | n | Bias | MAPE | Median APE | p95 APE | Within 10% | Wrong 10k band |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const primaryDimensions = new Set(["split-route-target"]);
  for (const group of report.groups.filter((item) => primaryDimensions.has(item.dimension))) {
    for (const [name, metrics] of Object.entries(group.metrics)) {
      if (!metrics) continue;
      lines.push(`| ${group.value} | ${name} | ${metrics.requests} | ${fixed(metrics.signedMeanPercent)}% | ${fixed(metrics.meanAbsolutePercent)}% | ${fixed(metrics.medianAbsolutePercent)}% | ${fixed(metrics.p95AbsolutePercent)}% | ${fixed(metrics.within10Percent)}% | ${fixed(metrics.wrong10kBand)}% |`);
    }
  }
  lines.push("", "## Coverage", "");
  for (const [key, value] of Object.entries(report.coverage)) lines.push(`- ${key}: ${value}`);
  lines.push("", "## Capture exclusions", "");
  const skips = Object.entries(report.validation.skipCounts);
  if (skips.length === 0) lines.push("- None recorded.");
  else for (const [key, value] of skips) lines.push(`- ${key}: ${value}`);
  lines.push("", "Full split, route, size, turn, reasoning, image and declared-stratum metrics are in the JSON report.", "");
  return lines.join("\n");
}

const options = parseArgs(process.argv.slice(2));
const records = readJsonl(options.inputs);
const candidates = candidateDefinitions(options.candidates);
const joined = joinRecords(records, candidates);
const violations = privacyViolations({ candidates, rows: joined.rows });
const runs = Map.groupBy(joined.rows, (row) => row.studyRun);
const splitFailures = [...runs.entries()]
  .filter(([, rows]) => new Set(rows.map((row) => row.split)).size > 1)
  .map(([run]) => run);
const estimatorNames = [
  "B0-selection",
  "B1-selection",
  "B0-send",
  "B1-send",
  "P0-current-send",
  "C1-normalized-send",
  ...candidates.map((item) => item.name),
];
const dataset = {
  schemaVersion: 1,
  bootstrap: { samples: BOOTSTRAP_SAMPLES, seed: BOOTSTRAP_SEED },
  candidates,
  rows: joined.rows,
};
const groups = summarize(joined.rows, estimatorNames);
const validation = {
  identityFailures: joined.identityFailures.length,
  responseIdentityVerified: joined.rows.filter((row) => row.identityVerification === "provider-response").length,
  countEndpointIdentityVerified: joined.rows.filter((row) => row.identityVerification === "count-endpoint-model").length,
  unresolvedRequests: joined.unresolvedRequests,
  duplicateResolutions: joined.duplicateResolutions,
  privacyViolations: violations,
  splitFailures,
  skipCounts: joined.skipCounts,
};
const report = {
  schemaVersion: 1,
  dataset: { requests: joined.rows.length, studyRuns: runs.size },
  validation,
  coverage: {
    "direct development": joined.rows.filter((row) => row.route === "direct" && row.split === "development").length,
    "direct holdout": joined.rows.filter((row) => row.route === "direct" && row.split === "holdout").length,
    "gateway diagnostic": joined.rows.filter((row) => row.route === "gateway").length,
    "reasoning-bearing": joined.rows.filter((row) => row.provider?.retainedReasoningChars > 0).length,
    "image-bearing": joined.rows.filter((row) => row.provider?.imageCount > 0).length,
  },
  groups,
  acceptance: acceptanceSummary(groups, validation),
};
writeFileSync(options.dataset, `${JSON.stringify(dataset, null, 2)}\n`);
writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(options.markdown, markdownReport(report));
console.log(`analyzed ${joined.rows.length} resolved requests from ${runs.size} study runs`);
