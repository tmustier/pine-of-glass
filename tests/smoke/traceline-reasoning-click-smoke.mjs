#!/usr/bin/env node
// Real fullscreen Pi, raw SGR mouse input through an isolated tmux PTY. No model calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = process.env.TRACELINE_TEST_EXTENSION ?? join(root, "extensions/pi-traceline/index.ts");
const home = mkdtempSync(join(tmpdir(), "pog-reasoning-click-home-"));
const cwd = join(home, "project");
const socket = join(tmpdir(), `pog-reasoning-click-${process.pid}.sock`);
const session = "reasoning-click-test";
const artifacts = mkdtempSync(join(tmpdir(), "pog-reasoning-captures-"));
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function tmux(...args) {
  const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || `tmux ${args[0]} failed`);
  return result.stdout;
}
const capture = () => tmux("capture-pane", "-p", "-t", session);
const shot = (name) => writeFileSync(join(artifacts, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", session));
function wait(predicate, description) {
  const deadline = Date.now() + 12000;
  let text;
  do {
    text = capture();
    if (predicate(text)) return text;
    sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${description}\n${text}`);
}
function click(text) {
  sleep(550);
  const lines = capture().split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, `cannot find ${text}`);
  const x = lines[y].indexOf(text) + 1;
  for (const release of [false, true]) {
    const data = `\x1b[<0;${x + 1};${y + 1}${release ? "m" : "M"}`;
    tmux("send-keys", "-t", session, "-H", ...[...Buffer.from(data)].map((b) => b.toString(16)));
  }
}

mkdirSync(cwd, { recursive: true });
mkdirSync(join(home, ".pi/agent"), { recursive: true });
writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ hideThinkingBlock: true, fullscreenExitOutput: "none" }));
writeFileSync(join(home, ".pi/agent/trust.json"), JSON.stringify({ [cwd]: true, [root]: true }));
const iso = new Date().toISOString(), timestamp = Date.now();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = {
  role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", stopReason: "toolUse", usage, timestamp,
  content: [
    { type: "thinking", thinking: "FIRST_REASONING\nFIRST_NEWEST" },
    { type: "thinking", thinking: "FIRST_ADJACENT_BLOCK" },
    { type: "text", text: "VISIBLE_BRIDGE" },
    { type: "thinking", thinking: "SECOND_REASONING\nSECOND_DETAIL" },
    { type: "toolCall", id: "read-fixture", name: "read", arguments: { path: join(cwd, "fixture.txt") } },
  ],
};
const entries = [
  { type: "session", version: 3, id: "reasoningclickfixture", timestamp: iso, cwd },
  { type: "message", id: "m1", parentId: null, timestamp: iso, message: { role: "user", content: [{ type: "text", text: "Reasoning click fixture" }], timestamp } },
  { type: "message", id: "m2", parentId: "m1", timestamp: iso, message },
  { type: "message", id: "m3", parentId: "m2", timestamp: iso, message: {
    role: "toolResult", toolCallId: "read-fixture", toolName: "read", content: [{ type: "text", text: "fixture output" }], isError: false, timestamp,
  } },
];
const sessionFile = join(cwd, "session.jsonl");
writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
let launched = false;
try {
  tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "100", "-y", "35", "-c", cwd,
    `exec env HOME=${quote(home)} pi --tui-mode fullscreen --no-extensions --no-skills --no-prompt-templates --no-themes -e ${quote(extension)} --session ${quote(sessionFile)}`);
  launched = true;
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST · FIRST_ADJACENT_BLOCK") && text.includes("SECOND_REASONING · SECOND_DETAIL"), "reasoning previews did not render");
  shot("01-compact");
  tmux("send-keys", "-t", session, "M-t");
  wait((text) => text.includes("drill · row"), "Drill did not open");
  click("FIRST_REASONING");
  sleep(200);
  assert.ok(capture().includes("FIRST_REASONING · FIRST_NEWEST"), "reasoning click reflowed Drill");
  tmux("send-keys", "-t", session, "Escape");
  wait((text) => !text.includes("drill · row"), "Drill did not close");
  click("FIRST_REASONING");
  wait((text) => text.includes("FIRST_NEWEST") && !text.includes("FIRST_REASONING · FIRST_NEWEST") && text.includes("SECOND_REASONING · SECOND_DETAIL"), "first reasoning run did not expand independently");
  shot("02-first-expanded");
  tmux("send-keys", "-t", session, "M-t");
  wait((text) => text.includes("drill · row"), "Drill did not reopen");
  click("FIRST_NEWEST");
  sleep(200);
  assert.ok(!capture().includes("FIRST_REASONING · FIRST_NEWEST"), "expanded reasoning collapsed during Drill");
  tmux("send-keys", "-t", session, "Escape");
  wait((text) => !text.includes("drill · row"), "Drill did not close");
  click("FIRST_NEWEST");
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST · FIRST_ADJACENT_BLOCK"), "expanded reasoning did not collapse natively");
  click("SECOND_REASONING");
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST") && !text.includes("SECOND_REASONING · SECOND_DETAIL") && text.includes("SECOND_DETAIL"), "second run click failed");
  tmux("send-keys", "-t", session, "C-t");
  wait((text) => !text.includes("FIRST_REASONING · FIRST_NEWEST") && text.includes("FIRST_NEWEST"), "Ctrl+T did not clear overrides into global visible state");
  tmux("send-keys", "-t", session, "C-t");
  wait((text) => text.includes("FIRST_REASONING · FIRST_NEWEST · FIRST_ADJACENT_BLOCK"), "Ctrl+T did not restore global compact state");
  tmux("resize-window", "-t", session, "-x", "60", "-y", "35");
  wait((text) => text.split("\n").includes("─".repeat(60)), "resize did not repaint");
  click("SECOND_REASONING");
  wait((text) => !text.includes("SECOND_REASONING · SECOND_DETAIL"), "resized reasoning click failed");
  shot("03-narrow-second-expanded");
  tmux("send-keys", "-t", session, "-l", "/reload");
  tmux("send-keys", "-t", session, "Enter");
  wait((text) => text.includes("SECOND_REASONING · SECOND_DETAIL"), "reload did not restore native compact state");
  click("SECOND_REASONING");
  wait((text) => !text.includes("SECOND_REASONING · SECOND_DETAIL"), "reasoning click failed after reload");
  console.log(`PASS: reasoning clicks, independent runs, Drill isolation, Ctrl+T, resize and reload.\nCaptures: ${artifacts}`);
} finally {
  if (launched) tmux("kill-session", "-t", session);
  rmSync(home, { recursive: true, force: true });
}
