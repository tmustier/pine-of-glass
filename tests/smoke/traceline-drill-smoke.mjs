#!/usr/bin/env node
// Resume a real Pi session with two completed read rows, prove Ctrl+T returns from a
// Ctrl+O-expanded view to the trace (design language §9.12), then walk drill mode end
// to end (§9.13): Alt+T numbers the rows with zero reflow and swaps the editor (and
// its draft) for the hint bar, a committed digit opens the peek pager on the full
// result, esc unwinds to the numbered transcript and then back to the editor with the
// draft intact, and a foreign chord (alt+up) exits the mode un-consumed so the same
// press reaches the restored editor. Every subprocess call is bounded and the
// uniquely launched Pi is killed on timeout.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(repoRoot, "extensions", "pi-traceline", "index.ts");
const tmuxSession = `pog-drill-${process.pid}`;
const readySentinel = "DRILL_SMOKE_READY";
const alphaResult = `DRILL_RESULT_ALPHA ${"a".repeat(160)}`;
const betaResult = `DRILL_RESULT_BETA ${"b".repeat(160)}`;
const draft = "drill smoke draft";
const hardDeadline = Date.now() + 60_000;
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

function sendKeys(...keys) {
  return run(["tmux", "send-keys", "-t", tmuxSession, ...keys], { timeoutMs: 2_000 });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Poll the pane until predicate(pane) holds; returns the pane text either way.
function waitForPane(predicate) {
  let pane = "";
  while (Date.now() < hardDeadline && hasTmuxSession()) {
    pane = capturePane();
    if (predicate(pane)) return pane;
    sleep(200);
  }
  return pane;
}

function waitForHiddenThinking(settingsPath, expected) {
  while (Date.now() < hardDeadline && hasTmuxSession()) {
    try {
      if (JSON.parse(readFileSync(settingsPath, "utf8")).hideThinkingBlock === expected) return true;
    } catch {
      // The settings write may be in flight; keep polling within the smoke deadline.
    }
    sleep(100);
  }
  return false;
}

function sessionEntries(cwd) {
  const iso = "2026-07-16T09:00:00.000Z";
  const timestamp = Date.parse(iso);
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistantShell = { api: "anthropic-messages", provider: "anthropic", model: "claude-opus-4-8", usage };
  return [
    { type: "session", version: 3, id: "00000001", parentId: null, timestamp: iso, cwd },
    {
      type: "message",
      id: "00000002",
      parentId: "00000001",
      timestamp: iso,
      message: { role: "user", content: [{ type: "text", text: "Resume the drill smoke fixture." }], timestamp },
    },
    {
      type: "message",
      id: "00000003",
      parentId: "00000002",
      timestamp: iso,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-alpha", name: "read", arguments: { path: join(cwd, "alpha.txt"), offset: 1, limit: 40 } }],
        ...assistantShell,
        stopReason: "toolUse",
        timestamp: timestamp + 1,
      },
    },
    {
      type: "message",
      id: "00000004",
      parentId: "00000003",
      timestamp: iso,
      message: {
        role: "toolResult",
        toolCallId: "call-alpha",
        toolName: "read",
        content: [{ type: "text", text: alphaResult }],
        isError: false,
        timestamp: timestamp + 2,
      },
    },
    {
      type: "message",
      id: "00000005",
      parentId: "00000004",
      timestamp: iso,
      message: {
        role: "assistant",
        // a different directory on purpose: consecutive sibling reads would fold into one dir row (§9.9)
        content: [{ type: "toolCall", id: "call-beta", name: "read", arguments: { path: join(cwd, "sub", "beta.txt"), offset: 1, limit: 40 } }],
        ...assistantShell,
        stopReason: "toolUse",
        timestamp: timestamp + 3,
      },
    },
    {
      type: "message",
      id: "00000006",
      parentId: "00000005",
      timestamp: iso,
      message: {
        role: "toolResult",
        toolCallId: "call-beta",
        toolName: "read",
        content: [{ type: "text", text: betaResult }],
        isError: false,
        timestamp: timestamp + 4,
      },
    },
    {
      type: "message",
      id: "00000007",
      parentId: "00000006",
      timestamp: iso,
      message: {
        role: "assistant",
        content: [{ type: "text", text: readySentinel }],
        ...assistantShell,
        stopReason: "stop",
        timestamp: timestamp + 5,
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
  console.error("tmux not available: real-Pi drill smoke requires tmux");
  process.exit(2);
}
if (run(["pi", "--version"]).status !== 0) {
  console.error("pi not on PATH: real-Pi drill smoke requires an installed Pi");
  process.exit(2);
}

fixtureHome = mkdtempSync(join(tmpdir(), "pog-drill-home-"));
fixtureDir = mkdtempSync(join(tmpdir(), `${tmuxSession}-`));
const agentDir = join(fixtureHome, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
const settingsPath = join(agentDir, "settings.json");
writeFileSync(settingsPath, JSON.stringify({ hideThinkingBlock: true }, null, 2));
writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [fixtureDir]: true, [repoRoot]: true }, null, 2));
writeFileSync(join(fixtureDir, "AGENTS.md"), "# Drill smoke\nFixture only.\n");
const sessionFile = join(fixtureDir, "session.jsonl");
writeFileSync(sessionFile, `${sessionEntries(fixtureDir).map((entry) => JSON.stringify(entry)).join("\n")}\n`);

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
  const launch = run(["tmux", "new-session", "-d", "-s", tmuxSession, "-x", "110", "-y", "32", command]);
  if (launch.status !== 0) throw new Error(`tmux launch failed: ${launch.stderr?.trim()}`);

  const pidResult = run(["tmux", "display-message", "-p", "-t", tmuxSession, "#{pane_pid}"], { timeoutMs: 2_000 });
  launchedPid = Number.parseInt(pidResult.stdout?.trim() ?? "", 10);
  if (!Number.isInteger(launchedPid)) throw new Error("could not identify the isolated Pi pane PID");

  // 1. Resume renders both trace rows.
  const resumed = waitForPane((pane) =>
    pane.includes(readySentinel) && pane.includes("alpha.txt") && pane.includes("beta.txt"));
  if (!resumed.includes(readySentinel)) throw new Error(`resumed session did not render\n${resumed}`);
  const traceRowsOf = (pane) => pane.split("\n").filter((line) => /alpha\.txt|beta\.txt/.test(line));
  const beforeRows = traceRowsOf(resumed).map((line) => line.trimEnd());
  if (beforeRows.length !== 2) throw new Error(`expected two trace rows, saw:\n${resumed}`);

  // 2. Ctrl+O opens z1. Ctrl+T still owns the next transition: it clears z1 before
  // Pi shows reasoning, and a second Ctrl+T therefore returns to z0 trace rows.
  sendKeys("C-o");
  const expanded = waitForPane((pane) => pane.includes("DRILL_RESULT_ALPHA") && !traceRowsOf(pane).some((line) => line.includes("▏")));
  if (!expanded.includes("DRILL_RESULT_ALPHA")) throw new Error(`Ctrl+O did not expand the native tool rows\n${expanded}`);
  sendKeys("C-t");
  if (!waitForHiddenThinking(settingsPath, false)) throw new Error("first Ctrl+T did not reach Pi's native reasoning toggle");
  sendKeys("C-t");
  if (!waitForHiddenThinking(settingsPath, true)) throw new Error("second Ctrl+T did not return to hidden reasoning");
  const retraced = waitForPane((pane) => {
    const rows = traceRowsOf(pane);
    return rows.length === 2 && rows.every((line) => line.includes("▏"));
  });
  const retracedRows = traceRowsOf(retraced).map((line) => line.trimEnd());
  if (retracedRows.join("\n") !== beforeRows.join("\n")) {
    throw new Error(`Ctrl+T left Ctrl+O rows pinned open instead of restoring the trace\n${retraced}`);
  }

  // 3. A draft, then Alt+T: hint bar replaces the editor, numbers land at equal width.
  sendKeys(draft);
  const withDraft = waitForPane((pane) => pane.includes(draft));
  if (!withDraft.includes(draft)) throw new Error(`draft never appeared in the editor\n${withDraft}`);
  sendKeys("M-t");
  const drilling = waitForPane((pane) => pane.includes("drill · row 1 of 2"));
  if (!drilling.includes("drill · row 1 of 2")) throw new Error(`hint bar did not appear\n${drilling}`);
  if (drilling.includes(draft)) throw new Error(`draft still visible while the hint bar owns the editor slot\n${drilling}`);
  const numberedRows = traceRowsOf(drilling).map((line) => line.trimEnd());
  if (numberedRows.length !== 2) throw new Error(`numbering changed the row count\n${drilling}`);
  for (const [i, row] of numberedRows.entries()) {
    if (row.slice(6) !== beforeRows[i].slice(6)) {
      throw new Error(`numbering reflowed a row body\nbefore: ${beforeRows[i]}\nafter:  ${row}`);
    }
  }
  if (!/^\s*2 › /.test(numberedRows[0]) || !/^\s*1 › /.test(numberedRows[1])) {
    throw new Error(`gutter numbers wrong (1 must be the most recent row)\n${numberedRows.join("\n")}`);
  }

  // 4. Digit commit opens the pager on the older row's complete result.
  sendKeys("2");
  const peeking = waitForPane((pane) => pane.includes("peek · row 2 of 2"));
  if (!peeking.includes("peek · row 2 of 2")) throw new Error(`pager did not open on row 2\n${peeking}`);
  if (!peeking.includes("DRILL_RESULT_ALPHA")) throw new Error(`pager missing the full result text\n${peeking}`);
  if (!peeking.includes("invocation")) throw new Error(`pager missing the invocation section\n${peeking}`);

  // 5. esc unwinds: pager → numbered transcript → editor with the draft intact.
  sendKeys("Escape");
  const backToDrill = waitForPane((pane) => pane.includes("drill · row") && !pane.includes("peek · row"));
  if (!backToDrill.includes("drill · row")) throw new Error(`esc did not return to drill mode\n${backToDrill}`);
  sendKeys("Escape");
  const restored = waitForPane((pane) => pane.includes(draft) && !pane.includes("drill · row"));
  if (!restored.includes(draft)) throw new Error(`editor draft not restored after exit\n${restored}`);
  const restoredRows = traceRowsOf(restored).map((line) => line.trimEnd());
  if (restoredRows.join("\n") !== beforeRows.join("\n")) {
    throw new Error(`exit did not restore the plain rail rows\n${restoredRows.join("\n")}`);
  }

  // 6. A foreign chord (§9.13): alt+up exits the mode un-consumed and lands in the
  // restored editor in the same press — stock pi answers with its native dequeue status.
  sendKeys("M-t");
  const redrilling = waitForPane((pane) => pane.includes("drill · row 1 of 2"));
  if (!redrilling.includes("drill · row 1 of 2")) throw new Error(`hint bar did not reappear for the chord step\n${redrilling}`);
  sendKeys("M-Up");
  const chordExit = waitForPane(
    (pane) => !pane.includes("drill · row") && pane.includes("No queued messages to restore"),
  );
  if (chordExit.includes("drill · row")) throw new Error(`alt+up did not exit drill mode\n${chordExit}`);
  if (!chordExit.includes("No queued messages to restore")) {
    throw new Error(`alt+up did not reach the restored editor in the same press\n${chordExit}`);
  }
  if (!chordExit.includes(draft)) throw new Error(`editor draft lost across the chord exit\n${chordExit}`);

  sendKeys("C-c");
  sendKeys("/quit", "Enter");
  const exitDeadline = Math.min(hardDeadline, Date.now() + 5_000);
  while (Date.now() < exitDeadline && hasTmuxSession()) sleep(100);
  if (hasTmuxSession()) throw new Error("drill smoke rendered but Pi did not respond to /quit");

  console.log("real-Pi drill-mode smoke passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanupLaunchedPi();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
}
