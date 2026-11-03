import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const script = readFileSync(new URL("../scripts/dev/link-pi-runtime.sh", import.meta.url), "utf8");
const scratchDirs: string[] = [];
const scope = "@earendil-works";

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string, executable = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: executable ? 0o755 : 0o644 });
}

function runtime(root: string): string {
  const pkg = join(root, scope, "pi-coding-agent");
  write(join(pkg, "package.json"), JSON.stringify({ name: `${scope}/pi-coding-agent` }));
  write(join(pkg, "dist/cli.js"), "#!/usr/bin/env node\nprocess.exit(99);\n", true);
  for (const dep of ["pi-ai", "pi-tui", "pi-agent-core", "@types/node"]) {
    const name = dep.startsWith("@") ? dep : `${scope}/${dep}`;
    write(join(pkg, "node_modules", name, "package.json"), JSON.stringify({ name }));
  }
  return pkg;
}

function checkout(root: string) {
  write(join(root, "scripts/dev/link-pi-runtime.sh"), script, true);
  write(join(root, "package.json"), JSON.stringify({ scripts: { "link-pi": "scripts/dev/link-pi-runtime.sh" } }));
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pog-link-pi test-")));
  scratchDirs.push(dir);
  const repo = join(dir, "checkout");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // Keep host Pi installations and npm config out of discovery, including npm's
  // inherited ancestor .bin entries. Use the real npm with a scratch global prefix.
  for (const tool of ["sh", "bash", "node", "npm", "dirname", "readlink", "which", "grep", "mkdir", "rm", "ln"]) {
    symlinkSync(execFileSync("which", [tool], { encoding: "utf8" }).trim(), join(bin, tool));
  }
  const env = {
    ...process.env,
    PATH: bin,
    HOME: join(dir, "home"),
    PWD: repo,
    npm_config_prefix: join(dir, "global"),
    npm_config_userconfig: join(dir, "npmrc"),
    npm_config_globalconfig: join(dir, "global-npmrc"),
    npm_config_cache: join(dir, "cache"),
  };
  mkdirSync(env.HOME);
  write(env.npm_config_userconfig, "");
  write(env.npm_config_globalconfig, "");
  checkout(repo);
  const pkg = runtime(join(env.npm_config_prefix, "lib/node_modules"));
  return { dir, repo, bin, env, pkg };
}

function run(f: ReturnType<typeof fixture>, repo = f.repo) {
  return spawnSync("npm", ["run", "link-pi"], { cwd: repo, env: { ...f.env, PWD: repo }, encoding: "utf8" });
}

function assertLinked(repo: string, pkg: string) {
  assert.equal(realpathSync(join(repo, "node_modules", scope, "pi-coding-agent")), pkg);
  for (const name of [`${scope}/pi-ai`, `${scope}/pi-tui`, `${scope}/pi-agent-core`, "@types/node"]) {
    assert.equal(realpathSync(join(repo, "node_modules", name)), join(pkg, "node_modules", name));
  }
  assert.ok(existsSync(join(pkg, "dist/cli.js")), "source runtime survives linking");
}

test("link-pi finds the global package when only an opaque pi wrapper is on PATH", () => {
  const f = fixture();
  write(join(f.bin, "pi"), "#!/bin/sh\nexit 98\n", true);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assertLinked(f.repo, f.pkg);
});

test("link-pi needs no pi executable on PATH and can be rerun", () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assertLinked(f.repo, f.pkg);
  }
});

test("link-pi reports a missing global package without replacing the local runtime", () => {
  const f = fixture();
  const localPkg = runtime(join(f.repo, "node_modules"));
  rmSync(f.pkg, { recursive: true });
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm install -g @earendil-works\/pi-coding-agent/);
  assert.ok(existsSync(join(localPkg, "dist/cli.js")));
});

test("link-pi still works with a wrapper shadowing a real Pi executable", () => {
  const f = fixture();
  write(join(f.bin, "pi"), "#!/bin/sh\nexit 98\n", true);
  const realBin = join(f.dir, "real-bin");
  mkdirSync(realBin);
  symlinkSync(join(f.pkg, "dist/cli.js"), join(realBin, "pi"));
  f.env.PATH += `:${realBin}`;
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assertLinked(f.repo, f.pkg);
});

test("npm run link-pi ignores both worktree and parent checkout runtimes", () => {
  const f = fixture();
  const parentPkg = runtime(join(f.repo, "node_modules"));
  mkdirSync(join(f.repo, "node_modules/.bin"));
  symlinkSync(join(parentPkg, "dist/cli.js"), join(f.repo, "node_modules/.bin/pi"));
  const nested = join(f.repo, ".worktrees/child");
  checkout(nested);
  const localPkg = runtime(join(nested, "node_modules"));
  mkdirSync(join(nested, "node_modules/.bin"));
  symlinkSync(join(localPkg, "dist/cli.js"), join(nested, "node_modules/.bin/pi"));
  const result = run(f, nested);
  assert.equal(result.status, 0, result.stderr);
  assertLinked(nested, f.pkg);
  assert.ok(existsSync(join(parentPkg, "dist/cli.js")));
});

test("link-pi canonicalizes an aliased worktree before rejecting a self-link", () => {
  const f = fixture();
  const pkg = runtime(join(f.repo, "node_modules"));
  symlinkSync(join(pkg, "dist/cli.js"), join(f.bin, "pi"));
  const alias = join(f.dir, "alias");
  symlinkSync(f.repo, alias, "dir");
  // Even a configured global root pointing into this checkout is not a source.
  rmSync(join(f.env.npm_config_prefix, "lib/node_modules"), { recursive: true });
  symlinkSync(join(f.repo, "node_modules"), join(f.env.npm_config_prefix, "lib/node_modules"), "dir");
  const result = spawnSync("bash", [join(alias, "scripts/dev/link-pi-runtime.sh")], {
    cwd: alias, env: { ...f.env, PWD: alias }, encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(existsSync(join(pkg, "dist/cli.js")), "refusal must not delete the local runtime");
  assert.match(result.stderr, /installed.*Pi|installed.*pi/);
});

test("link-pi refuses a global root aliased to a parent checkout without changing links", () => {
  const f = fixture();
  const parentPkg = runtime(join(f.repo, "node_modules"));
  const nested = join(f.repo, ".worktrees/child");
  checkout(nested);
  const localPkg = runtime(join(nested, "node_modules"));
  rmSync(join(f.env.npm_config_prefix, "lib/node_modules"), { recursive: true });
  symlinkSync(join(f.repo, "node_modules"), join(f.env.npm_config_prefix, "lib/node_modules"), "dir");
  symlinkSync(join(parentPkg, "dist/cli.js"), join(f.bin, "pi"));
  const result = run(f, nested);
  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(existsSync(join(localPkg, "dist/cli.js")));
  assert.ok(existsSync(join(parentPkg, "dist/cli.js")));
});
