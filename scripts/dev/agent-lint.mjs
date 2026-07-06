#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, "scripts", "dev", "agent-lint-baseline.json");
const DEFAULT_TS_MAX_LINES = 350;
const NON_BASELINED_CODES = new Set(["POG008", "POG009", "POG010", "POG011"]);

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

function makeFinding(code, file, line, lineText) {
  return { code, file, line, lineText, message: messageFor(code) };
}

function signature(finding) {
  return `${finding.code}\u0000${finding.file}\u0000${normalizeLine(finding.lineText)}`;
}

function isTsLike(path) {
  return /\.(?:ts|mts|cts|tsx|mjs|js)$/.test(path);
}

function isMarkdown(path) {
  return /\.md$/.test(path);
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
    if (!/\.ts$/.test(file)) continue;
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
  if (!existsSync(BASELINE_PATH)) return { version: 1, knownFindings: {}, lineBudgets: { defaultTsMax: DEFAULT_TS_MAX_LINES, files: {} } };
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

function buildLineBudgets(files) {
  const budgets = {};
  for (const absPath of files) {
    const file = rel(absPath);
    if (!/\.ts$/.test(file)) continue;
    if (!inPath(file, "extensions") && !inPath(file, "tests")) continue;
    const lineCount = readText(absPath).split(/\r?\n/).length;
    if (lineCount > DEFAULT_TS_MAX_LINES) budgets[file] = lineCount;
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
  scanStructural(findings);
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

  if (args.has("--update-baseline")) {
    const next = {
      version: 1,
      generatedBy: "node scripts/dev/agent-lint.mjs --update-baseline",
      knownFindings: buildKnownFindings(findings),
      lineBudgets: buildLineBudgets(files),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Updated ${relative(ROOT, BASELINE_PATH)} with ${findings.length} current findings and line budgets.`);
    return;
  }

  const { known, fresh, stale } = partitionFindings(findings, baseline);
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
    console.error("Fix the issue, add a SAFETY comment for a real boundary seam, or update the reviewed baseline after deliberate fixes.");
    process.exitCode = 1;
    return;
  }

  console.log(`agent-lint passed: no new findings (${known.length} known baseline finding(s) remain).`);
}

main();
