#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cacheClock } from "../../extensions/pi-cachemire/clock.ts";
import {
  OPENAI_EXTENDED_WINDOW,
  OPENAI_MINIMUM_WINDOW,
  RETENTION_EVIDENCE_SOURCES,
  RETENTION_POLICIES,
} from "../../extensions/pi-cachemire/retention.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const check = process.argv.includes("--check");
const MINUTE = 60_000;

function replaceGeneratedBlock(source, kind, body, path) {
  const start = `<!-- BEGIN GENERATED CACHE RETENTION: ${kind} -->`;
  const end = `<!-- END GENERATED CACHE RETENTION: ${kind} -->`;
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    throw new Error(`${path}: missing generated block markers for ${kind}`);
  }
  if (source.indexOf(start, startAt + start.length) !== -1 ||
      source.indexOf(end, endAt + end.length) !== -1) {
    throw new Error(`${path}: duplicate generated block markers for ${kind}`);
  }
  const afterEnd = endAt + end.length;
  return source.slice(0, startAt) + `${start}\n${body.trim()}\n${end}` + source.slice(afterEnd);
}

function sourceLink(source) {
  return source.url === undefined ? source.label : `[${source.label}](${source.url})`;
}

function markdownCell(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function policyTable() {
  const rows = RETENTION_POLICIES.map((policy) =>
    `| ${markdownCell(policy.route)} | ${markdownCell(policy.evidence)} | ` +
    `${markdownCell(policy.behavior)} | ` +
    `${markdownCell(policy.sourceIds.map((id) => sourceLink(RETENTION_EVIDENCE_SOURCES[id])).join(", "))} |`
  );
  return [
    "| Route | Retention evidence | Cachemire behaviour | Evidence source |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const evidenceSources = Object.values(RETENTION_EVIDENCE_SOURCES)
  .map((source) => `- ${sourceLink(source)}, reviewed ${source.reviewedOn}: ${source.detail}`)
  .join("\n");

function renderedClock(input) {
  const text = cacheClock(input).text;
  if (text === "") throw new Error("documentation clock fixture rendered no notice");
  return `◍ ${text}`;
}

const contract = { kind: "contract", ttlMs: 5 * MINUTE, source: "observed" };
const common = { lastRequestAt: 0, cachedTokens: 109_800, rewriteUsd: 1.37 };
const clockExamples = [
  "```text",
  renderedClock({ ...common, now: 4.5 * MINUTE, window: contract }),
  renderedClock({ ...common, now: 30 * MINUTE, window: OPENAI_MINIMUM_WINDOW }),
  renderedClock({ ...common, now: 24 * 60 * MINUTE, window: OPENAI_EXTENDED_WINDOW }),
  renderedClock({ ...common, now: 6 * MINUTE, window: contract }),
  renderedClock({ ...common, now: MINUTE, window: contract, compacted: true }),
  "```",
].join("\n");

const targets = [
  {
    path: "extensions/pi-cachemire/README.md",
    blocks: { "policy-table": policyTable(), "clock-examples": clockExamples },
  },
  {
    path: "docs/cache-retention-audit-2026-08-04.md",
    blocks: { "evidence-sources": evidenceSources, "policy-table": policyTable() },
  },
];

const stale = [];
for (const target of targets) {
  const path = `${root}/${target.path}`;
  const before = readFileSync(path, "utf8");
  let after = before;
  for (const [kind, body] of Object.entries(target.blocks)) {
    after = replaceGeneratedBlock(after, kind, body, target.path);
  }
  if (after === before) continue;
  stale.push(target.path);
  if (!check) writeFileSync(path, after);
}

if (check && stale.length > 0) {
  console.error(`cache retention docs are stale: ${stale.join(", ")}`);
  console.error("run: npm run docs:cache");
  process.exitCode = 1;
} else if (!check) {
  console.log(stale.length === 0 ? "cache retention docs already current" : `updated ${stale.join(", ")}`);
}
