import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = readFileSync(new URL("../scripts/dev/agent-lint.mjs", import.meta.url), "utf8");

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pog-agent-lint-"));
  mkdirSync(join(dir, "scripts", "dev"), { recursive: true });
  mkdirSync(join(dir, "extensions", "demo"), { recursive: true });
  writeFileSync(join(dir, "scripts", "dev", "agent-lint.mjs"), script);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  return dir;
}

function runLint(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["scripts/dev/agent-lint.mjs", ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("agent lint gives instructional failures and supports a migration baseline", () => {
  const dir = fixtureRepo();
  const badGuard = ["function is", "Record(value) { return !!value; }"];
  writeFileSync(join(dir, "extensions", "demo", "index.ts"), badGuard.join(""));

  const failed = runLint(dir);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /POG001/);
  assert.match(failed.stderr, /Do not carry unknown inward/);

  const updated = runLint(dir, "--update-baseline");
  assert.equal(updated.status, 0, updated.stderr);

  const passed = runLint(dir);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /no new findings/);
});

test("agent lint fails when the baseline keeps stale signatures", () => {
  const dir = fixtureRepo();
  writeFileSync(join(dir, "extensions", "demo", "index.ts"), "export const ok = true;\n");
  const staleLine = ["function is", "Record(value) { return !!value; }"].join("");
  writeFileSync(join(dir, "scripts", "dev", "agent-lint-baseline.json"), JSON.stringify({
    version: 1,
    knownFindings: {
      POG001: {
        "extensions/demo/index.ts": {
          [staleLine]: 1,
        },
      },
    },
    lineBudgets: { defaultTsMax: 350, files: {} },
  }, null, 2));

  const failed = runLint(dir);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /stale baseline/);
});

// The oxlint ledger: findings from the vendored anti-slop rules join the same baseline
// under their rule id, ratchet the same way, and report oxlint's own message.
function oxlintFixtureRepo(): string {
  const dir = fixtureRepo();
  const repoRoot = new URL("../", import.meta.url);
  symlinkSync(join(repoRoot.pathname, "node_modules"), join(dir, "node_modules"), "dir");
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

  assert.equal(runLint(dir, "--update-baseline").status, 0);
  assert.match(runLint(dir).stdout, /no new findings \(1 known/);

  // Fixing the finding without pruning the ledger is reported as stale.
  writeFileSync(source, "export function load(): number {\n  return 1;\n}\n");
  const stale = runLint(dir);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /anti-slop\(no-unknown-returns\) stale baseline entry/);
});

test("test-only internals exports may shrink but not grow, even through --update-baseline", () => {
  const dir = fixtureRepo();
  const source = join(dir, "extensions", "demo", "index.ts");
  writeFileSync(source, "const a = 1;\nconst b = 2;\nexport const internals = {\n  // comment\n  a,\n  b: () => ({ nested: [1, 2] }),\n};\n");

  const fresh = runLint(dir);
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /POG012/);
  assert.match(fresh.stderr, /internals-entries:2 budget:0/);

  assert.equal(runLint(dir, "--update-baseline").status, 0);
  assert.equal(runLint(dir).status, 0);

  writeFileSync(source, "const a = 1;\nexport const internals = {\n  a,\n  b: 2,\n  c: 3,\n};\n");
  assert.match(runLint(dir).stderr, /internals-entries:3 budget:2/);
  // Regenerating the baseline does not legitimise growth: the budget stays at 2.
  assert.equal(runLint(dir, "--update-baseline").status, 0);
  assert.match(runLint(dir).stderr, /internals-entries:3 budget:2/);

  writeFileSync(source, "const a = 1;\nexport const internals = { a };\n");
  assert.match(runLint(dir).stderr, /internals-entries:1 stale-budget:2/);
});

test("renamed or annotated grab bags still count as internals", () => {
  const dir = fixtureRepo();
  const source = join(dir, "extensions", "demo", "index.ts");
  writeFileSync(source, [
    "type Internals = { a: number };",
    "export const testInternals: Internals = {",
    "  a: 1,",
    "};",
    "export const internalsForSpecs =",
    "{ b: 2, c: 3 };",
    "",
  ].join("\n"));
  assert.match(runLint(dir).stderr, /internals-entries:3 budget:0/);
});
