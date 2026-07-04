#!/usr/bin/env node
// README screenshot rig. Launches the installed pi in tmux with an isolated HOME (so
// only this repo's extensions load — no personal extensions, no session-hud), replays
// or drives a session, captures the pane with colors, and renders PNGs via
// ansi2html.mjs + html2png.py. See tests/smoke/startup-smoke.mjs for the recipe this
// borrows (trust pre-seeding, per-fixture settings).
//
// Usage:
//   node scripts/dev/screenshots/rig.mjs traceline
//   node scripts/dev/screenshots/rig.mjs contextimate
//   node scripts/dev/screenshots/rig.mjs cachemire   # LIVE: real model calls (cents)
//
// Captures land in docs/img/. Pass --keep to leave the tmux session running.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTracelineSession } from "./traceline-session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const imgDir = join(repoRoot, "docs", "img");
const scenario = process.argv[2];
const keep = process.argv.includes("--keep");
const session = `pog-shots-${process.pid}`;

const run = (args, opts = {}) => spawnSync(args[0], args.slice(1), { encoding: "utf8", ...opts });

// Private tmux server: extended-keys on (silences pi's tmux warning) without touching
// the user's tmux config or server.
const tmuxConf = join(tmpdir(), "pog-shots-tmux.conf");
writeFileSync(tmuxConf, 'set -g extended-keys on\nset -g default-terminal "tmux-256color"\nset -as terminal-features ",*:RGB"\n');
const tmux = (...args) => run(["tmux", "-L", "pogshots", "-f", tmuxConf, ...args]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function capturePane() {
  return tmux("capture-pane", "-p", "-e", "-t", session, "-S", "-500").stdout ?? "";
}
function captureText() {
  return tmux("capture-pane", "-p", "-t", session, "-S", "-500").stdout ?? "";
}
function waitFor(label, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(captureText())) return true;
    sleep(500);
  }
  throw new Error(`${label}: not ready within ${timeoutMs}ms`);
}
const send = (...keys) => tmux("send-keys", "-t", session, ...keys);

function makeFixture({ extensions, withAuth = false }) {
  // The fixture project lives *inside* the fixture HOME so every path pi renders
  // tildifies like a normal machine (~/projects/site) instead of leaking temp dirs.
  // realpath: /var/folders is a symlink to /private/var — pi realpaths file labels,
  // so HOME must be the resolved path or tildify misses and temp paths leak into shots.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pog-shots-home-")));
  const cwd = join(home, "projects", "site");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const trusted = {};
  for (const path of [cwd, repoRoot]) {
    trusted[path] = true;
    trusted[realpathSync(path)] = true;
  }
  writeFileSync(join(home, ".pi", "agent", "trust.json"), JSON.stringify(trusted, null, 2));
  if (withAuth) copyFileSync(join(homedir(), ".pi", "agent", "auth.json"), join(home, ".pi", "agent", "auth.json"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ extensions: extensions.map((name) => join(repoRoot, "extensions", name, "index.ts")) }, null, 2),
  );
  return { home, cwd };
}

function launchPi({ home, cwd, args = "", cols = 120, rows = 45 }) {
  const launch = tmux(
    "new-session", "-d", "-s", session, "-x", String(cols), "-y", String(rows),
    `cd ${JSON.stringify(cwd)} && HOME=${JSON.stringify(home)} COLORTERM=truecolor pi ${args}`,
  );
  if (launch.status !== 0) throw new Error(`tmux launch failed: ${launch.stderr}`);
}

function shoot(name, { trimTo, cutFrom, cols = 120 } = {}) {
  let ansi = capturePane().replace(/\s+$/, "");
  const strip = (l) => l.replace(/\x1b\[[0-9;:]*m/g, "");
  {
    // Startup housekeeping notices and view-toggle status echoes are not what the
    // screenshot demonstrates: drop the subscription-auth warning block (wrapped,
    // two lines) and single-line status notices wherever they sit.
    const lines = ansi.split("\n");
    const kept = [];
    let skipping = false;
    for (const line of lines) {
      const text = strip(line);
      if (/^\s*Warning: /.test(text)) { skipping = true; continue; }
      if (skipping && text.trim() !== "") continue;
      skipping = false;
      if (/^\s*Thinking blocks: (hidden|visible)\s*$/.test(text)) continue;
      if (/^\s*\[Contextimate\] view: (summary|compact|expanded)\s*$/.test(text)) continue;
      kept.push(line);
    }
    ansi = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  {
    // Hide the footer buckets (cwd · usage · model) below the input box: cut at the
    // editor's bottom border, keeping the box itself.
    const lines = ansi.split("\n");
    let lastBorder = -1;
    for (let i = 0; i < lines.length; i++) {
      const text = strip(lines[i]).trim();
      if (text.length >= 40 && /^[─━═╌╍╭╮╰╯│┄┈|_]+$/.test(text)) lastBorder = i;
    }
    if (lastBorder > 0) ansi = lines.slice(0, lastBorder + 1).join("\n");
  }
  if (trimTo) {
    const lines = ansi.split("\n");
    const start = lines.findIndex((l) => l.replace(/\x1b\[[0-9;:]*m/g, "").includes(trimTo));
    if (start > 0) ansi = lines.slice(start).join("\n");
  }
  if (cutFrom) {
    // Excerpt mode: cut the tail and leave a dim ⋮ so the slice reads as intentional.
    const lines = ansi.split("\n");
    const end = lines.findIndex((l) => l.replace(/\x1b\[[0-9;:]*m/g, "").includes(cutFrom));
    if (end > 0) ansi = lines.slice(0, end).join("\n").replace(/\s+$/, "") + "\n\n  \x1b[2m⋮\x1b[0m";
  }
  const base = join(tmpdir(), `${session}-${name}`);
  writeFileSync(`${base}.txt`, ansi);
  mkdirSync(imgDir, { recursive: true });
  let r = run(["node", join(here, "ansi2html.mjs"), `${base}.txt`, "--title", "pi", "--out", `${base}.html`, "--cols", String(cols)]);
  if (r.status !== 0) throw new Error(`ansi2html failed: ${r.stderr}`);
  r = run(["python3", join(here, "html2png.py"), `${base}.html`, join(imgDir, `${name}.png`), "--width", "2100", "--height", "3200"]);
  if (r.status !== 0) throw new Error(`html2png failed: ${r.stderr}`);
  console.log(`shot docs/img/${name}.png (ansi: ${base}.txt)`);
}

function writeSession(dir, cwd, build) {
  const { id, entries } = build(cwd);
  const header = { type: "session", version: 3, id, timestamp: entries[0]?.timestamp, cwd };
  const rest = entries.filter((e) => e.type !== "session");
  // Re-chain: first entry hangs off nothing.
  if (rest.length) rest[0].parentId = null;
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
  writeFileSync(file, [header, ...rest].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

function cleanup(fixture) {
  if (keep) {
    console.log(`kept tmux session ${session} and fixture ${fixture.cwd}`);
    return;
  }
  send("/exit", "Enter");
  sleep(800);
  tmux("kill-session", "-t", session);
  rmSync(fixture.home, { recursive: true, force: true });
}

// --- scenarios --------------------------------------------------------------------

function tracelineShot() {
  const fixture = makeFixture({ extensions: ["pi-traceline"], withAuth: true });
  const sessionFile = writeSession(fixture.home, fixture.cwd, buildTracelineSession);
  launchPi({ ...fixture, args: `--session ${JSON.stringify(sessionFile)}`, rows: 60 });
  try {
    waitFor("transcript", (t) => t.includes("the pass is on main"), 90000);
    sleep(2500);
    // Restored sessions open with thinking visible; traceline's one-line mode applies
    // while reasoning is hidden (its live default). One Ctrl+T restores that state.
    // §9.11 suppresses the "Thinking blocks: hidden" caption, so wait for the visible
    // effect instead: only hidden mode renders traceline's labelled "Thinking: …"
    // preview line (visible mode prints the raw reasoning text, unlabelled).
    send("C-t");
    waitFor("one-line mode", (t) => /^\s*Thinking: /m.test(t), 15000);
    sleep(1500);
    shoot("pi-traceline-collapsed", { trimTo: "The pricing section on /product" });
  } finally {
    cleanup(fixture);
  }
}

function contextimateShot() {
  const fixture = makeFixture({ extensions: ["pi-contextimate"], withAuth: true });
  // A little real project material so the panel has something to account for.
  writeFileSync(join(fixture.cwd, "AGENTS.md"), `# site\n${"Astro site for the product pages. Copy style: say it once, land it. ".repeat(40)}\n`);
  mkdirSync(join(fixture.cwd, ".pi", "skills", "release-notes"), { recursive: true });
  writeFileSync(
    join(fixture.cwd, ".pi", "skills", "release-notes", "SKILL.md"),
    "---\nname: release-notes\ndescription: Draft release notes from the merged PRs since the last tag, in the site voice.\n---\n# release-notes\n",
  );
  launchPi({ ...fixture, args: "--no-session", rows: 50 });
  try {
    waitFor("panel", (t) => t.includes("[Contextimate]"), 90000);
    sleep(2000);
    shoot("pi-contextimate-summary", { trimTo: "[Contextimate]" });
    send("/contextimate compact", "Enter");
    waitFor("compact", (t) => t.includes("(inactive)"));
    sleep(1500);
    shoot("pi-contextimate-compact", { trimTo: "[Contextimate]" });
    send("/contextimate expanded", "Enter");
    waitFor("expanded", (t) => t.includes("readable view"));
    sleep(1500);
    // Excerpt: the full schema-tree dump is a wall; one tool tree gives the sense.
    shoot("pi-contextimate-expanded", { trimTo: "[Contextimate]", cutFrom: "read · builtin" });
  } finally {
    cleanup(fixture);
  }
}

function cachemireShot() {
  const fixture = makeFixture({ extensions: ["pi-traceline", "pi-cachemire"], withAuth: true });
  writeFileSync(join(fixture.cwd, "README.md"), "# lantern\n\nA tiny CLI that turns build logs into one-line verdicts.\n\n## License\nMIT.\n");
  // Low materiality thresholds: the fixture session is tiny, and the point of the
  // shot is the break notice, so let a small-but-real break clear the bar.
  writeFileSync(
    join(fixture.cwd, ".pi", "pi-cachemire.json"),
    JSON.stringify({ turnSummaryMinCalls: 1, missWarnUsd: 0.001, missWarnTokens: 250 }),
  );
  launchPi({ ...fixture, args: "--model openai-codex/gpt-5.5", rows: 45 });
  try {
    waitFor("editor", (t) => t.includes("gpt-5.5"), 90000);
    sleep(1500);
    send("Read README.md and tell me, in one line, what this project is.");
    sleep(300);
    send("Enter");
    waitFor("turn 1", (t) => /turn: .*calls/.test(t), 120000);
    sleep(2000);
    send("And what license is it under?");
    sleep(300);
    send("Enter");
    waitFor("turn 2", (t) => (t.match(/turn: /g) ?? []).length >= 2, 120000);
    sleep(2000);
    // Cycle the thinking level (shift+tab): reasoning effort participates in the
    // codex backend's cache key (live-verified, see docs/pi-cachemire.md), so the
    // next send should produce a real break with a *named* cause — the interesting
    // shot. Best-effort cache: if the break doesn't materialize, re-run the rig.
    send("BTab");
    sleep(1000);
    send("Summarize the README in exactly five words.");
    sleep(300);
    send("Enter");
    waitFor("turn 3", (t) => (t.match(/turn: /g) ?? []).length >= 3, 120000);
    sleep(2000);
    if (!/cache (broke|partial)/.test(captureText())) {
      console.warn("WARNING: no cache break materialized (best-effort cache) — shots will be boring; re-run");
    }
    // Hide thinking so tool rows render as traceline one-liners, consistent with the
    // other README shots.
    send("C-t");
    sleep(1500);
    shoot("pi-cachemire-clock", { trimTo: "Read README.md" });
    send("/cache", "Enter");
    waitFor("ledger", (t) => t.includes("cache & loop ledger"));
    sleep(1000);
    shoot("pi-cachemire-ledger", { trimTo: "[Cachemire]" });
  } finally {
    cleanup(fixture);
  }
}

const scenarios = { traceline: tracelineShot, contextimate: contextimateShot, cachemire: cachemireShot };
if (!scenarios[scenario]) {
  console.error(`usage: rig.mjs <${Object.keys(scenarios).join("|")}> [--keep]`);
  process.exit(2);
}
scenarios[scenario]();
