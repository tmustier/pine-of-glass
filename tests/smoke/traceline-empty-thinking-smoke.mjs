#!/usr/bin/env node
// Resume a real Pi session whose assistant message contains empty and whitespace-only
// thinking blocks before a real collapsed trace. A past Traceline implementation entered
// a synchronous loop while preparing previews for the empty block. Every subprocess call
// is bounded, and the uniquely launched Pi is killed on timeout so the smoke cannot leave
// a hot orphan behind.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(repoRoot, "extensions", "pi-traceline", "index.ts");
const tmuxSession = `pog-empty-thinking-${process.pid}`;
const sentinel = "EMPTY_THINKING_RESUME_SENTINEL";
const preview = "Thinking: informative reasoning survives";
const hardDeadline = Date.now() + 45_000;
let launchedPid;
let fixtureHome;
let fixtureDir;

function remainingMs(cap = 5_000) {
  return Math.max(1, Math.min(cap, hardDeadline - Date.now()));
}

function run(args, options = {}) {
  return spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: remainingMs(options.timeoutMs),
    ...options.spawn,
  });
}

// Cleanup keeps its own bounded budget after the render deadline has expired. Reusing
// remainingMs() here could reduce every cleanup command to 1 ms on the failure path.
function cleanupRun(args) {
  return spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 2_000 });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hasTmuxSession() {
  return run(["tmux", "has-session", "-t", tmuxSession], { timeoutMs: 2_000 }).status === 0;
}

function capturePane() {
  return run(["tmux", "capture-pane", "-p", "-t", tmuxSession, "-S", "-500"], {
    timeoutMs: 2_000,
  }).stdout ?? "";
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sessionEntries(cwd) {
  const iso = "2026-07-14T09:00:00.000Z";
  const timestamp = Date.parse(iso);
  return [
    { type: "session", version: 3, id: "00000001", parentId: null, timestamp: iso, cwd },
    {
      type: "message",
      id: "00000002",
      parentId: "00000001",
      timestamp: iso,
      message: {
        role: "user",
        content: [{ type: "text", text: "Resume the empty-thinking smoke fixture." }],
        timestamp,
      },
    },
    {
      type: "message",
      id: "00000003",
      parentId: "00000002",
      timestamp: iso,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "thinking", thinking: " \n\t\n " },
          { type: "thinking", thinking: "informative reasoning survives" },
          { type: "text", text: sentinel },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: timestamp + 1,
      },
    },
  ];
}

function cleanupLaunchedPi() {
  if (Number.isInteger(launchedPid)) {
    const panePid = Number.parseInt(
      cleanupRun(["tmux", "display-message", "-p", "-t", tmuxSession, "#{pane_pid}"]).stdout?.trim() ?? "",
      10,
    );
    const command = cleanupRun(["ps", "-p", String(launchedPid), "-o", "command="]).stdout ?? "";
    const fixtureOwned = command.includes(tmuxSession) || (fixtureDir && command.includes(fixtureDir));
    if (panePid === launchedPid || fixtureOwned) {
      try {
        process.kill(launchedPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  cleanupRun(["tmux", "kill-session", "-t", tmuxSession]);
}

if (run(["tmux", "-V"]).status !== 0) {
  console.error("tmux not available: real-Pi resume smoke requires tmux");
  process.exit(2);
}
if (run(["pi", "--version"]).status !== 0) {
  console.error("pi not on PATH: real-Pi resume smoke requires an installed Pi");
  process.exit(2);
}

fixtureHome = mkdtempSync(join(tmpdir(), "pog-empty-thinking-home-"));
fixtureDir = mkdtempSync(join(tmpdir(), `${tmuxSession}-`));
const agentDir = join(fixtureHome, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hideThinkingBlock: true }, null, 2));
writeFileSync(
  join(agentDir, "trust.json"),
  JSON.stringify({ [fixtureDir]: true, [repoRoot]: true }, null, 2),
);
writeFileSync(join(fixtureDir, "AGENTS.md"), "# Empty-thinking resume smoke\nFixture only.\n");
const sessionFile = join(fixtureDir, "session.jsonl");
writeFileSync(sessionFile, `${sessionEntries(fixtureDir).map((entry) => JSON.stringify(entry)).join("\n")}\n`);

let lastPane = "";
try {
  const command = [
    "exec env",
    `HOME=${shellQuote(fixtureHome)}`,
    "pi",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    shellQuote(extensionPath),
    "--session",
    shellQuote(sessionFile),
  ].join(" ");
  const launch = run([
    "tmux", "new-session", "-d", "-s", tmuxSession, "-x", "100", "-y", "30", command,
  ]);
  if (launch.status !== 0) throw new Error(`tmux launch failed: ${launch.stderr?.trim()}`);

  const pidResult = run(["tmux", "display-message", "-p", "-t", tmuxSession, "#{pane_pid}"], {
    timeoutMs: 2_000,
  });
  launchedPid = Number.parseInt(pidResult.stdout?.trim() ?? "", 10);
  if (!Number.isInteger(launchedPid)) throw new Error("could not identify the isolated Pi pane PID");

  while (Date.now() < hardDeadline && hasTmuxSession()) {
    lastPane = capturePane();
    if (lastPane.includes(sentinel) && lastPane.includes(preview)) break;
    sleep(250);
  }
  if (!lastPane.includes(sentinel)) {
    throw new Error(`resumed session did not render before the hard watchdog\n${lastPane}`);
  }
  if (!lastPane.includes(preview)) {
    throw new Error(`collapsed preview lost alignment after empty thinking blocks\n${lastPane}`);
  }

  run(["tmux", "send-keys", "-t", tmuxSession, "/quit", "Enter"], { timeoutMs: 2_000 });
  const exitDeadline = Math.min(hardDeadline, Date.now() + 5_000);
  while (Date.now() < exitDeadline && hasTmuxSession()) sleep(100);
  if (hasTmuxSession()) throw new Error("resumed Pi rendered but did not respond to /quit");

  console.log("real-Pi empty-thinking resume smoke passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanupLaunchedPi();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
}
