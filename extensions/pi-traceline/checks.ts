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

type Tally = { passed: number; failed: number; at: number | undefined };

function note(tally: Tally, at: number | undefined): void {
  if (at !== undefined && (tally.at === undefined || at < tally.at)) tally.at = at;
}

// `name 12` pairs inside a summary such as `2 failed | 1729 passed` or `2 failed, 40 passed`.
function countOf(summary: string, names: RegExp): number {
  let total = 0;
  for (const m of summary.matchAll(new RegExp(`(\\d+) (?:${names.source})\\b`, "g"))) total += Number(m[1]);
  return total;
}

const FAILED_NAMES = /failed|errors?/;

function testTally(out: string): Tally {
  const tally: Tally = { passed: 0, failed: 0, at: undefined };
  const add = (summary: string, at: number | undefined) => {
    tally.passed += countOf(summary, /passed/);
    tally.failed += countOf(summary, FAILED_NAMES);
    note(tally, at);
  };
  // Vitest: `      Tests  2 failed | 1729 passed (1731)`
  for (const m of out.matchAll(/^\s*Tests\s{2,}(.+?)\s*\(\d+\)\s*$/gm)) add(m[1]!, m.index);
  // Jest: `Tests:       2 failed, 40 passed, 42 total`
  for (const m of out.matchAll(/^Tests:\s+(.+?),\s*\d+ total\s*$/gm)) add(m[1]!, m.index);
  // pytest: `===== 1 failed, 11 passed in 0.52s =====`, or the -q form without rules
  for (const m of out.matchAll(/^(?:=+ )?((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|warnings?|deselected)(?:, )?)+) in [\d.]+s\b.*$/gm)) {
    add(m[1]!, m.index);
  }
  // cargo: `test result: FAILED. 22 passed; 1 failed; 0 ignored`
  for (const m of out.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/gm)) {
    tally.passed += Number(m[1]);
    tally.failed += Number(m[2]);
    note(tally, m.index);
  }
  // node --test (spec `ℹ pass 12`, TAP `# pass 12`)
  for (const m of out.matchAll(/^[\u2139#] (pass|fail) (\d+)\s*$/gm)) {
    if (m[1] === "pass") tally.passed += Number(m[2]);
    else tally.failed += Number(m[2]);
    note(tally, m.index);
  }
  return tally;
}

function testFact(out: string): CheckFact | undefined {
  const { passed, failed, at } = testTally(out);
  if (at === undefined || passed + failed === 0) return undefined;
  if (failed > 0) return { verb: "failed", datum: `${failed} of ${plural(passed + failed, "test")}`, at, tone: "error" };
  return { verb: "passed", datum: plural(passed, "test"), at, tone: "text" };
}

// tsc: `Found 3 errors in 2 files.` carries the count. Without that summary the
// diagnostics themselves (`error TS2322:`) prove failure, but agents pipe tsc through
// `head`, so their number is only a lower bound and the fact states none.
function typeFact(out: string): CheckFact | undefined {
  let errors = 0;
  let at: number | undefined;
  for (const m of out.matchAll(/^Found (\d+) errors? in /gm)) {
    errors += Number(m[1]);
    at ??= m.index;
  }
  if (at !== undefined && errors > 0) return { verb: "found", datum: plural(errors, "type error"), at, tone: "error" };
  const diagnostic = /\berror TS\d+:/.exec(out);
  return diagnostic ? { verb: "found", datum: "type errors", at: diagnostic.index, tone: "error" } : undefined;
}

// ESLint `✖ 5 problems (3 errors, 2 warnings)`, oxlint `Found 2 warnings and 0 errors.`,
// ruff and Biome `Found 3 errors.`, ruff `All checks passed!`.
function lintFact(out: string): CheckFact | undefined {
  let errors = 0;
  let warnings = 0;
  let at: number | undefined;
  const seen = (index: number | undefined) => {
    if (index !== undefined && (at === undefined || index < at)) at = index;
  };
  for (const m of out.matchAll(/\u2716 \d+ problems? \((\d+) errors?, (\d+) warnings?\)/g)) {
    errors += Number(m[1]);
    warnings += Number(m[2]);
    seen(m.index);
  }
  for (const m of out.matchAll(/^Found (\d+) warnings? and (\d+) errors?\.?\s*$/gm)) {
    warnings += Number(m[1]);
    errors += Number(m[2]);
    seen(m.index);
  }
  for (const m of out.matchAll(/^Found (\d+) errors?\.\s*$/gm)) {
    errors += Number(m[1]);
    seen(m.index);
  }
  for (const m of out.matchAll(/^All checks passed!\s*$/gm)) seen(m.index);
  if (at === undefined) return undefined;
  if (errors > 0) return { verb: "found", datum: plural(errors, "lint error"), at, tone: "error" };
  if (warnings > 0) return { verb: "found", datum: plural(warnings, "lint warning"), at, tone: "warning" };
  return { verb: "passed", datum: "lint", at, tone: "text" };
}

// Prettier --check: `All matched files use Prettier code style!` or
// `[warn] Code style issues found in 2 files. Run Prettier with --write to fix.`
function formatFact(out: string): CheckFact | undefined {
  const issues = /Code style issues found in (?:(\d+) files?|the above file)/.exec(out);
  if (issues) {
    const files = issues[1] === undefined ? 1 : Number(issues[1]);
    return { verb: "found", datum: plural(files, "unformatted file"), at: issues.index, tone: "warning" };
  }
  const clean = /All matched files use Prettier code style!/.exec(out);
  return clean ? { verb: "passed", datum: "format", at: clean.index, tone: "text" } : undefined;
}

const checkFactCache = new WeakMap<object, { result: unknown; facts: CheckFact[] }>();

/** Check facts for a settled bash row, in output order. */
export function checkFacts(comp: ToolRowDataLike): CheckFact[] {
  if (comp?.toolName !== "bash") return [];
  const command = comp.args?.command;
  if (typeof command !== "string" || !comp.result || typeof comp.result !== "object" || comp.isPartial === true) return [];
  const cached = checkFactCache.get(comp);
  if (cached && cached.result === comp.result) return cached.facts;
  const out = stripAnsi(resultText(comp));
  const facts: CheckFact[] = [];
  if (out) {
    const parsers: [RegExp, (text: string) => CheckFact | undefined][] = [
      [TEST_GATE, testFact],
      [TYPE_GATE, typeFact],
      [LINT_GATE, lintFact],
      [FORMAT_GATE, formatFact],
    ];
    for (const [gate, parse] of parsers) {
      if (!gate.test(command)) continue;
      const fact = parse(out);
      if (fact) facts.push(fact);
    }
    facts.sort((a, b) => a.at - b.at);
  }
  checkFactCache.set(comp, { result: comp.result, facts });
  return facts;
}

/** True when a check in the row's output reported a failure (§9.2, §9.10.1). */
export function checkFailed(comp: ToolRowDataLike): boolean {
  return checkFacts(comp).some((fact) => fact.tone === "error");
}
