// Earning-command fitting (§9.8): real Pi bash call rendering, transformed through the
// SDK-loaded extension. Results are injected; no shell commands or providers run.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { createBashToolDefinition, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitBashLines } from "../../extensions/pi-traceline/bash-lines.ts";
import { recordFacts } from "../../extensions/pi-traceline/records.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { tildify } from "../../extensions/_lib/style.ts";
import { ComposedHarness, lines } from "./composed-harness.ts";

let h: ComposedHarness;
beforeEach(() => { h = new ComposedHarness(); });
afterEach(async () => { await h.dispose(); });

function bash(command: string, output: string) {
  const id = `earning-${h.toolCalls.size}`;
  const args = { command };
  const result = { content: [{ type: "text", text: output }], isError: false };
  const row = new ToolExecutionComponent("bash", id, args, {}, createBashToolDefinition(h.cwd), h.viewport.view, h.cwd);
  h.toolCalls.set(row, { type: "toolCall", id, name: "bash", arguments: args });
  row.updateResult(result);
  return { row, data: { toolName: "bash", args, result } };
}

const HOME = homedir();
const PUSH_OUTPUT = "To github.com/o/r.git\n   1c75c2a..50cf33f  main -> main\n";
const SEARCHES = "rg -n 'quotePack' src/features/cowork/canvas && rg -n 'doorServices' src/features/cowork/server";

test("an absolute-home push keeps its producer floor and wraps past an overlong predecessor", async () => {
  const command = `python3 -c '${"x".repeat(120)}' && rg -n 'doorServices' src/features/cowork/server && git -C ${HOME}/project push origin --force-with-lease topic/quote-pack-receipts`;
  const { row, data } = bash(command, PUSH_OUTPUT);
  await h.mount([row]);
  const shown = lines(row, 80);
  assert.match(shown.join("\n"), /git … push origin --forc/, "the actual push, not just its crown, must retain at least 24 columns");
  assert.equal(shown.length, 3, shown.join("\n"));
  assert.match(shown[0]!, / &&$/, "the overlong predecessor keeps its connector and yields another line");
  assert.match(shown[1]!, /rg -n 'doorServices'/);
  assert.ok(shown.every((line) => visibleWidth(line) <= 80));
  assert.equal(data.args.command, command, "display normalization never rewrites shell arguments");

  const fitted = fitBashLines(undefined, "text", tildify(command), 54, undefined, recordFacts(data).flatMap(({ by }) => by));
  assert.match(stripAnsi(fitted.first), /git … push origin --forc/, "non-wrapping fits protect the same producer floor");
});

test("a quoted substitution keeps the PR producer, not the preceding search, readable", async () => {
  const command = `${SEARCHES} && PR_URL="$(gh pr create --fill --title 'Add receipts' --base main)" && echo "$PR_URL"`;
  const { row, data } = bash(command, "https://github.com/o/r/pull/88");
  await h.mount([row]);
  const shown = lines(row, 80);
  assert.match(shown.join("\n"), /gh pr create --fill --ti/, "the nested producer itself must retain at least 24 columns");
  assert.match(shown[0]!, /opened PR #88 \$/);
  assert.ok(shown.every((line) => visibleWidth(line) <= 80));
  const ink = row.render(80).join("\n");
  assert.match(ink, /\x1b\[1mgh\x1b\[22m/, "the substitution's command is the crown (§9.4), not a fitting boundary");
  assert.doesNotMatch(ink, /\x1b\[1mpr\b/, "its argument is not");

  const fitted = fitBashLines(undefined, "text", command, 60, undefined, recordFacts(data).flatMap(({ by }) => by));
  assert.match(stripAnsi(fitted.first), /gh pr create --fill --ti/, "a one-line fit protects the producer rather than a containing crown slice");
});

test("a long env wrapper cannot spend the wrapped push's protected floor", async () => {
  const command = `${SEARCHES} && env -u GITHUB_TOKEN GH_PAGER=cat GH_PROMPT_DISABLED=1 GH_HOST=github.com git push origin --force-with-lease topic/quote-pack-receipts`;
  const { row, data } = bash(command, PUSH_OUTPUT);
  await h.mount([row]);
  const shown = lines(row, 80);
  assert.match(shown.join("\n"), /git push origin --force-/, "the producer after the wrapper must retain at least 24 columns");
  assert.match(shown[0]!, /pushed main \$/);
  assert.ok(shown.every((line) => visibleWidth(line) <= 80));
  assert.doesNotMatch(row.render(80).join("\n"), /\x1b\[1mgit/, "the wrapper's existing crown remains the only ink discriminator");

  const fitted = fitBashLines(undefined, "text", command, 60, undefined, recordFacts(data).flatMap(({ by }) => by));
  assert.match(stripAnsi(fitted.first), /git push origin --force-/, "non-wrapping fits cannot protect only the wrapper prefix");
});
