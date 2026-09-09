#!/usr/bin/env node
// `npm install` prunes the Pi runtime symlinks that `npm run link-pi` creates (npm treats
// them as extraneous), so the two steps must run in that order on every fresh install.
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
if (!existsSync(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"))) {
  console.error("preflight: Pi runtime is not linked; run `npm run link-pi` after `npm install`.");
  process.exit(1);
}
