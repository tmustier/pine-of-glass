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
const home = mkdtempSync(join(tmpdir(), "pog-click-home-"));
const cwd = join(home, "project");
const agent = join(home, ".pi/agent");
const socketDir = process.env.CLAUDE_TMUX_SOCKET_DIR ?? join(tmpdir(), "claude-tmux-sockets");
mkdirSync(socketDir, { recursive: true });
const socket = join(socketDir, `pog-click-${process.pid}.sock`);
const session = "click-test";
const artifacts = mkdtempSync(join(tmpdir(), "pog-click-captures-"));
const keep = process.argv.includes("--keep");
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function tmux(...args) {
  const r = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) throw new Error(r.stderr || `tmux ${args[0]} failed`);
  return r.stdout;
}
const capture = (ansi = false) => tmux("capture-pane", "-p", ...(ansi ? ["-e"] : []), "-t", session);
const keys = (...ks) => tmux("send-keys", "-t", session, ...ks);
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
function point(text) {
  const lines = capture().split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, `cannot find ${text}`);
  return { x: lines[y].indexOf(text), y };
}
function raw(button, x, y, release = false) {
  const data = `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`;
  tmux("send-keys", "-t", session, "-H", ...[...Buffer.from(data)].map((b) => b.toString(16)));
}
function click(text, x) {
  const p = point(text);
  // Avoid classifying successive automation gestures as a double/triple click.
  sleep(550);
  raw(0, x ?? p.x, p.y);
  raw(0, x ?? p.x, p.y, true);
  sleep(150);
}
function shot(name) { writeFileSync(join(artifacts, `${name}.ansi`), capture(true)); }

mkdirSync(cwd, { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "settings.json"), JSON.stringify({ hideThinkingBlock: true, defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol", fullscreenExitOutput: "none" }));
writeFileSync(join(agent, "trust.json"), JSON.stringify({ [cwd]: true, [root]: true }));
const iso = new Date().toISOString(), timestamp = Date.now();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", stopReason, usage, timestamp });
const entries = [{ type: "session", version: 3, id: "clickfixture", timestamp: iso, cwd }];
function append(message) {
  entries.push({ type: "message", id: `m${entries.length}`, parentId: entries.length > 1 ? `m${entries.length - 1}` : null, timestamp: iso, message });
}
append({ role: "user", content: [{ type: "text", text: "Mouse expansion fixture" }], timestamp });
append(assistant([{ type: "text", text: "Inspect three sibling files, then a separate call." }]));
for (const [i, path] of ["src/alpha.txt", "src/beta.txt", "src/gamma.txt", "other/solo.txt"].entries()) {
  const id = `call-${i}`;
  append(assistant([{ type: "toolCall", id, name: "read", arguments: { path: join(cwd, path) } }], "toolUse"));
  append({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `OUTPUT_${path.split("/").pop().split(".")[0].toUpperCase()}\nsecond result line\nthird result line` }], isError: false, timestamp });
}
append(assistant([{ type: "text", text: "CLICK_FIXTURE_READY" }]));
const sessionFile = join(cwd, "session.jsonl");
writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const monitor = `tmux -S ${quote(socket)} attach -t ${session}`;
let launched = false;
try {
  tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "100", "-y", "40", "-c", cwd,
    `exec env HOME=${quote(home)} pi --tui-mode fullscreen --no-extensions --no-skills --no-prompt-templates --no-themes -e ${quote(extension)} --session ${quote(sessionFile)}`);
  launched = true;
  console.log(`Monitor: ${monitor}`);
  wait((s) => s.includes("CLICK_FIXTURE_READY") && s.includes("3 calls"), "fixture did not become compact");
  keys("-l", "draft stays here");
  wait((s) => s.includes("draft stays here"), "draft did not appear");
  shot("01-folded");
  keys("M-t");
  wait((s) => s.includes("drill · row"), "Drill did not open");
  click("3 calls");
  assert.ok(capture().includes("3 calls"), "mouse changed Drill's frozen targets");
  keys("Escape");
  wait((s) => s.includes("draft stays here"), "Drill did not restore draft");
  click("3 calls");
  wait((s) => !s.includes("3 calls") && s.includes("▾") && !s.includes("OUTPUT_"), "aggregate must reveal compact members only");
  shot("02-revealed");
  click("beta.txt");
  wait((s) => s.includes("OUTPUT_BETA") && !s.includes("OUTPUT_ALPHA"), "individual beta expansion failed");
  shot("03-beta-expanded");
  click("solo.txt");
  wait((s) => s.includes("OUTPUT_BETA") && s.includes("OUTPUT_SOLO"), "independent solo expansion failed");
  click("OUTPUT_BETA");
  wait((s) => !s.includes("OUTPUT_BETA") && s.includes("OUTPUT_SOLO") && s.includes("▾"), "native output click must collapse only beta");
  click("solo.txt");
  wait((s) => !s.includes("OUTPUT_"), "native header collapse failed");
  const beforeDrag = capture();
  const p = point("beta.txt");
  raw(0, p.x, p.y); raw(32, p.x + 4, p.y); raw(0, p.x + 4, p.y, true);
  sleep(200);
  assert.ok(!capture().includes("OUTPUT_"), "drag expanded a call");
  assert.ok(capture().includes("draft stays here"), "clicks stole editor draft");
  // A genuine single click after a drag should still work.
  click("beta.txt");
  wait((s) => s.includes("OUTPUT_BETA"), "click after drag failed");
  click("alpha.txt", 4);
  wait((s) => s.includes("3 calls") && !s.includes("OUTPUT_"), "group glyph did not collapse/refold members");
  shot("04-refolded");
  assert.equal(beforeDrag.includes("3 calls"), false);
  tmux("resize-window", "-t", session, "-x", "60", "-y", "40");
  wait((s) => s.includes("3 calls"), "resize lost aggregate");
  click("gamma.txt");
  wait((s) => !s.includes("3 calls") && s.includes("▾"), "wrapped aggregate click failed");
  click("gamma.txt");
  wait((s) => s.includes("OUTPUT_GAMMA"), "resized individual click failed");
  shot("05-narrow-expanded");
  click("gamma.txt");
  tmux("resize-window", "-t", session, "-x", "100", "-y", "40");
  tmux("resize-window", "-t", session, "-x", "100", "-y", "60");
  keys("C-o");
  wait((s) => s.includes("OUTPUT_ALPHA") && s.includes("OUTPUT_SOLO"), "Ctrl+O did not expand all");
  keys("C-o");
  wait((s) => !s.includes("OUTPUT_"), "Ctrl+O did not collapse all");
  keys("C-t"); sleep(200); keys("C-t");
  wait((s) => s.includes("▾") && !s.includes("OUTPUT_"), "Ctrl+T did not preserve revealed compact state");
  keys("C-c"); keys("-l", "/reload"); keys("Enter");
  wait((s) => s.includes("3 calls") && !s.includes("▾"), "reload did not reset transient fold state");
  click("3 calls"); click("beta.txt");
  wait((s) => s.includes("OUTPUT_BETA"), "mouse handler failed after reload");
  shot("06-reload-expanded");
  console.log(`PASS: aggregate reveal/refold, independent expansion, native collapse, drag, draft, resize, Ctrl+O/T, Drill isolation, reload.\nCaptures: ${artifacts}`);
} finally {
  if (launched && keep) console.log(`Kept for inspection: ${monitor}\nFixture HOME: ${home}`);
  else {
    if (launched) tmux("kill-session", "-t", session);
    rmSync(home, { recursive: true, force: true });
    console.log(`Closed test session. Monitor command (while running): ${monitor}`);
  }
}
