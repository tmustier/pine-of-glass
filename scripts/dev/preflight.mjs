#!/usr/bin/env node
// Fail fast with a clear message when the local toolchain is incomplete, instead of a
// module-resolution error halfway through lint, typecheck or tests.
//
// `npm install` prunes the Pi runtime symlinks that `npm run link-pi` creates (npm treats
// them as extraneous), so the two steps must run in that order on every fresh install.
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const problems = [];

if (!existsSync(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"))) {
  problems.push("Pi runtime is not linked: run `npm run link-pi` (after every `npm install`).");
}
if (!existsSync(join(ROOT, "node_modules", ".bin", "oxlint"))) {
  problems.push("oxlint is not installed: run `npm install`, then `npm run link-pi`.");
}
if (!existsSync(join(ROOT, "node_modules", "oxc-parser"))) {
  problems.push("oxc-parser is not installed: run `npm install`, then `npm run link-pi`.");
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`preflight: ${problem}`);
  process.exit(1);
}
