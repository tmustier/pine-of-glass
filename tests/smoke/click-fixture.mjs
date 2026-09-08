import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = process.env.TRACELINE_TEST_EXTENSION ?? join(root, "extensions/pi-traceline/index.ts");
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function createClickFixture(name) {
  const home = mkdtempSync(join(tmpdir(), `pog-${name}-home-`));
  const cwd = join(home, "project"), agent = join(home, ".pi/agent");
  const artifacts = mkdtempSync(join(tmpdir(), `pog-${name}-captures-`));
  const socketDir = process.env.CLAUDE_TMUX_SOCKET_DIR ?? join(tmpdir(), "claude-tmux-sockets");
  mkdirSync(socketDir, { recursive: true });
  const socket = join(socketDir, `pog-${name}-${process.pid}.sock`);
  const session = name;
  const monitor = `tmux -S ${quote(socket)} attach -t ${session}`;
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ hideThinkingBlock: true, defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol", fullscreenExitOutput: "none" }));
  writeFileSync(join(agent, "trust.json"), JSON.stringify({ [cwd]: true, [root]: true }));

  const iso = new Date().toISOString(), timestamp = Date.now();
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol", stopReason, usage, timestamp });
  const entries = [{ type: "session", version: 3, id: `${name}fixture`, timestamp: iso, cwd }];
  function append(message) {
    entries.push({ type: "message", id: `m${entries.length}`, parentId: entries.length > 1 ? `m${entries.length - 1}` : null, timestamp: iso, message });
  }
  function tmux(...args) {
    const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) throw new Error(result.stderr || `tmux ${args[0]} failed`);
    return result.stdout;
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
    keys("-H", ...[...Buffer.from(data)].map((b) => b.toString(16)));
  }
  function click(text, x) {
    sleep(550); // separate clicks from Pi's double/triple-click gestures
    const p = point(text);
    raw(0, x ?? p.x, p.y);
    raw(0, x ?? p.x, p.y, true);
    sleep(150);
  }
  let launched = false;
  function launch(width, height) {
    const sessionFile = join(cwd, "session.jsonl");
    writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", String(width), "-y", String(height), "-c", cwd,
      `exec env HOME=${quote(home)} pi --tui-mode fullscreen --no-extensions --no-skills --no-prompt-templates --no-themes -e ${quote(extension)} --session ${quote(sessionFile)}`);
    launched = true;
    console.log(`Monitor: ${monitor}`);
  }
  function close() {
    if (launched && process.argv.includes("--keep")) {
      console.log(`Kept for inspection: ${monitor}\nFixture HOME: ${home}`);
      return;
    }
    try { if (launched) tmux("kill-session", "-t", session); }
    finally { rmSync(home, { recursive: true, force: true }); }
  }
  return {
    cwd, artifacts, timestamp, assistant, append, tmux, session,
    capture, keys, wait, point, raw, click, sleep, launch, close,
    shot: (name) => writeFileSync(join(artifacts, `${name}.ansi`), capture(true)),
  };
}
