import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
