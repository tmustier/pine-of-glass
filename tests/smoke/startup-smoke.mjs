#!/usr/bin/env node
// Layer 4: startup smoke (docs/testing.md). Launches the *installed* pi in tmux with this
// repo's extensions loaded from a clean fixture cwd, then asserts on captured panes:
//   1. the [Context Estimator] block renders at startup (no model call needed),
//   2. /contextimate compact and expanded actually switch the rendered mode line,
//   3. /reload leaves exactly one estimator block,
//   4. traceline announces itself (extension loaded without crashing the TUI).
// Local-only: needs tmux + an installed pi on PATH. Exits non-zero on any failure.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const session = `pog-smoke-${process.pid}`;
const failures = [];

function run(args, opts = {}) {
  return spawnSync(args[0], args.slice(1), { encoding: "utf8", ...opts });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function capture(options = {}) {
  // Scrollback included by default; pass visibleOnly for counts that must not see
  // earlier renders of the same block pushed into history.
  const args = options.visibleOnly
    ? ["tmux", "capture-pane", "-p", "-t", session]
    : ["tmux", "capture-pane", "-p", "-t", session, "-S", "-2000"];
  return run(args).stdout ?? "";
}

function waitFor(label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let pane = "";
  while (Date.now() < deadline) {
    pane = capture();
    if (predicate(pane)) return pane;
    sleep(500);
  }
  failures.push(`${label}: condition not met within ${timeoutMs}ms`);
  return pane;
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL ${label}`);
  }
}

// Preflight.
if (run(["tmux", "-V"]).status !== 0) {
  console.error("tmux not available — smoke test requires a local tmux");
  process.exit(2);
}
if (run(["pi", "--version"]).status !== 0) {
  console.error("pi not on PATH — smoke test requires an installed pi");
  process.exit(2);
}

// Isolated HOME: pi resolves its agent dir under os.homedir(), so a fresh HOME guarantees
// none of the user's own extensions/packages load — the only candidates for the estimator
// block are this repo's copies, wired in via the project settings below. This also
// exercises the no-model startup path (no auth in the fresh HOME).
const fixtureHome = mkdtempSync(join(tmpdir(), "pog-smoke-home-"));
mkdirSync(join(fixtureHome, ".pi", "agent"), { recursive: true });

// Fixture cwd: minimal AGENTS.md so a context row exists; settings load this repo's
// extensions explicitly so we exercise the same entry points the published package maps.
const fixtureDir = mkdtempSync(join(tmpdir(), "pog-smoke-"));

// Pre-trust the fixture cwd (and repo root) in the fresh HOME, or pi blocks on its
// "Trust project folder?" dialog before loading .pi settings. macOS temp dirs are
// symlinked under /private, so trust both raw and resolved paths.
const trusted = {};
for (const path of [fixtureDir, repoRoot]) {
  trusted[path] = true;
  trusted[realpathSync(path)] = true;
}
writeFileSync(join(fixtureHome, ".pi", "agent", "trust.json"), JSON.stringify(trusted, null, 2));
writeFileSync(join(fixtureDir, "AGENTS.md"), "# Smoke fixture\nMinimal project context for the startup smoke test.\n");
mkdirSync(join(fixtureDir, ".pi"), { recursive: true });
writeFileSync(
  join(fixtureDir, ".pi", "settings.json"),
  JSON.stringify(
    {
      extensions: [
        join(repoRoot, "extensions", "pi-contextimate", "index.ts"),
        join(repoRoot, "extensions", "pi-traceline", "index.ts"),
        join(repoRoot, "extensions", "pi-cachemire", "index.ts"),
      ],
    },
    null,
    2,
  ),
);

let pane = "";
try {
  const launch = run([
    "tmux", "new-session", "-d", "-s", session, "-x", "120", "-y", "45",
    `cd ${JSON.stringify(fixtureDir)} && HOME=${JSON.stringify(fixtureHome)} pi --no-session`,
  ]);
  if (launch.status !== 0) {
    console.error(`tmux session failed to start: ${launch.stderr}`);
    process.exit(2);
  }

  // 1. Estimator block renders at startup, in summary mode by default. First render can
  // be slow: the fresh HOME means a cold jiti cache for both TS extensions.
  pane = waitFor("startup render", (text) => text.includes("[Context Estimator]"), 60000);
  check("estimator block present at startup", pane.includes("[Context Estimator]"));
  // The header always shows the full cycle legend; mode-specific markers are the
  // reliable tell. Summary mode renders neither the compact ▸ section glyph nor the
  // expanded tools-tree note.
  check("summary mode is the startup default", !/▸ |readable view/.test(pane));
  check("harness total row rendered", pane.includes("Total harness"));
  check("no extension error surfaced", !/Error loading extension|extension error/i.test(pane));

  // Expand the startup resource listing and prove both repo extensions are the loaded ones.
  run(["tmux", "send-keys", "-t", session, "C-o"]);
  pane = waitFor("startup resources", (text) => /pi-traceline/.test(text));
  check("repo contextimate extension loaded", pane.includes("pi-contextimate"));
  check("repo traceline extension loaded", pane.includes("pi-traceline"));

  // 2. Mode switching via the slash command actually changes the rendered block.
  run(["tmux", "send-keys", "-t", session, "/contextimate compact", "Enter"]);
  pane = waitFor("compact mode", (text) => /▸ Runtime system prompt/.test(text));
  check("compact mode renders the scan view", /▸ Runtime system prompt/.test(pane));

  run(["tmux", "send-keys", "-t", session, "/contextimate expanded", "Enter"]);
  pane = waitFor("expanded mode", (text) => /readable view/.test(text));
  check("expanded mode renders the detail view", /readable view/.test(pane));

  // 3. /reload keeps exactly one estimator block (regression: duplicate insertion).
  // Back to summary first so the block fits the viewport, and count on the visible
  // screen only — scrollback legitimately retains pre-reload renders.
  run(["tmux", "send-keys", "-t", session, "/contextimate summary", "Enter"]);
  sleep(1000);
  run(["tmux", "send-keys", "-t", session, "/reload", "Enter"]);
  waitFor("post-reload render", (text) => text.includes("[Context Estimator]"), 60000);
  sleep(2000); // settle: reload re-renders the startup listing
  pane = capture({ visibleOnly: true });
  const blocks = (pane.match(/\[Context Estimator\]/g) ?? []).length;
  check("exactly one estimator block after /reload", blocks === 1, `found ${blocks}`);

  // 4. Cachemire chat lines persist across pi's chat rebuild (Ctrl+T toggles reasoning
  // visibility by clearing + rebuilding the chat container from session messages, which
  // drops raw appended children). /cache appends a ledger line; it must still be on
  // screen after the rebuild. Visible-only: scrollback retains pre-toggle frames.
  run(["tmux", "send-keys", "-t", session, "/cache", "Enter"]);
  waitFor("cachemire ledger renders", (text) => text.includes("cache & loop ledger"));
  run(["tmux", "send-keys", "-t", session, "C-t"]);
  pane = waitFor("thinking toggle status", (text) => /Thinking blocks: (hidden|visible)/.test(capture({ visibleOnly: true })));
  pane = capture({ visibleOnly: true });
  check("cachemire ledger survives the Ctrl+T chat rebuild", pane.includes("cache & loop ledger"));
} finally {
  run(["tmux", "send-keys", "-t", session, "/exit", "Enter"]);
  sleep(1000);
  run(["tmux", "kill-session", "-t", session]);
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(fixtureHome, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  const paneDump = join(tmpdir(), `${session}-pane.txt`);
  writeFileSync(paneDump, pane);
  console.error(`last captured pane: ${paneDump}`);
  process.exit(1);
}
console.log("\nstartup smoke passed");
