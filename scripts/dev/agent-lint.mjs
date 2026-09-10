#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseSync } from "oxc-parser";

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, "scripts", "dev", "agent-lint-baseline.json");
const DEFAULT_TS_MAX_LINES = 350;
const NON_BASELINED_CODES = new Set(["POG008", "POG009", "POG010", "POG011", "POG012"]);

const RULE_MESSAGES = {
  POG001: [
    "generic record/object guard is banned.",
    "Do not carry unknown inward behind a generic isRecord/isObject helper.",
    "Parse or refine untrusted values at the Pi/JSON/config boundary, then pass a concrete type inward.",
    "For Pi internals, use a domain-named guard and keep the uncertainty local.",
  ],
  POG002: [
    "JSON.parse result was cast directly.",
    "JSON.parse returns untrusted data. Store it as unknown, then parse/refine it at the boundary.",
    "Prefer readJsonConfig(path, parseConfig) or a domain parser.",
  ],
  POG003: [
    "any requires a SAFETY comment.",
    "If this is a real Pi seam, document the runtime shape and the contract test that pins it.",
    "Otherwise replace any with a precise type, or unknown plus boundary parsing.",
  ],
  POG004: [
    "broad Record<string, unknown> cast needs local proof.",
    "Before casting, prove non-null object and non-array in the same helper, or replace the cast with a named boundary parser.",
    "Unknown should not leak into core logic.",
  ],
  POG005: [
    "TypeScript suppression requires a SAFETY comment.",
    "Explain the runtime invariant or contract-test coverage before suppressing the compiler.",
  ],
  POG006: [
    "raw ANSI colour constant outside style layer.",
    "Theme owns ink in this repo. Route colour through extensions/_lib/style.ts.",
  ],
  POG007: [
    "markdown em dash is banned by AGENTS.md.",
    "Use commas, colons, semicolons, or parentheses unless this is quoted/generated UI output with an explicit lint exemption.",
  ],
  POG008: [
    "extensions/_lib/index.ts must not exist.",
    "Pi discovers extension directories by convention. Keep _lib without an index.ts so it is never discovered as an extension.",
  ],
  POG009: [
    "runtime dependencies are not allowed without an explicit repo decision.",
    "This package ships zero runtime dependencies. Use dev tooling or repo-local scripts unless maintainers approve a dependency.",
  ],
  POG010: [
    "TypeScript file is over its agent context budget.",
    "Split code by domain before growing large files. Existing oversized files have temporary budgets that should only shrink.",
  ],
  POG011: [
    "agent lint baseline is stale.",
    "Prune fixed findings or lower shrunk line budgets instead of leaving old allowance behind.",
  ],
  POG012: [
    "test-only `internals` export grew.",
    "Tests reach behaviour through public interfaces (docs/testing.md): the extension's default export via the test harness, or named exports of a domain module.",
    "Move the logic into a domain module and import it directly, or test it through the harness; do not add another entry to the grab bag.",
  ],
};

function usage() {
  console.log(`Usage: node scripts/dev/agent-lint.mjs [--update-baseline] [--show-baseline]\n\nDeterministic source checks for the pine-of-glass agent coding standard.`);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "node_modules", ".pi-subagents", "out", "coverage"].includes(entry.name)) continue;
      walk(path, out);
    } else {
      // *.local.md is the repo's gitignored local-scratch convention (.gitignore):
      // those files never reach a clean checkout, so linting them only makes local
      // runs diverge from CI.
      if (entry.name.endsWith(".local.md")) continue;
      out.push(path);
    }
  }
  return out;
}

function rel(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function normalizeLine(line) {
  return line.trim().replace(/\s+/g, " ");
}

function messageFor(code) {
  return RULE_MESSAGES[code].join("\n");
}

function makeFinding(code, file, line, lineText, message = messageFor(code)) {
  return { code, file, line, lineText, message };
}

function signature(finding) {
  return `${finding.code}\u0000${finding.file}\u0000${normalizeLine(finding.lineText)}`;
}

function isTsLike(path) {
  return /\.(?:ts|mts|cts|tsx|mjs|js)$/.test(path);
}

function isMarkdown(path) {
  return path.endsWith(".md");
}

function inPath(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function hasDisable(lines, index, code) {
  const current = lines[index] ?? "";
  const previous = lines[index - 1] ?? "";
  return current.includes(`agent-lint-disable-line ${code}`)
    || current.includes("agent-lint-disable-line")
    || previous.includes(`agent-lint-disable-next-line ${code}`)
    || previous.includes("agent-lint-disable-next-line");
}

function hasSafety(lines, index) {
  for (let offset = 0; offset <= 3; offset++) {
    const line = lines[index - offset];
    if (line && line.includes("SAFETY:")) return true;
  }
  return false;
}

function hasLocalRecordProof(lines, index) {
  const window = lines.slice(Math.max(0, index - 5), index + 1).join("\n");
  if (window.includes("isJsonObject(")) return true;
  return window.includes("typeof") && window.includes("object") && window.includes("Array.isArray");
}

function scanTsFile(absPath, findings) {
  const file = rel(absPath);
  const lines = readText(absPath).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineNumber = index + 1;

    if (!hasDisable(lines, index, "POG001") && /\b(?:function|const|let|var)\s+(?:isRecord|isObject)\b/.test(line)) {
      findings.push(makeFinding("POG001", file, lineNumber, line));
    }

    if (!hasDisable(lines, index, "POG002") && /JSON\.parse\([^;]*\)\s+as\s+/.test(line)) {
      findings.push(makeFinding("POG002", file, lineNumber, line));
    }

    const unsafeAnyType = /(:\s*any\b|as\s+any\b|<\s*any\s*>|\bany\s*\[\s*\]|\bArray\s*<\s*any\s*>|[<,]\s*any\s*[>,])/.test(line);
    if (!trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*") && unsafeAnyType) {
      if (!hasDisable(lines, index, "POG003") && !hasSafety(lines, index)) {
        findings.push(makeFinding("POG003", file, lineNumber, line));
      }
    }

    if (/as\s+Record\s*<\s*string\s*,\s*unknown\s*>/.test(line)) {
      if (!hasDisable(lines, index, "POG004") && !hasSafety(lines, index) && !hasLocalRecordProof(lines, index)) {
        findings.push(makeFinding("POG004", file, lineNumber, line));
      }
    }

    if (!hasDisable(lines, index, "POG005") && /@ts-(?:ignore|expect-error)/.test(line) && !hasSafety(lines, index)) {
      findings.push(makeFinding("POG005", file, lineNumber, line));
    }

    if (inPath(file, "extensions") && file !== "extensions/_lib/style.ts" && file !== "extensions/_lib/ansi.ts") {
      const rawAnsiColor = /\\x1b\[(?:3[0-7]|9[0-7]|38[;:]|48[;:]|4[0-7]|10[0-7])/.test(line);
      if (!hasDisable(lines, index, "POG006") && rawAnsiColor) {
        findings.push(makeFinding("POG006", file, lineNumber, line));
      }
    }
  }
}

function scanMarkdownFile(absPath, findings) {
  const file = rel(absPath);
  const lines = readText(absPath).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.includes("—") && !hasDisable(lines, index, "POG007")) {
      findings.push(makeFinding("POG007", file, index + 1, line));
    }
  }
}

function scanFileBudgets(files, baseline, findings) {
  const budgets = baseline.lineBudgets ?? {};
  const defaultMax = budgets.defaultTsMax ?? DEFAULT_TS_MAX_LINES;
  const fileBudgets = budgets.files ?? {};
  const seenBudgetFiles = new Set();
  for (const absPath of files) {
    const file = rel(absPath);
    if (!file.endsWith(".ts")) continue;
    if (!inPath(file, "extensions") && !inPath(file, "tests")) continue;
    const lineCount = readText(absPath).split(/\r?\n/).length;
    const storedBudget = fileBudgets[file];
    if (storedBudget !== undefined) seenBudgetFiles.add(file);
    const allowed = storedBudget ?? defaultMax;
    if (lineCount > allowed) {
      findings.push(makeFinding("POG010", file, 1, `line-count:${lineCount} budget:${allowed}`));
    }
    if (storedBudget !== undefined && lineCount < storedBudget) {
      findings.push(makeFinding("POG011", file, 1, `line-count:${lineCount} stale-budget:${storedBudget}`));
    }
  }
  for (const budgetFile of Object.keys(fileBudgets)) {
    if (!seenBudgetFiles.has(budgetFile)) {
      findings.push(makeFinding("POG011", budgetFile, 1, "missing file still has a line budget"));
    }
  }
}

// Oxlint diagnostics (rules in .oxlintrc.json) join the ledger under their own rule id,
// e.g. `anti-slop(no-unknown-returns)`, keyed by source line like the POG findings.
function scanWithOxlint(findings) {
  if (!existsSync(join(ROOT, ".oxlintrc.json"))) return;
  const oxlint = join(ROOT, "node_modules", ".bin", "oxlint");
  const result = spawnSync(oxlint, [".", "--format", "json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  // oxlint exits 1 when it reports findings; anything else is a tooling failure.
  if (result.status !== 0 && result.status !== 1) {
    console.error(result.stderr || result.stdout);
    console.error(`agent-lint: oxlint exited with ${result.status}`);
    process.exit(1);
  }
  const report = JSON.parse(result.stdout);
  const sources = new Map();
  for (const diagnostic of report.diagnostics) {
    const file = diagnostic.filename.split(sep).join("/");
    const line = diagnostic.labels[0].span.line;
    if (!sources.has(file)) sources.set(file, readText(join(ROOT, file)).split(/\r?\n/));
    const lineText = sources.get(file)[line - 1] ?? "";
    const message = [
      diagnostic.message,
      ...(diagnostic.help ? [diagnostic.help] : []),
      "Rule policy: .oxlintrc.json (inline reasons) and docs/agent-coding-standard.md (\"Slop lint\").",
      "See the full diagnostic with `npm run lint:slop`.",
    ].join("\n");
    findings.push(makeFinding(diagnostic.code, file, line, lineText, message));
  }
}

function internalsEntryCount(file, text) {
  const { program, errors } = parseSync(file, text);
  if (errors.length > 0) throw new Error(`Could not parse ${file} while counting internals: ${errors[0].message}`);

  let entries = 0;
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const item of declaration.declarations) {
      if (item.id.type === "Identifier" && item.id.name === "internals" && item.init?.type === "ObjectExpression") {
        entries += item.init.properties.length;
      }
    }
  }
  return entries;
}

function scanInternalsBudgets(files, baseline, findings) {
  const budgets = baseline.internalsBudgets ?? {};
  const seen = new Set();
  for (const absPath of files) {
    const file = rel(absPath);
    if (!file.endsWith(".ts") || !inPath(file, "extensions")) continue;
    const count = internalsEntryCount(file, readText(absPath));
    const budget = budgets[file];
    if (budget !== undefined) seen.add(file);
    if (count > (budget ?? 0)) {
      findings.push(makeFinding("POG012", file, 1, `internals-entries:${count} budget:${budget ?? 0}`));
    }
    if (budget !== undefined && count < budget) {
      findings.push(makeFinding("POG011", file, 1, `internals-entries:${count} stale-budget:${budget}`));
    }
  }
  for (const budgetFile of Object.keys(budgets)) {
    if (!seen.has(budgetFile)) findings.push(makeFinding("POG011", budgetFile, 1, "missing file still has an internals budget"));
  }
}

// Budgets already in the baseline may only shrink; new files are never added.
function buildInternalsBudgets(files, previous) {
  const sources = new Map(files.map((path) => [rel(path), path]));
  const budgets = {};
  for (const [file, oldBudget] of Object.entries(previous)) {
    const absPath = sources.get(file);
    if (!absPath) continue;
    const count = internalsEntryCount(file, readText(absPath));
    if (count > 0) budgets[file] = Math.min(count, oldBudget);
  }
  return sortObjectDeep(budgets);
}

function scanStructural(findings) {
  if (existsSync(join(ROOT, "extensions", "_lib", "index.ts"))) {
    findings.push(makeFinding("POG008", "extensions/_lib/index.ts", 1, "extensions/_lib/index.ts"));
  }

  const packagePath = join(ROOT, "package.json");
  if (existsSync(packagePath)) {
    const pkg = JSON.parse(readText(packagePath));
    const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
    if (deps.length > 0) {
      findings.push(makeFinding("POG009", "package.json", 1, `dependencies:${deps.join(",")}`));
    }
  }
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return { version: 1, knownFindings: {}, lineBudgets: { defaultTsMax: DEFAULT_TS_MAX_LINES, files: {} }, internalsBudgets: {} };
  }
  return JSON.parse(readText(BASELINE_PATH));
}

function flattenKnownFindings(baseline) {
  const map = new Map();
  for (const [code, files] of Object.entries(baseline.knownFindings ?? {})) {
    for (const [file, lines] of Object.entries(files ?? {})) {
      for (const [lineText, count] of Object.entries(lines ?? {})) {
        map.set(`${code}\u0000${file}\u0000${lineText}`, Number(count));
      }
    }
  }
  return map;
}

function buildKnownFindings(findings) {
  const knownFindings = {};
  for (const finding of findings) {
    if (NON_BASELINED_CODES.has(finding.code)) continue;
    const lineText = normalizeLine(finding.lineText);
    knownFindings[finding.code] ??= {};
    knownFindings[finding.code][finding.file] ??= {};
    knownFindings[finding.code][finding.file][lineText] = (knownFindings[finding.code][finding.file][lineText] ?? 0) + 1;
  }
  return sortObjectDeep(knownFindings);
}

function buildLineBudgets(files, previous) {
  const sources = new Map(files.map((path) => [rel(path), path]));
  const budgets = {};
  for (const [file, oldBudget] of Object.entries(previous.files ?? {})) {
    const absPath = sources.get(file);
    if (!absPath) continue;
    const lineCount = readText(absPath).split(/\r?\n/).length;
    if (lineCount > DEFAULT_TS_MAX_LINES) budgets[file] = Math.min(lineCount, oldBudget);
  }
  return { defaultTsMax: DEFAULT_TS_MAX_LINES, files: sortObjectDeep(budgets) };
}

function sortObjectDeep(value) {
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectDeep(value[key])]));
}

function partitionFindings(findings, baseline) {
  const knownMap = flattenKnownFindings(baseline);
  const known = [];
  const fresh = [];
  for (const finding of findings) {
    if (NON_BASELINED_CODES.has(finding.code)) {
      fresh.push(finding);
      continue;
    }
    const sig = signature(finding);
    const remaining = knownMap.get(sig) ?? 0;
    if (remaining > 0) {
      known.push(finding);
      knownMap.set(sig, remaining - 1);
    } else {
      fresh.push(finding);
    }
  }
  const stale = Array.from(knownMap.entries()).filter(([, count]) => count > 0);
  return { known, fresh, stale };
}

function formatFinding(finding) {
  return `${finding.file}:${finding.line} ${finding.code} ${finding.message}\n  > ${finding.lineText.trim()}`;
}

function collectFiles() {
  return walk(ROOT).filter((path) => {
    const file = rel(path);
    if (file.startsWith("scripts/dev/bash-corpus/out/")) return false;
    // Other git worktrees and vendored lint plugins are not this checkout's source.
    if (file.startsWith(".worktrees/") || file.startsWith("tools/oxlint/")) return false;
    return isTsLike(file) || isMarkdown(file) || file === "package.json";
  });
}

function collectFindings(files, baseline) {
  const findings = [];
  for (const absPath of files) {
    const file = rel(absPath);
    if (isTsLike(file)) scanTsFile(absPath, findings);
    if (isMarkdown(file)) scanMarkdownFile(absPath, findings);
  }
  scanFileBudgets(files, baseline, findings);
  scanInternalsBudgets(files, baseline, findings);
  scanStructural(findings);
  scanWithOxlint(findings);
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code));
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    usage();
    return;
  }

  const files = collectFiles();
  const baseline = loadBaseline();
  const findings = collectFindings(files, baseline);

  const { known, fresh, stale } = partitionFindings(findings, baseline);
  if (args.has("--update-baseline")) {
    // Only stale entries (POG011) may be pruned; every other fresh finding needs a fix or a hand edit.
    const unreviewed = fresh.filter((finding) => finding.code !== "POG011");
    if (unreviewed.length > 0) {
      console.error(`agent-lint refused to update the baseline with ${unreviewed.length} unreviewed finding(s):\n`);
      for (const finding of unreviewed) console.error(`${formatFinding(finding)}\n`);
      console.error("Fix the findings or admit them with a reviewed hand edit of scripts/dev/agent-lint-baseline.json.");
      process.exitCode = 1;
      return;
    }
    const next = {
      version: 1,
      generatedBy: "node scripts/dev/agent-lint.mjs --update-baseline",
      knownFindings: buildKnownFindings(known),
      lineBudgets: buildLineBudgets(files, baseline.lineBudgets ?? {}),
      internalsBudgets: buildInternalsBudgets(files, baseline.internalsBudgets ?? {}),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Pruned ${relative(ROOT, BASELINE_PATH)}; no new findings or budget growth were admitted.`);
    return;
  }

  if (args.has("--show-baseline")) {
    for (const finding of known) console.log(`${formatFinding(finding)}\n`);
    console.log(`Known baseline findings: ${known.length}`);
    if (stale.length > 0) console.log(`Stale baseline signatures: ${stale.length}`);
    return;
  }

  if (fresh.length > 0 || stale.length > 0) {
    if (fresh.length > 0) {
      console.error(`agent-lint found ${fresh.length} unbaselined finding(s):\n`);
      for (const finding of fresh) console.error(`${formatFinding(finding)}\n`);
    }
    if (stale.length > 0) {
      console.error(`agent-lint found ${stale.length} stale baseline signature(s):\n`);
      for (const [sig, count] of stale) {
        const [code, file, lineText] = sig.split("\u0000");
        console.error(`${file} ${code} stale baseline entry (${count}):\n  > ${lineText}\n`);
      }
    }
    console.error("Fix the issue, add a SAFETY comment for a real boundary seam, or update the reviewed baseline after deliberate fixes (node scripts/dev/agent-lint.mjs --update-baseline).");
    process.exitCode = 1;
    return;
  }

  console.log(`agent-lint passed: no new findings (${known.length} known baseline finding(s) remain).`);
}

main();
