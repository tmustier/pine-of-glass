import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function checkNotes(directory: string) {
  const pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  assert.equal(pkg.pi.changelogPath, "./UPDATE_NOTES.md");
  const notes = readFileSync(resolve(directory, pkg.pi.changelogPath), "utf8");
  const history = readFileSync(resolve(directory, "CHANGELOG.md"), "utf8");
  const headings = [...notes.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  for (const heading of headings) {
    assert.match(heading, /^\[\d+\.\d+\.\d+\]$/);
    const version = heading.slice(1, -1);
    assert.ok(history.includes(version), `${pkg.name}: note has no detailed history`);
    assert.ok(version.localeCompare(pkg.version, undefined, { numeric: true }) <= 0,
      `${pkg.name}: startup notes must not announce unpublished versions`);
  }
  for (const entry of notes.split(/^## /m).slice(1)) {
    assert.match(entry, /\n\s*\n- \S/, `${pkg.name}: empty startup notice`);
  }
  if (pkg.files) assert.ok(pkg.files.includes("UPDATE_NOTES.md"));
  return { pkg, notes };
}

test("startup notes apply even when only one family extension is loaded", () => {
  const { notes } = checkNotes(root);
  assert.ok(notes.includes("affects every extension"));
  assert.ok(notes.includes("## [0.18.3]"), "shared configuration change is relevant");
  assert.ok(!notes.includes("## [0.18.4]"), "Traceline-only links must not notify Contextimate-only users");
});
