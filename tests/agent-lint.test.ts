import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = new URL("../", import.meta.url);
const script = readFileSync(new URL("scripts/dev/agent-lint.mjs", repoRoot), "utf8");
const fixtureDirs: string[] = [];

after(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pog-agent-lint-"));
  fixtureDirs.push(dir);
  mkdirSync(join(dir, "scripts", "dev"), { recursive: true });
  mkdirSync(join(dir, "extensions", "demo"), { recursive: true });
  writeFileSync(join(dir, "scripts", "dev", "agent-lint.mjs"), script);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  symlinkSync(join(repoRoot.pathname, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

function writeBaseline(dir: string, overrides: {
  knownFindings?: object;
  lineBudgets?: { defaultTsMax: number; files: Record<string, number> };
  internalsBudgets?: Record<string, number>;
} = {}): string {
  const path = join(dir, "scripts", "dev", "agent-lint-baseline.json");
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    knownFindings: {},
    lineBudgets: { defaultTsMax: 350, files: {} },
    internalsBudgets: {},
    ...overrides,
  }, null, 2)}\n`);
  return path;
}

function runLint(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["scripts/dev/agent-lint.mjs", ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("agent lint requires hand review before admitting a migration finding", () => {
  const dir = fixtureRepo();
  const badGuard = ["function is", "Record(value) { return !!value; }"].join("");
  writeFileSync(join(dir, "extensions", "demo", "index.ts"), badGuard);

  const failed = runLint(dir);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /POG001/);
  assert.match(failed.stderr, /Do not carry unknown inward/);

  const baselinePath = writeBaseline(dir);
  const before = readFileSync(baselinePath, "utf8");
  const refused = runLint(dir, "--update-baseline");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refused to update/);
  assert.equal(readFileSync(baselinePath, "utf8"), before);

  writeBaseline(dir, { knownFindings: { POG001: { "extensions/demo/index.ts": { [badGuard]: 1 } } } });
  assert.match(runLint(dir).stdout, /no new findings/);

  writeFileSync(join(dir, "extensions", "demo", "index.ts"), "export const ok = true;\n");
  assert.equal(runLint(dir, "--update-baseline").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "scripts", "dev", "agent-lint-baseline.json"), "utf8")).knownFindings, {});
});

test("agent lint fails when the baseline keeps stale signatures", () => {
  const dir = fixtureRepo();
  writeFileSync(join(dir, "extensions", "demo", "index.ts"), "export const ok = true;\n");
  const staleLine = ["function is", "Record(value) { return !!value; }"].join("");
  writeBaseline(dir, {
    knownFindings: { POG001: { "extensions/demo/index.ts": { [staleLine]: 1 } } },
  });

  const failed = runLint(dir);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /stale baseline/);
});

function oxlintFixtureRepo(): string {
  const dir = fixtureRepo();
  symlinkSync(join(repoRoot.pathname, "tools"), join(dir, "tools"), "dir");
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify({
    ignorePatterns: ["node_modules/**", "tools/**"],
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    rules: { "anti-slop/no-unknown-returns": "error" },
  }));
  return dir;
}

test("anti-slop findings join the migration ledger under their rule id and ratchet down", () => {
  const dir = oxlintFixtureRepo();
  const source = join(dir, "extensions", "demo", "index.ts");
  writeFileSync(source, "export function load(): unknown {\n  return 1;\n}\n");

  const failed = runLint(dir);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /anti-slop\(no-unknown-returns\)/);
  assert.match(failed.stderr, /exposes `unknown` to its caller/);
  assert.match(failed.stderr, /npm run lint:slop/);

  const line = "export function load(): unknown {";
  writeBaseline(dir, {
    knownFindings: {
      "anti-slop(no-unknown-returns)": { "extensions/demo/index.ts": { [line]: 1 } },
    },
  });
  assert.match(runLint(dir).stdout, /no new findings \(1 known/);

  // Fixing the finding without pruning the ledger is reported as stale.
  writeFileSync(source, "export function load(): number {\n  return 1;\n}\n");
  const stale = runLint(dir);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /anti-slop\(no-unknown-returns\) stale baseline entry/);
});

test("test-only internals exports may shrink but not grow through --update-baseline", () => {
  const dir = fixtureRepo();
  const source = join(dir, "extensions", "demo", "index.ts");
  writeFileSync(source, "const a = 1;\nexport const internals = { a, b: 2 };\n");

  assert.match(runLint(dir).stderr, /internals-entries:2 budget:0/);
  assert.notEqual(runLint(dir, "--update-baseline").status, 0);

  const baselinePath = writeBaseline(dir, { internalsBudgets: { "extensions/demo/index.ts": 2 } });
  assert.equal(runLint(dir).status, 0);

  writeFileSync(source, "const a = 1;\nexport const internals = {\n  a,\n  b: 2,\n  c: 3,\n};\n");
  const before = readFileSync(baselinePath, "utf8");
  assert.match(runLint(dir).stderr, /internals-entries:3 budget:2/);
  assert.notEqual(runLint(dir, "--update-baseline").status, 0);
  assert.equal(readFileSync(baselinePath, "utf8"), before);

  writeFileSync(source, "const a = 1;\nexport const internals = { a };\n");
  assert.match(runLint(dir).stderr, /internals-entries:1 stale-budget:2/);
  assert.equal(runLint(dir, "--update-baseline").status, 0);
  assert.equal(JSON.parse(readFileSync(baselinePath, "utf8")).internalsBudgets["extensions/demo/index.ts"], 1);
});

test("line budgets for existing files ratchet down while new oversized files are refused", () => {
  const dir = fixtureRepo();
  const source = join(dir, "extensions", "demo", "index.ts");
  writeFileSync(source, `${Array.from({ length: 355 }, () => "// line").join("\n")}\n`);
  const baselinePath = writeBaseline(dir, {
    lineBudgets: { defaultTsMax: 350, files: { "extensions/demo/index.ts": 370 } },
  });

  assert.match(runLint(dir).stderr, /line-count:356 stale-budget:370/);
  assert.equal(runLint(dir, "--update-baseline").status, 0);
  assert.equal(JSON.parse(readFileSync(baselinePath, "utf8")).lineBudgets.files["extensions/demo/index.ts"], 356);

  writeFileSync(source, `${Array.from({ length: 356 }, () => "// growth").join("\n")}\n`);
  const beforeGrowth = readFileSync(baselinePath, "utf8");
  assert.notEqual(runLint(dir, "--update-baseline").status, 0);
  assert.equal(readFileSync(baselinePath, "utf8"), beforeGrowth);

  const newFile = join(dir, "extensions", "demo", "new.ts");
  writeFileSync(newFile, `${Array.from({ length: 355 }, () => "// new").join("\n")}\n`);
  const before = readFileSync(baselinePath, "utf8");
  const refused = runLint(dir, "--update-baseline");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /extensions\/demo\/new.ts:1 POG010/);
  assert.equal(readFileSync(baselinePath, "utf8"), before);
});

test("the repo policy allows boundary parsing but rejects untyped or typeof-probed core input", () => {
  const dir = oxlintFixtureRepo();
  writeFileSync(join(dir, ".oxlintrc.json"), readFileSync(new URL(".oxlintrc.json", repoRoot), "utf8"));
  const coreDir = join(dir, "extensions", "pi-meantime");
  mkdirSync(coreDir, { recursive: true });
  const core = join(coreDir, "render.ts");
  const boundary = join(coreDir, "config.ts");
  writeFileSync(core, 'export function label(value: string | number): string { return String(value); }\n');
  writeFileSync(boundary, 'export function parseLabel(value: unknown): string { return typeof value === "string" ? value : ""; }\n');
  const allowed = runLint(dir);
  assert.equal(allowed.status, 0, allowed.stderr);

  writeFileSync(core, 'export function label(value: string | number): string { return typeof value === "string" ? value : String(value); }\n');
  const probed = runLint(dir);
  assert.notEqual(probed.status, 0);
  assert.match(probed.stderr, /render.ts:1 anti-slop\(no-runtime-typeof\)/);

  writeFileSync(core, 'export function label(value: unknown): string { return value === undefined ? "" : String(value); }\n');
  const untyped = runLint(dir);
  assert.notEqual(untyped.status, 0);
  assert.match(untyped.stderr, /render.ts:1 anti-slop\(no-unknown-parameters\)/);
});
