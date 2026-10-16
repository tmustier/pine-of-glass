import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const scripts = new URL("../../scripts/dev/bash-corpus/", import.meta.url);

test("corpus extraction and replay distinguish failed and successful silent commands", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pog-record-corpus-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = join(dir, "sessions");
  const results = join(dir, "results.jsonl");
  const census = join(dir, "census.json");
  mkdirSync(sessions);
  const entries = [true, false, false].flatMap((isError, i) => [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `${i}`, name: "bash", arguments: { command: "gh pr merge 87" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: `${i}`, content: [{ type: "text", text: "(no output)" }], isError } },
  ]);
  writeFileSync(join(sessions, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));

  const extract = spawnSync(process.execPath, [new URL("extract-results.mjs", scripts).pathname, "--sessions", sessions, "--out", results], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const replay = spawnSync(process.execPath, [new URL("records.ts", scripts).pathname, "--results", results, "--census", census], { encoding: "utf8" });
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(readFileSync(census, "utf8")), {
    rows: 2,
    recordRows: 1,
    records: { "merged [quiet]": 1 },
  });
});
