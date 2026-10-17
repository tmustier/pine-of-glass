#!/usr/bin/env node
// Real fullscreen Pi: replayed/live notices, mouse input, global toggles and reload.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClickFixture } from "./click-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const {
  cwd, artifacts, timestamp, assistant, append, keys, wait, click, sleep, launch, close, shot, capture,
} = createClickFixture("notice-rows", { extension: resolve(here, "notice-extension.ts") });

const custom = (customType, text, details) => ({ role: "custom", customType, content: [{ type: "text", text }], display: true, details, timestamp });
const tool = (i, path) => {
  const id = `call-${i}`;
  append(assistant([{ type: "toolCall", id, name: "read", arguments: { path: join(cwd, path) } }], "toolUse"));
  append({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `OUTPUT_${i}\n`.repeat(3) }], isError: false, timestamp });
};
const blankLinesBetween = (text, first, last) => {
  const lines = text.split("\n");
  const a = lines.findIndex((line) => line.includes(first)), b = lines.findIndex((line) => line.includes(last));
  assert.ok(a >= 0 && b > a, `${first} must precede ${last}:\n${text}`);
  return lines.slice(a + 1, b).filter((line) => line.trim() === "").length;
};

try {
  append({ role: "user", content: [{ type: "text", text: "Notice row fixture" }], timestamp });
  append(assistant([{ type: "text", text: "Delegating, then reading." }]));
  tool(0, "src/alpha.txt");
  append(custom("fixture-request", "REQUEST_BODY_FROM_SESSION\nsecond line"));
  tool(1, "src/beta.txt");
  append(custom("fixture-plain", "## Deploy finished\n\n**api-gateway** is live.\n" + "detail ".repeat(40)));
  tool(2, "other/gamma.txt");
  append(custom("fixture-summary", "# ignored heading", { summary: "summary wins over content" }));
  append(assistant([{ type: "text", text: "NOTICE_FIXTURE_READY" }]));
  launch(100, 60);
  wait((s) => s.includes("NOTICE_FIXTURE_READY") && s.includes("[fixture] worker needs a decision"), "replayed notice did not become a trace row");
  let screen = capture();
  assert.ok(!screen.includes("to expand"), `the key hint must not be on a trace line:\n${screen}`);
  assert.ok(!screen.includes("REQUEST_BODY_FROM_SESSION"), "collapsed notice must not show its body");
  assert.match(screen, /\[fixture-plain\] Deploy finished\s+0\.3k ch/, "default-rendered message: customType, first content line, char cell");
  assert.ok(screen.includes("[fixture-summary] summary wins over content"), `details.summary:\n${screen}`);
  assert.equal(blankLinesBetween(screen, "alpha.txt", "gamma.txt"), 0, "compact notices are block members: no blank lines inside the block");
  shot("01-compact");

  click("needs a decision");
  wait((s) => s.includes("REQUEST_BODY_FROM_SESSION"), "click did not open the extension's block");
  screen = capture();
  assert.ok(blankLinesBetween(screen, "REQUEST_BODY_FROM_SESSION", "beta.txt") >= 1, "the trace after an expanded notice starts with a blank line");
  assert.ok(!screen.includes("OUTPUT_"), "only the notice expanded");
  shot("02-expanded");
  click("REQUEST_BODY_FROM_SESSION");
  wait((s) => !s.includes("REQUEST_BODY_FROM_SESSION") && s.includes("[fixture] worker needs a decision"), "click on the open block did not collapse it");

  keys("C-o");
  wait((s) => s.includes("REQUEST_BODY_FROM_SESSION") && s.includes("OUTPUT_0") && s.includes("api-gateway"), "Ctrl+O did not expand notices with the tool rows");
  keys("C-o");
  wait((s) => !s.includes("REQUEST_BODY_FROM_SESSION") && !s.includes("OUTPUT_"), "Ctrl+O did not collapse notices with the tool rows");

  keys("C-t");
  wait((s) => s.includes("to expand") && s.includes("[fixture] worker needs a decision"), "Ctrl+T must hand the notice back to pi's own collapsed block");
  shot("03-native");
  keys("C-t");
  wait((s) => !s.includes("to expand") && s.includes("[fixture] worker needs a decision"), "Ctrl+T back did not restore the trace row");

  keys("-l", "/notice"); keys("Enter");
  wait((s) => s.includes("NOTICE_SENT"), "fixture command did not run");
  wait((s) => s.split("[fixture] worker needs a decision").length === 3 && s.includes("[fixture] reply sent to worker"), "live message and entry did not render as trace rows");
  screen = capture();
  assert.ok(!screen.includes("LIVE_REQUEST_BODY") && !screen.includes("LIVE_REPLY_BODY"), "live notices must start compact");
  shot("04-live");
  click("reply sent to worker");
  wait((s) => s.includes("LIVE_REPLY_BODY"), "live entry did not open on click");
  click("LIVE_REPLY_BODY");
  wait((s) => !s.includes("LIVE_REPLY_BODY"), "live entry did not collapse on click");

  keys("C-c"); keys("-l", "/reload"); keys("Enter");
  sleep(1500);
  wait((s) => s.includes("[fixture] reply sent to worker") && !s.includes("to expand"), "notice rows did not survive /reload");
  click("reply sent to worker");
  wait((s) => s.includes("LIVE_REPLY_BODY"), "mouse handler failed after reload");
  shot("05-reload");
  console.log(`PASS: replayed and live notices compact, block membership, click/Ctrl+O/Ctrl+T ladder, summary precedence, reload.\nCaptures: ${artifacts}`);
} finally {
  close();
}
