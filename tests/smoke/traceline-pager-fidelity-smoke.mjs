#!/usr/bin/env node
// Resume a real Pi session holding the fidelity gaps the peek pager closes (design
// language §9.13): a custom tool with no call renderer (papercut-shaped), a read whose
// result is an image block, and a code read. Prove end to end that Alt+T → digit shows
// the complete arguments (the note text a bare tool name would hide), the image fact
// line, and the code grammar (offset-numbered gutter plus real syntax ink), and that
// the image read's trace row wears the `png W×H` what-fact (§9.7).
// tmux reports no image capability, so the pixel path stays unit/contract-tested;
// this smoke pins the always-on text tier against the real Pi component stack.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(repoRoot, "extensions", "pi-traceline", "index.ts");
const tmuxSession = `pog-pager-${process.pid}`;
const readySentinel = "PAGER_SMOKE_READY";
const noteText = "Renaming a session mid-run drops the sidebar selection.";
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

function capturePane(...extra) {
  return run(["tmux", "capture-pane", "-p", ...extra, "-t", tmuxSession, "-S", "-500"], { timeoutMs: 2_000 }).stdout ?? "";
}

function sendKeys(...keys) {
  return run(["tmux", "send-keys", "-t", tmuxSession, ...keys], { timeoutMs: 2_000 });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForPane(predicate) {
  let pane = "";
  while (Date.now() < hardDeadline && hasTmuxSession()) {
    pane = capturePane();
    if (predicate(pane)) return pane;
    sleep(200);
  }
  return pane;
}

// A syntactically valid PNG header claiming 1044×646; Pi renders dimensions from the
// header and treats the payload as opaque, so padding bytes suffice for the fixture.
function pngBase64(widthPx, heightPx) {
  const buffer = Buffer.alloc(96);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(widthPx, 16);
  buffer.writeUInt32BE(heightPx, 20);
  return buffer.toString("base64");
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
      message: { role: "user", content: [{ type: "text", text: "Resume the pager fidelity fixture." }], timestamp },
    },
    // Order matters: the papercut call sits between the two reads so consecutive
    // sibling reads do not fold into one run row (§9.9); each fidelity case keeps its
    // own numbered trace row. Newest first: 1 image read, 2 papercut, 3 code read.
    {
      type: "message",
      id: "00000003",
      parentId: "00000002",
      timestamp: iso,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-code", name: "read", arguments: { path: join(cwd, "answer.ts"), offset: 7 } }],
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
        toolCallId: "call-code",
        toolName: "read",
        content: [{ type: "text", text: 'const answer = 42;\nexport function speak() {\n  return "lynx";\n}' }],
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
        content: [
          {
            type: "toolCall",
            id: "call-papercut",
            name: "papercut",
            arguments: { note: noteText, context: "pine-of-glass", surface: "alt+t" },
          },
        ],
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
        toolCallId: "call-papercut",
        toolName: "papercut",
        content: [{ type: "text", text: "Recorded locally" }],
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
        content: [{ type: "toolCall", id: "call-image", name: "read", arguments: { path: join(cwd, "shot.png") } }],
        ...assistantShell,
        stopReason: "toolUse",
        timestamp: timestamp + 5,
      },
    },
    {
      type: "message",
      id: "00000008",
      parentId: "00000007",
      timestamp: iso,
      message: {
        role: "toolResult",
        toolCallId: "call-image",
        toolName: "read",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: pngBase64(1044, 646), mimeType: "image/png" },
        ],
        isError: false,
        timestamp: timestamp + 6,
      },
    },
    {
      type: "message",
      id: "00000009",
      parentId: "00000008",
      timestamp: iso,
      message: {
        role: "assistant",
        content: [{ type: "text", text: readySentinel }],
        ...assistantShell,
        stopReason: "stop",
        timestamp: timestamp + 7,
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
  console.error("tmux not available: real-Pi pager fidelity smoke requires tmux");
  process.exit(2);
}
if (run(["pi", "--version"]).status !== 0) {
  console.error("pi not on PATH: real-Pi pager fidelity smoke requires an installed Pi");
  process.exit(2);
}

fixtureHome = mkdtempSync(join(tmpdir(), "pog-pager-home-"));
fixtureDir = mkdtempSync(join(tmpdir(), `${tmuxSession}-`));
const agentDir = join(fixtureHome, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hideThinkingBlock: true }, null, 2));
writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [fixtureDir]: true, [repoRoot]: true }, null, 2));
writeFileSync(join(fixtureDir, "AGENTS.md"), "# Pager fidelity smoke\nFixture only.\n");
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

  // 1. Resume renders both rows; the image read wears the §9.7 what-fact in the trace.
  const resumed = waitForPane((pane) => pane.includes(readySentinel) && pane.includes("shot.png"));
  if (!resumed.includes(readySentinel)) throw new Error(`resumed session did not render\n${resumed}`);
  if (!resumed.includes("png 1044×646")) throw new Error(`image read trace row missing the png W×H fact\n${resumed}`);

  // 2. Alt+T, then the papercut row: the pager shows the complete arguments.
  sendKeys("M-t");
  const drilling = waitForPane((pane) => pane.includes("drill · row 1 of 3"));
  if (!drilling.includes("drill · row 1 of 3")) throw new Error(`hint bar did not appear\n${drilling}`);
  sendKeys("2");
  const papercutPeek = waitForPane((pane) => pane.includes("peek · row 2 of 3"));
  if (!papercutPeek.includes(noteText)) throw new Error(`pager hides the papercut note (bare tool name?)\n${papercutPeek}`);
  if (!papercutPeek.includes("pine-of-glass")) throw new Error(`pager missing the context argument\n${papercutPeek}`);

  // 3. Digit 1 switches to the image read: the fact line accounts for the image block.
  sendKeys("1");
  const imagePeek = waitForPane((pane) => pane.includes("peek · row 1 of 3"));
  if (!imagePeek.includes("image · png · 1044×646")) throw new Error(`pager missing the image fact line\n${imagePeek}`);

  // 4. Digit 3: the code read renders as code, gutter counting from the offset, with
  // real syntax ink (capture with escapes: the code line must carry SGR beyond the
  // dim gutter, proving pi's highlighter ran through the live theme).
  sendKeys("3");
  const codePeek = waitForPane((pane) => pane.includes("peek · row 3 of 3"));
  if (!/result · success · [\d.]+k? ?ch · typescript/.test(codePeek)) {
    throw new Error(`result label missing the language cell\n${codePeek}`);
  }
  if (!/7 {2}const answer = 42;/.test(codePeek)) throw new Error(`code gutter missing or misnumbered\n${codePeek}`);
  if (!/8 {2}export function speak/.test(codePeek)) throw new Error(`gutter did not count on\n${codePeek}`);
  const inkPane = capturePane("-e");
  const codeLine = inkPane
    .split("\n")
    .find((line) => line.replaceAll(/\x1b\[[0-9;]*m/g, "").includes("const answer"));
  const sgrCount = (codeLine?.match(/\x1b\[[0-9;]*m/g) ?? []).length;
  if (sgrCount < 3) throw new Error(`code line lacks syntax ink (${sgrCount} SGR runs)\n${codeLine}`);

  sendKeys("Escape");
  sendKeys("Escape");
  sendKeys("C-c");
  sendKeys("/quit", "Enter");
  const exitDeadline = Math.min(hardDeadline, Date.now() + 5_000);
  while (Date.now() < exitDeadline && hasTmuxSession()) sleep(100);
  if (hasTmuxSession()) throw new Error("pager fidelity smoke rendered but Pi did not respond to /quit");

  console.log("real-Pi pager fidelity smoke passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanupLaunchedPi();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
}
