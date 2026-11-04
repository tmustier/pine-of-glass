import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const dir = new URL("../scripts/dev/screenshots/", import.meta.url).pathname;

test("ansi2html prints usage for --help and rejects a missing capture", () => {
  const help = spawnSync(process.execPath, [`${dir}ansi2html.mjs`, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: node ansi2html\.mjs <capture\.txt>/);

  const missing = spawnSync(process.execPath, [`${dir}ansi2html.mjs`], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^Usage: node ansi2html\.mjs <capture\.txt>/);
});

test("html2png prints usage for --help and rejects missing paths", () => {
  const help = spawnSync("python3", [`${dir}html2png.py`, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage: html2png\.py .* html out\n/);

  const missing = spawnSync("python3", [`${dir}html2png.py`, "in.html"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /required: out/);
});
