#!/usr/bin/env node
// Real fullscreen Pi, raw SGR mouse input through an isolated tmux PTY. No model calls.
import assert from "node:assert/strict";
import { join } from "node:path";
import { createClickFixture } from "./click-fixture.mjs";

const {
  cwd, artifacts, timestamp, assistant, append, tmux, session,
  capture, keys, wait, click, launch, close, shot,
} = createClickFixture("reasoning-click");

try {
  append({ role: "user", content: [{ type: "text", text: "Reasoning click fixture" }], timestamp });
  append(assistant([
    { type: "thinking", thinking: "FIRST_REASONING\nFIRST_NEWEST" },
    { type: "thinking", thinking: "FIRST_ADJACENT_BLOCK" },
    { type: "text", text: "VISIBLE_BRIDGE" },
    { type: "thinking", thinking: "SECOND_REASONING\nSECOND_DETAIL" },
    { type: "toolCall", id: "read-fixture", name: "read", arguments: { path: join(cwd, "fixture.txt") } },
  ], "toolUse"));
  append({ role: "toolResult", toolCallId: "read-fixture", toolName: "read", content: [{ type: "text", text: "fixture output" }], isError: false, timestamp });
  launch(100, 35);
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST · FIRST_ADJACENT_BLOCK") && text.includes("SECOND_REASONING · SECOND_DETAIL"), "reasoning previews did not render");
  shot("01-compact");
  keys("M-t");
  wait((text) => text.includes("drill · row"), "Drill did not open");
  click("FIRST_REASONING");
  assert.ok(capture().includes("FIRST_REASONING · FIRST_NEWEST"), "reasoning click reflowed Drill");
  keys("Escape");
  wait((text) => !text.includes("drill · row"), "Drill did not close");
  click("FIRST_REASONING");
  wait((text) => text.includes("FIRST_NEWEST") && !text.includes("FIRST_REASONING · FIRST_NEWEST") && text.includes("SECOND_REASONING · SECOND_DETAIL"), "first reasoning run did not expand independently");
  shot("02-first-expanded");
  keys("M-t");
  wait((text) => text.includes("drill · row"), "Drill did not reopen");
  click("FIRST_NEWEST");
  assert.ok(!capture().includes("FIRST_REASONING · FIRST_NEWEST"), "expanded reasoning collapsed during Drill");
  keys("Escape");
  wait((text) => !text.includes("drill · row"), "Drill did not close");
  click("FIRST_NEWEST");
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST · FIRST_ADJACENT_BLOCK"), "expanded reasoning did not collapse natively");
  click("SECOND_REASONING");
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST") && !text.includes("SECOND_REASONING · SECOND_DETAIL") && text.includes("SECOND_DETAIL"), "second run click failed");
  keys("C-t");
  wait((text) => !text.includes("FIRST_REASONING · FIRST_NEWEST") && text.includes("FIRST_NEWEST"), "Ctrl+T did not clear overrides into global visible state");
  keys("C-o");
  wait((text) => text.includes("fixture output"), "Ctrl+O did not expand tool output");
  click("FIRST_REASONING");
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST · FIRST_ADJACENT_BLOCK") && !text.includes("SECOND_REASONING · SECOND_DETAIL") && !text.includes("Thinking...") && text.includes("fixture output"), "globally visible reasoning must collapse to a Traceline preview without collapsing tools");
  shot("04-native-mode-collapsed-run");
  click("FIRST_REASONING");
  wait((text) => !text.includes("FIRST_REASONING · FIRST_NEWEST"), "native-mode preview did not reopen");
  keys("C-o");
  wait((text) => !text.includes("fixture output"), "Ctrl+O did not restore tool state");
  keys("C-t");
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST · FIRST_ADJACENT_BLOCK"), "Ctrl+T did not restore global compact state");
  tmux("resize-window", "-t", session, "-x", "60", "-y", "35");
  wait((text) => text.split("\n").includes("─".repeat(60)), "resize did not repaint");
  click("SECOND_REASONING");
  wait((text) => !text.includes("SECOND_REASONING · SECOND_DETAIL"), "resized reasoning click failed");
  shot("03-narrow-second-expanded");
  keys("-l", "/reload"); keys("Enter");
  wait((text) => text.includes("SECOND_REASONING · SECOND_DETAIL"), "reload did not restore native compact state");
  click("SECOND_REASONING");
  wait((text) => !text.includes("SECOND_REASONING · SECOND_DETAIL"), "reasoning click failed after reload");
  console.log(`PASS: reasoning clicks, independent runs, Drill isolation, Ctrl+T, resize and reload.\nCaptures: ${artifacts}`);
} finally {
  close();
}
