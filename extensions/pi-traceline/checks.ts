import { stripAnsi } from "../_lib/ansi.ts";
import type { ToolRowDataLike } from "../_lib/chat.ts";
import { resultText } from "./records.ts";

// Check facts (design language §9.10.1): test, type-check, lint and format outcomes
// parsed from the summary a checker printed. Evidence only: the command must name the
// checker and the output must carry its summary, so a quiet `tsc` or a `cat` of a log
// file earns nothing. A pass is health (neutral ink); a failure is news.
export type CheckTone = "text" | "warning" | "error";
export type CheckFact = { verb: string; datum: string; at: number; tone: CheckTone };

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

// `name 12` pairs inside a summary such as `2 failed | 1729 passed` or `2 failed, 40 passed`.
function countOf(summary: string, names: RegExp): number {
  let total = 0;
  for (const m of summary.matchAll(new RegExp(`(\\d+) (?:${names.source})\\b`, "g"))) total += Number(m[1]);
  return total;
}

type Line = { text: string; at: number; n: number };

function linesOf(out: string): Line[] {
  const lines: Line[] = [];
  let at = 0;
  for (const [n, text] of out.split("\n").entries()) {
    lines.push({ text, at, n });
    at += text.length + 1;
  }
  return lines;
}

// One summary is one run (§9.10.1): counts never add up across runs, because agents
// rerun checks in loops and comparisons and a sum is a number no run printed. A runner
// prints its summary as a few adjacent lines in a fixed order (Vitest `Test Files`,
// `Tests`, `Errors`; node `tests`, `pass`, `fail`, `cancelled`), so a part joins the
// open run while it is near and later in that order; otherwise it starts the next run.
type TestRun = {
  at: number;
  last: number;
  passed?: number;
  failed?: number;
  /** The summary proves the run's total: a pass needs it (§9.10.1). */
  proven: boolean;
  /** node's `ℹ tests N`, a total when the pass count was piped away. */
  tests?: number;
  /** node's cancelled tests, which fail the run. */
  cancelled?: number;
  files?: { failed: number; total: number };
  unhandled?: number;
};

/** One line's share of a summary; `rank` is its place in the runner's summary order. */
type RunPart = { line: Line; rank: number; fill: (run: TestRun) => void };

const RUN_REACH = 3; // agent-default (not a user rule): 2026-10-15

function joinRuns(parts: RunPart[]): TestRun[] {
  const runs: TestRun[] = [];
  let rank = -1;
  for (const part of parts) {
    const open = runs[runs.length - 1];
    if (open && part.line.n - open.last <= RUN_REACH && part.rank > rank) open.last = part.line.n;
    else runs.push({ at: part.line.at, last: part.line.n, proven: false });
    rank = part.rank;
    part.fill(runs[runs.length - 1]!);
  }
  return runs;
}

// Vitest prints `Test Files  1 failed | 4 passed (5)`, `Tests  2 failed | 1729 passed
// (1731)` and, after unhandled errors, `Errors  1 error`, which a loop may prefix with
// its own label (`Europe/London  Tests  5 passed (5)`); Jest prints `Test Suites:` and
// `Tests:` lines with a `N total`.
function suiteParts(lines: Line[]): RunPart[] {
  const parts: RunPart[] = [];
  for (const line of lines) {
    const tests = /(?:^|\s)Tests\s{2,}(.+?)\s*\(\d+\)\s*$/.exec(line.text) ?? /^Tests:\s+(.+?),\s*\d+ total\s*$/.exec(line.text);
    const files = /(?:^|\s)Test Files\s{2,}(.+?)\s*\((\d+)\)\s*$/.exec(line.text) ?? /^Test Suites:\s+(.+?),\s*(\d+) total\s*$/.exec(line.text);
    const errors = /(?:^|\s)Errors\s{2,}(\d+) errors?\b/.exec(line.text);
    if (tests) {
      parts.push({ line, rank: 1, fill: (run) => Object.assign(run, { passed: countOf(tests[1]!, /passed/), failed: countOf(tests[1]!, /failed/), proven: true }) });
    } else if (files) {
      parts.push({ line, rank: 0, fill: (run) => (run.files = { failed: countOf(files[1]!, /failed/), total: Number(files[2]) }) });
    } else if (errors) {
      parts.push({ line, rank: 2, fill: (run) => (run.unhandled = Number(errors[1])) });
    }
  }
  return parts;
}

const NODE_ORDER = ["tests", "pass", "fail", "cancelled"];

// node --test: spec `ℹ pass 12` or TAP `# pass 12`, one per line or joined onto one
// line by `| tr '\n' ' '`. Cancelled tests fail the run, so they count as failed.
function nodeParts(lines: Line[]): RunPart[] {
  const parts: RunPart[] = [];
  for (const line of lines) {
    const tokens = /^# (?:tests|pass|fail|cancelled) \d+/.test(line.text) ? /(?:^|\s)[\u2139#] (tests|pass|fail|cancelled) (\d+)(?!\S)/g : /(?:^|\s)\u2139 (tests|pass|fail|cancelled) (\d+)(?!\S)/g;
    for (const m of line.text.matchAll(tokens)) {
      const kind = m[1]!;
      const count = Number(m[2]);
      parts.push({
        line,
        rank: NODE_ORDER.indexOf(kind),
        fill: (run) => {
          if (kind === "pass") run.passed = count;
          else if (kind === "fail") run.failed = count;
          else if (kind === "tests") run.tests = count;
          else run.cancelled = count;
        },
      });
    }
  }
  return parts;
}

// A node run proves its total with a `fail` count, or a `tests` count its passes match.
function settleNode(run: TestRun): TestRun {
  const proven = run.failed !== undefined || (run.tests !== undefined && run.tests === run.passed);
  const failed = run.failed === undefined && !run.cancelled ? undefined : (run.failed ?? 0) + (run.cancelled ?? 0);
  return { ...run, failed, proven };
}

// pytest: `===== 1 failed, 11 passed in 0.52s =====`, or the -q form without rules.
// It names only the outcomes that occurred, so the line proves its own total.
function pytestRuns(lines: Line[]): TestRun[] {
  const runs: TestRun[] = [];
  for (const line of lines) {
    const m = /^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected)(?:, )?)+) in [\d.]+s\b/.exec(line.text);
    if (m) runs.push({ at: line.at, last: line.n, passed: countOf(m[1]!, /passed/), failed: countOf(m[1]!, /failed|errors?/), proven: true });
  }
  return runs;
}

// cargo prints `test result: ok. 22 passed; 1 failed; 0 ignored` per test target; one
// invocation's lines are one run, and its `Finished` line starts the next.
function cargoRuns(lines: Line[]): TestRun[] {
  const runs: TestRun[] = [];
  let open: TestRun | undefined;
  for (const line of lines) {
    if (/^\s*Finished\b/.test(line.text)) open = undefined;
    const m = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/.exec(line.text);
    if (!m) continue;
    if (!open) runs.push((open = { at: line.at, last: line.n, passed: 0, failed: 0, proven: true }));
    open.passed! += Number(m[1]);
    open.failed! += Number(m[2]);
  }
  return runs;
}

// Worst outcome first: failed tests, then test files that failed to load, then
// unhandled errors; a pass only when the summary proves there were no failures.
function testRunFact(run: TestRun): CheckFact | undefined {
  const passed = run.passed ?? 0;
  const failed = run.failed ?? 0;
  if (failed > 0) {
    const total = run.passed !== undefined ? passed + failed : run.tests;
    return { verb: "failed", datum: total === undefined ? plural(failed, "test") : `${failed} of ${plural(total, "test")}`, at: run.at, tone: "error" };
  }
  if (run.files && run.files.failed > 0) return { verb: "failed", datum: `${run.files.failed} of ${plural(run.files.total, "test file")}`, at: run.at, tone: "error" };
  if (run.unhandled) return { verb: "found", datum: plural(run.unhandled, "unhandled error"), at: run.at, tone: "error" };
  if (passed > 0 && run.proven) return { verb: "passed", datum: plural(passed, "test"), at: run.at, tone: "text" };
  return undefined;
}

// One command that runs several different runners once each (vitest, then node --test)
// checked several suites, not one suite several times, so their counts add up. The
// same runner twice is a rerun and stays separate (§9.10.1).
function oneCheckOfSuites(byRunner: TestRun[][]): TestRun[] {
  const used = byRunner.filter((runs) => runs.length > 0);
  const runs = used.flat();
  if (used.length < 2 || used.some((runner) => runner.length > 1) || !runs.every((run) => run.proven)) return runs;
  const sum = (count: (run: TestRun) => number | undefined) =>
    runs.some((run) => count(run) !== undefined) ? runs.reduce((total, run) => total + (count(run) ?? 0), 0) : undefined;
  const fileRuns = runs.flatMap((run) => (run.files ? [run.files] : []));
  return [{
    at: Math.min(...runs.map((run) => run.at)),
    last: Math.max(...runs.map((run) => run.last)),
    passed: sum((run) => run.passed),
    failed: sum((run) => run.failed),
    unhandled: sum((run) => run.unhandled),
    files: fileRuns.length ? { failed: fileRuns.reduce((n, f) => n + f.failed, 0), total: fileRuns.reduce((n, f) => n + f.total, 0) } : undefined,
    proven: true,
  }];
}

function testFacts(out: string): CheckFact[] {
  const lines = linesOf(out);
  const runs = oneCheckOfSuites([joinRuns(suiteParts(lines)), joinRuns(nodeParts(lines)).map(settleNode), pytestRuns(lines), cargoRuns(lines)]);
  return runs.flatMap((run) => testRunFact(run) ?? []);
}

// tsc: `Found 3 errors in 2 files.` carries the count, but tsc prints it only to a
// terminal. Without it the diagnostics themselves (`error TS2322:`) prove failure, but
// agents pipe tsc through `head`, so their number is only a lower bound and the fact
// states none.
function typeFacts(out: string): CheckFact[] {
  const facts: CheckFact[] = [];
  for (const m of out.matchAll(/^Found (\d+) errors? in /gm)) {
    if (Number(m[1]) > 0) facts.push({ verb: "found", datum: plural(Number(m[1]), "type error"), at: m.index, tone: "error" });
  }
  if (facts.length) return facts;
  const diagnostic = /\berror TS\d+:/.exec(out);
  return diagnostic ? [{ verb: "found", datum: "type errors", at: diagnostic.index, tone: "error" }] : [];
}

function lintFact(errors: number, warnings: number, at: number): CheckFact {
  if (errors > 0) return { verb: "found", datum: plural(errors, "lint error"), at, tone: "error" };
  if (warnings > 0) return { verb: "found", datum: plural(warnings, "lint warning"), at, tone: "warning" };
  return { verb: "passed", datum: "lint", at, tone: "text" };
}

// ESLint `✖ 5 problems (3 errors, 2 warnings)`, oxlint `Found 2 warnings and 0 errors.`,
// ruff and Biome `Found 3 errors.`, ruff `All checks passed!`.
function lintFacts(out: string): CheckFact[] {
  const facts: CheckFact[] = [];
  for (const m of out.matchAll(/\u2716 \d+ problems? \((\d+) errors?, (\d+) warnings?\)/g)) facts.push(lintFact(Number(m[1]), Number(m[2]), m.index));
  for (const m of out.matchAll(/^Found (\d+) warnings? and (\d+) errors?\.?\s*$/gm)) facts.push(lintFact(Number(m[2]), Number(m[1]), m.index));
  for (const m of out.matchAll(/^Found (\d+) errors?\.\s*$/gm)) facts.push(lintFact(Number(m[1]), 0, m.index));
  for (const m of out.matchAll(/^All checks passed!\s*$/gm)) facts.push(lintFact(0, 0, m.index));
  return facts;
}

// Prettier --check: `All matched files use Prettier code style!` or
// `[warn] Code style issues found in 2 files. Run Prettier with --write to fix.`
function formatFacts(out: string): CheckFact[] {
  const facts: CheckFact[] = [];
  for (const m of out.matchAll(/Code style issues found in (?:(\d+) files?|the above file)/g)) {
    const files = m[1] === undefined ? 1 : Number(m[1]);
    facts.push({ verb: "found", datum: plural(files, "unformatted file"), at: m.index, tone: "warning" });
  }
  for (const m of out.matchAll(/All matched files use Prettier code style!/g)) facts.push({ verb: "passed", datum: "format", at: m.index, tone: "text" });
  return facts;
}

const checkFactCache = new WeakMap<object, { result: unknown; facts: CheckFact[] }>();

/** Check facts for a settled bash row, one per run, in output order. */
export function checkFacts(comp: ToolRowDataLike): CheckFact[] {
  if (comp?.toolName !== "bash") return [];
  const command = comp.args?.command;
  if (typeof command !== "string" || !comp.result || typeof comp.result !== "object" || comp.isPartial === true) return [];
  const cached = checkFactCache.get(comp);
  if (cached && cached.result === comp.result) return cached.facts;
  const out = stripAnsi(resultText(comp));
  const facts: CheckFact[] = [];
  if (out) {
    const parsers: [RegExp, (text: string) => CheckFact[]][] = [
      [TEST_GATE, testFacts],
      [TYPE_GATE, typeFacts],
      [LINT_GATE, lintFacts],
      [FORMAT_GATE, formatFacts],
    ];
    for (const [gate, parse] of parsers) if (gate.test(command)) facts.push(...parse(out));
    facts.sort((a, b) => a.at - b.at);
  }
  checkFactCache.set(comp, { result: comp.result, facts });
  return facts;
}

/** True when a check in the row's output reported a failure (§9.2, §9.10.1). */
export function checkFailed(comp: ToolRowDataLike): boolean {
  return checkFacts(comp).some((fact) => fact.tone === "error");
}
