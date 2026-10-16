import { stripAnsi } from "../_lib/ansi.ts";
import type { ToolResultLike, ToolRowDataLike } from "../_lib/chat.ts";
import { resultText } from "./records.ts";

// Check facts need both a checker invocation and its printed summary (§9.10.1).
export type CheckTone = "text" | "warning" | "error";
export type CheckFact = { verb: "passed" | "failed" | "found"; datum: string; at: number; tone: CheckTone };

// Gates name a checker invocation, not a word: `cat test-log.txt` must not qualify. A
// package script such as `pnpm test`, `npm run lint:slop` or `npm run check` counts.
const SCRIPT = String.raw`\b(?:npm|pnpm|yarn|bun)(?:\s+-\S+)*\s+(?:run\s+)?`;
const TEST_GATE = new RegExp(String.raw`${SCRIPT}(?:test|t|check)\b|\b(?:vitest|jest|pytest|mocha|tox)\b|\b(?:cargo|go|make)\s+(?:test|nextest|check)\b|\bnode\s+(?:\S+\s+)*?--test\b`);
const TYPE_GATE = new RegExp(String.raw`${SCRIPT}(?:typecheck|type-check|types|check)\b|\b(?:tsc|vue-tsc)\b`);
const LINT_GATE = new RegExp(String.raw`${SCRIPT}(?:lint|check)\b|\b(?:eslint|oxlint|biome|ruff)\b`);
const FORMAT_GATE = /\bprettier\b/;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Counts inside summaries such as `2 failed | 1729 passed` or `2 failed, 40 passed`.
function countOf(summary: string, names: RegExp): number {
  let total = 0;
  for (const m of summary.matchAll(new RegExp(`(\\d+) (?:${names.source})\\b`, "g"))) total += Number(m[1]);
  return total;
}

type Line = { text: string; at: number; n: number };

// One summary is one run (§9.10.1): counts never add up across runs, because agents
// rerun checks in loops and comparisons and a sum is a number no run printed. A runner
// prints its summary as a few adjacent lines in a fixed order (Vitest `Test Files`,
// `Tests`, `Errors`; node `tests`, `pass`, `fail`, `cancelled`), so a part joins the
// open run while it is near and later in that order; otherwise it starts the next run.
type TestCounts = {
  passed?: number;
  failed?: number;
  /** node's `ℹ tests N`, a total when the pass count was piped away. */
  tests?: number;
  /** node's cancelled tests, which fail the run. */
  cancelled?: number;
  files?: { failed: number; total: number };
  unhandled?: number;
};

type TestRun = TestCounts & {
  at: number;
  last: number;
  /** The summary proves the run's total: a pass needs it (§9.10.1). */
  proven: boolean;
};

/** One line's share of a summary; `rank` is its place in the runner's summary order. */
type RunPart = { line: Line; rank: number; summary: TestCounts & { proven?: true } };

const RUN_REACH = 3; // agent-default (not a user rule): 2026-10-15

function joinRuns(parts: RunPart[]): TestRun[] {
  const runs: TestRun[] = [];
  let rank = -1;
  for (const part of parts) {
    const open = runs[runs.length - 1];
    if (!open || part.line.n - open.last > RUN_REACH || part.rank <= rank) {
      runs.push({ at: part.line.at, last: part.line.n, proven: false, ...part.summary });
    } else {
      Object.assign(open, part.summary);
      open.last = part.line.n;
    }
    rank = part.rank;
  }
  return runs;
}

const NODE_ORDER = ["tests", "pass", "fail", "cancelled"];

function lintFact(errors: number, warnings: number, at: number): CheckFact {
  if (errors > 0) return { verb: "found", datum: plural(errors, "lint error"), at, tone: "error" };
  if (warnings > 0) return { verb: "found", datum: plural(warnings, "lint warning"), at, tone: "warning" };
  return { verb: "passed", datum: "lint", at, tone: "text" };
}

const checkFactCache = new WeakMap<ToolRowDataLike, { result: ToolResultLike; facts: CheckFact[] }>();

/** Check facts for a settled bash row, one per run, in output order. */
export function checkFacts(comp: ToolRowDataLike): CheckFact[] {
  if (comp.toolName !== "bash") return [];
  const command = comp.args?.command;
  if (typeof command !== "string" || !comp.result || comp.isPartial === true) return [];
  const cached = checkFactCache.get(comp);
  if (cached && cached.result === comp.result) return cached.facts;
  const out = stripAnsi(resultText(comp));
  const facts: CheckFact[] = [];
  if (TEST_GATE.test(command)) {
    const suiteParts: RunPart[] = [];
    const nodeParts: RunPart[] = [];
    const pytestRuns: TestRun[] = [];
    const cargoRuns: TestRun[] = [];
    let cargoRun: (TestRun & { passed: number; failed: number }) | undefined;
    let at = 0;
    for (const [n, text] of out.split("\n").entries()) {
      const line: Line = { text, at, n };
      at += text.length + 1;
      const tests = /(?:^|\s)Tests\s{2,}(.+?)\s*\(\d+\)\s*$/.exec(line.text) ?? /^Tests:\s+(.+?),\s*\d+ total\s*$/.exec(line.text);
      const files = /(?:^|\s)Test Files\s{2,}(.+?)\s*\((\d+)\)\s*$/.exec(line.text) ?? /^Test Suites:\s+(.+?),\s*(\d+) total\s*$/.exec(line.text);
      const errors = /(?:^|\s)Errors\s{2,}(\d+) errors?\b/.exec(line.text);
      if (tests) {
        suiteParts.push({ line, rank: 1, summary: { passed: countOf(tests[1]!, /passed/), failed: countOf(tests[1]!, /failed/), proven: true } });
      } else if (files) {
        suiteParts.push({ line, rank: 0, summary: { files: { failed: countOf(files[1]!, /failed/), total: Number(files[2]) } } });
      } else if (errors) {
        suiteParts.push({ line, rank: 2, summary: { unhandled: Number(errors[1]) } });
      }

      const tokens = /^# (?:tests|pass|fail|cancelled) \d+/.test(line.text) ? /(?:^|\s)[\u2139#] (tests|pass|fail|cancelled) (\d+)(?!\S)/g : /(?:^|\s)\u2139 (tests|pass|fail|cancelled) (\d+)(?!\S)/g;
      for (const m of line.text.matchAll(tokens)) {
        const kind = m[1]!;
        const count = Number(m[2]);
        const summary: TestCounts = {};
        if (kind === "pass") summary.passed = count;
        else if (kind === "fail") summary.failed = count;
        else if (kind === "tests") summary.tests = count;
        else summary.cancelled = count;
        nodeParts.push({ line, rank: NODE_ORDER.indexOf(kind), summary });
      }

      const pytest = /^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected)(?:, )?)+) in [\d.]+s\b/.exec(line.text);
      if (pytest) pytestRuns.push({ at: line.at, last: line.n, passed: countOf(pytest[1]!, /passed/), failed: countOf(pytest[1]!, /failed|errors?/), proven: true });

      if (/^\s*Finished\b/.test(line.text)) cargoRun = undefined;
      const cargo = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/.exec(line.text);
      if (!cargo) continue;
      if (!cargoRun) cargoRuns.push((cargoRun = { at: line.at, last: line.n, passed: 0, failed: 0, proven: true }));
      cargoRun.passed += Number(cargo[1]);
      cargoRun.failed += Number(cargo[2]);
    }
    const nodeRuns = joinRuns(nodeParts);
    for (const run of nodeRuns) {
      // A node run proves its total with a `fail` count, or a matching `tests` count.
      run.proven = run.failed !== undefined || (run.tests !== undefined && run.tests === run.passed);
      if (run.failed !== undefined || run.cancelled) run.failed = (run.failed ?? 0) + (run.cancelled ?? 0);
    }
    const used = [joinRuns(suiteParts), nodeRuns, pytestRuns, cargoRuns].filter((runs) => runs.length > 0);
    let runs = used.flat();
    if (used.length > 1 && used.every((runner) => runner.length === 1) && runs.every((run) => run.proven)) {
      const sum = (count: (run: TestRun) => number | undefined) =>
        runs.some((run) => count(run) !== undefined) ? runs.reduce((total, run) => total + (count(run) ?? 0), 0) : undefined;
      const fileRuns = runs.flatMap((run) => (run.files ? [run.files] : []));
      runs = [{
        at: Math.min(...runs.map((run) => run.at)),
        last: Math.max(...runs.map((run) => run.last)),
        passed: sum((run) => run.passed),
        failed: sum((run) => run.failed),
        unhandled: sum((run) => run.unhandled),
        files: fileRuns.length ? { failed: fileRuns.reduce((n, f) => n + f.failed, 0), total: fileRuns.reduce((n, f) => n + f.total, 0) } : undefined,
        proven: true,
      }];
    }
    for (const run of runs) {
      const passed = run.passed ?? 0;
      const failed = run.failed ?? 0;
      if (failed > 0) {
        const total = run.passed !== undefined ? passed + failed : run.tests;
        facts.push({ verb: "failed", datum: total === undefined ? plural(failed, "test") : `${failed} of ${plural(total, "test")}`, at: run.at, tone: "error" });
        continue;
      }
      if (run.files && run.files.failed > 0) facts.push({ verb: "failed", datum: `${run.files.failed} of ${plural(run.files.total, "test file")}`, at: run.at, tone: "error" });
      else if (run.unhandled) facts.push({ verb: "found", datum: plural(run.unhandled, "unhandled error"), at: run.at, tone: "error" });
      else if (passed > 0 && run.proven) facts.push({ verb: "passed", datum: plural(passed, "test"), at: run.at, tone: "text" });
    }
  }
  if (TYPE_GATE.test(command)) {
    const before = facts.length;
    for (const m of out.matchAll(/^Found (\d+) errors? in /gm)) {
      if (Number(m[1]) > 0) facts.push({ verb: "found", datum: plural(Number(m[1]), "type error"), at: m.index, tone: "error" });
    }
    if (facts.length === before) {
      const diagnostic = /\berror TS\d+:/.exec(out);
      if (diagnostic) facts.push({ verb: "found", datum: "type errors", at: diagnostic.index, tone: "error" });
    }
  }
  if (LINT_GATE.test(command)) {
    for (const m of out.matchAll(/\u2716 \d+ problems? \((\d+) errors?, (\d+) warnings?\)/g)) facts.push(lintFact(Number(m[1]), Number(m[2]), m.index));
    for (const m of out.matchAll(/^Found (\d+) warnings? and (\d+) errors?\.?\s*$/gm)) facts.push(lintFact(Number(m[2]), Number(m[1]), m.index));
    for (const m of out.matchAll(/^Found (\d+) errors?\.\s*$/gm)) facts.push(lintFact(Number(m[1]), 0, m.index));
    for (const m of out.matchAll(/^All checks passed!\s*$/gm)) facts.push(lintFact(0, 0, m.index));
  }
  if (FORMAT_GATE.test(command)) {
    for (const m of out.matchAll(/Code style issues found in (?:(\d+) files?|the above file)/g)) {
      const files = m[1] === undefined ? 1 : Number(m[1]);
      facts.push({ verb: "found", datum: plural(files, "unformatted file"), at: m.index, tone: "warning" });
    }
    for (const m of out.matchAll(/All matched files use Prettier code style!/g)) facts.push({ verb: "passed", datum: "format", at: m.index, tone: "text" });
  }
  facts.sort((a, b) => a.at - b.at);
  checkFactCache.set(comp, { result: comp.result, facts });
  return facts;
}

/** True when a check in the row's output reported a failure (§9.2, §9.10.1). */
export function checkFailed(comp: ToolRowDataLike): boolean {
  return checkFacts(comp).some((fact) => fact.tone === "error");
}
