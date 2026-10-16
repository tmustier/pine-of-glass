// Failure facts (design language §9.2.1): a failed row says why in its suffix, read
// from the result the model received, in the size cell's place below warning severity.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { failureFact } from "../../extensions/pi-traceline/failure.ts";
import { ComposedHarness, line, lines, rawLine } from "./composed-harness.ts";

// SAFETY: Pi's built-in renderer path is pinned by pi-internals.test.ts.
const { withBuiltInRenderers }: { withBuiltInRenderers: (name: string, definition: undefined) => ToolRenderers | undefined } = await import(
  new URL("./core/tools/renderers/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);

let h: ComposedHarness;
beforeEach(() => { h = new ComposedHarness(); });
afterEach(async () => { await h.dispose(); });

function bash(command: string, text: string, error = true): ToolExecutionComponent {
  const id = `bash-${h.toolCalls.size}`;
  const args = { command };
  const row = new ToolExecutionComponent("bash", id, args, {}, withBuiltInRenderers("bash", undefined), h.viewport.view, h.cwd);
  h.toolCalls.set(row, { type: "toolCall", id, name: "bash", arguments: args });
  row.updateResult({ content: [{ type: "text", text }], isError: error }, false);
  return row;
}

test("bash restates pi's status line: exit code, timeout, abort", () => {
  assert.deepEqual(failureFact("bash", "some output\n\nCommand exited with code 2", "ls /nope"), { text: "exit 2", parsed: true });
  assert.deepEqual(failureFact("bash", "partial\n\nCommand timed out after 30 seconds", "sleep 60"), { text: "timeout 30s", parsed: true });
  assert.deepEqual(failureFact("bash", "Command aborted", "sleep 60"), { text: "aborted", parsed: true });
  assert.deepEqual(failureFact("bash", "Command terminated without an exit code", "x"), { text: "no exit code", parsed: true });
  assert.deepEqual(failureFact("bash", "bash: nope: command not found", "nope"), { text: "bash: nope: command not found", parsed: false }, "no status line: the last line speaks");
  assert.equal(failureFact("bash", "   \n", "x"), undefined);
});

test("a lone search that exited 1 in silence found nothing; anything else is an exit code", () => {
  const silent = "Command exited with code 1";
  assert.equal(failureFact("bash", silent, 'rg -n "TODO" src/')?.text, "no matches");
  assert.equal(failureFact("bash", silent, "grep -rn TODO src/")?.text, "no matches");
  assert.equal(failureFact("bash", silent, 'cd ~/repo && rg -n "TODO" src/')?.text, "no matches", "a situating cd is allowed in front");
  assert.equal(failureFact("bash", silent, "rg 'a|b' src/")?.text, "no matches", "alternation inside quotes is not a pipe");
  assert.equal(failureFact("bash", silent, "rg TODO src/ | head -3")?.text, "exit 1", "a pipeline's status is the filter's");
  assert.equal(failureFact("bash", silent, "rg TODO src/ && echo found")?.text, "exit 1", "two real commands: the status is ambiguous");
  assert.equal(failureFact("bash", "bash: cd: /nope: No such file or directory\n\nCommand exited with code 1", "cd /nope && rg TODO src/")?.text, "exit 1", "a complaint means the search did not run");
  assert.equal(failureFact("bash", "Command exited with code 2", "rg TODO src/")?.text, "exit 2", "rg's 2 is an error, not a miss");
});

test("a composed call quotes the thrown error's first line; other tools quote their last line", () => {
  const script = "Script failed\nWall time 0.4 seconds\nOutput:\nsome output\n\nScript error:\nError: ENOENT: no such file\n    at <anonymous>:2:3\n\nTool calls made before the failure (they are not undone): read (error)";
  assert.deepEqual(failureFact("codemode", script), { text: "Error: ENOENT: no such file", parsed: false });
  assert.deepEqual(failureFact("codemode", "Script error:\nScript timed out: 60s elapsed\n\nNo tool calls were made."), { text: "timeout", parsed: true });
  assert.deepEqual(failureFact("codemode", "Script error:\nScript aborted: user\n"), { text: "aborted", parsed: true });
  assert.deepEqual(failureFact("codemode", "Script error:\nScript sandbox failed: out of memory\n"), { text: "sandbox failed", parsed: true });
  assert.deepEqual(failureFact("read", "Error reading file: ENOENT: no such file or directory, open '/x/y.md'"), { text: "Error reading file: ENOENT: no such file or directory, open '/x/y.md'", parsed: false });
  assert.deepEqual(failureFact("mcp__linear__save_issue", "Validation failed\n  title: required\nRequest rejected (422)"), { text: "Request rejected (422)", parsed: false }, "diagnostics end with their diagnosis");
});

test("a failed bash row carries its fact in the size cell's place; a ballooned error re-earns the cell", async () => {
  const miss = bash('rg -n "legacyQuote" src/', "Command exited with code 1");
  const crash = bash("npm run build", `${"x".repeat(400)}\nerror TS2322: nope\n\nCommand exited with code 2`);
  const flood = bash("npm run lint", `${"x".repeat(12_000)}\n\nCommand exited with code 1`);
  const fine = bash("ls", "x".repeat(300), false);
  await h.mount([miss, crash, flood, fine]);
  const rows = [miss, crash, flood, fine].map((row) => line(row, 100));
  assert.match(rows[0]!, /^ {2}▏ › \$ rg -n "legacyQuote" src\/ {2,}no matches$/, rows[0]);
  assert.match(rows[1]!, /^ {2}▏ › \$ npm run build {2,}exit 2$/, "the error text's size is not pulled context");
  assert.match(rows[2]!, /^ {2}▏ › \$ npm run lint {2,}exit 1 · 12\.0k ch$/, "at warning severity the size is a story of its own");
  assert.match(rows[3]!, /^ {2}▏ › \$ ls {2,}0\.3k ch$/);
  const edges = new Set(rows.map((row) => row.length));
  assert.equal(edges.size, 1, `one right edge for the block: ${[...edges]}`);
  const raw = rawLine(miss, 100);
  assert.match(raw, /\x1b\[31mno matches/, "the fact wears error ink");
  assert.match(raw, /\x1b\[31m›/, "the bullet stays the status carrier");
});

test("a free-text fact middle-cuts to its share, and a repetition fold borrows its failed member's fact", async () => {
  const command = "node scripts/missing.mjs";
  const text = "node:internal/modules/run_main:123\n  throw err;\n\nError: Cannot find module '/Users/me/projects/demo/scripts/missing.mjs'\n\nCommand exited with code 1";
  const a = bash(command, text);
  const b = bash(command, text);
  const other = bash("curl -sf https://x.test/api", "curl: (22) The requested URL returned error: 404 Not Found");
  await h.mount([a, b, other]);
  const folded = lines(a, 100);
  assert.equal(folded.length, 1);
  assert.match(folded[0]!, /^ {2}▏ ▸ \$ node scripts\/missing\.mjs ×2 {2,}exit 1$/);
  assert.deepEqual(lines(b, 100), []);
  assert.match(line(other, 80), /^ {2}▏ › \$ curl -sf https:\/\/x\.test\/api {2,}curl: \(22\) …04 Not Found$/);
});
