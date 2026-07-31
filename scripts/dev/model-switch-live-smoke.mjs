#!/usr/bin/env node
// Live adversarial smoke + screen recording for the model-switch feature (#57/#58).
//
// Drives the *installed* pi in tmux with an isolated HOME (only this repo's
// contextimate + cachemire load, plus the anthropic-oauth-fix), makes REAL model
// calls (costs tens of cents), and pressure-tests the switch flow:
//
//   1. two real turns on openai-codex/gpt-5.6-sol (subscription) build a warm cache
//   2. /model anthropic/claude-fable-5 — the clock must flip to a target-currency
//      est forecast BEFORE anything is sent (#57)
//   3. contextimate must name the pre-switch currency and withhold share/bar (#58)
//   4. adversarial: fable's first response is ABORTED mid-stream — pi's exact count
//      stays anchored on sol, so the panel must hold its pre-switch naming; the
//      clock may honestly re-baseline if the aborted call was billed (anthropic
//      writes the cache while reading the prompt)
//   5. a completed fable call re-baselines everything: contract countdown, share/bar
//   6. A→B→A: switching back to sol inside its band window must say "may still be
//      warm", not overclaim cold
//   7. /cache — the ledger attributes the fable miss to the model switch
//
// Every visible frame is captured throughout and rendered to an mp4 via the
// screenshot rig's ANSI→HTML→PNG pipeline, so the run doubles as a UX review video.
//
// Usage: node scripts/dev/model-switch-live-smoke.mjs [--keep] [--video-only <framesDir>]
// Local-only: needs tmux, pi on PATH, Chrome, python3+PIL, ffmpeg, real auth.json.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync, copyFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const session = "pog-live";
const outDir = join(repoRoot, "artifacts", "model-switch-live");
const framesDir = join(outDir, "frames");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OAUTH_FIX = join(homedir(), ".pi/agent/git/github.com/tmustier/pi-oauth/extensions/anthropic-oauth-fix.ts");

const run = (args, opts = {}) => spawnSync(args[0], args.slice(1), { encoding: "utf8", ...opts });
const tmuxConf = join(tmpdir(), "pog-live-tmux.conf");
writeFileSync(tmuxConf, 'set -g extended-keys on\nset -g default-terminal "tmux-256color"\nset -as terminal-features ",*:RGB"\nset -g history-limit 20000\n');
const tmux = (...args) => run(["tmux", "-L", "poglive", "-f", tmuxConf, ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;:]*m/g, "");

const captureVisible = () => tmux("capture-pane", "-p", "-e", "-t", session).stdout ?? "";
const captureText = (scrollback = false) =>
  strip((scrollback ? tmux("capture-pane", "-p", "-t", session, "-S", "-15000") : tmux("capture-pane", "-p", "-t", session)).stdout ?? "");
const sendText = (text) => { tmux("send-keys", "-t", session, "-l", text); tmux("send-keys", "-t", session, "Enter"); };
const sendKey = (key) => tmux("send-keys", "-t", session, key);
// Slash commands with argument completions (e.g. /model) pop an autocomplete menu that
// eats the first Enter (it inserts the completion). Retry until the editor clears.
async function sendCommand(text) {
  tmux("send-keys", "-t", session, "-l", text);
  await sleep(450);
  for (let i = 0; i < 4; i++) {
    tmux("send-keys", "-t", session, "Enter");
    await sleep(500);
    const tail = captureText().split("\n").slice(-6).join("\n");
    if (!tail.includes(text.slice(1, 28))) return;
  }
}

// --- checks --------------------------------------------------------------------------
const results = [];
function check(label, cond, detail) {
  results.push({ label, cond: Boolean(cond) });
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

async function waitFor(label, predicate, { timeoutMs = 120000, scrollback = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = captureText(scrollback);
    if (predicate(text)) return text;
    await sleep(400);
  }
  check(`${label} (wait)`, false, `not seen within ${timeoutMs}ms`);
  throw new Error(`${label}: not seen within ${timeoutMs}ms`);
}

// --- recorder ------------------------------------------------------------------------
let phase = "";
const frames = [];
let lastFrame = "";
let recorder;
function startRecorder() {
  recorder = setInterval(() => {
    const ansi = captureVisible();
    if (!ansi || ansi === lastFrame) return;
    lastFrame = ansi;
    const file = join(framesDir, `f${String(frames.length).padStart(4, "0")}.txt`);
    writeFileSync(file, ansi);
    frames.push({ file, ts: Date.now(), phase });
  }, 340);
}
function addCard(lines, holdMs, label = "") {
  const file = join(framesDir, `f${String(frames.length).padStart(4, "0")}.txt`);
  const body = lines.join("\n");
  const pad = Math.max(0, 45 - lines.length);
  writeFileSync(file, body + "\n".repeat(pad));
  const ts = frames.length ? frames[frames.length - 1].ts + holdMs : Date.now();
  frames.push({ file, ts, phase: label, hold: holdMs });
}

// --- fixture -------------------------------------------------------------------------
function dataset() {
  // ~48KB of varied, realistic ops-log markdown: big enough that the fable-currency
  // forecast (~chars/2.6 + harness) clears the 20k-token break-notice threshold.
  const services = ["ingest", "billing", "search", "notify", "auth", "exports"];
  const events = ["deploy", "rollback", "latency spike", "queue backlog", "cache flush", "schema migration", "failover drill"];
  const lines = ["# meridian incident & change log (Q2)", ""];
  for (let i = 0; i < 340; i++) {
    const s = services[i % services.length];
    const e = events[(i * 7) % events.length];
    lines.push(
      `- 2026-0${(i % 3) + 4}-${String((i % 27) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:${String((i * 13) % 60).padStart(2, "0")}Z ` +
      `[${s}] ${e}: window ${(i * 37) % 900}s, p95 ${(i * 91) % 4000}ms, err ${(i % 17) / 10}%. ` +
      `Action: ${i % 2 ? "auto-remediated by runbook RB-" + ((i * 3) % 40) : "escalated to on-call, ticket MER-" + (1000 + i)}. ` +
      `Notes: replay lag ${((i * 53) % 300)}s cleared after ${((i * 29) % 45)}m; follow-up ${i % 3 ? "none" : "scheduled"}.`,
    );
  }
  return lines.join("\n") + "\n";
}

function makeFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pog-live-home-")));
  const cwd = join(home, "projects", "meridian");
  mkdirSync(join(cwd, "notes"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const trusted = {};
  for (const path of [cwd, repoRoot]) { trusted[path] = true; trusted[realpathSync(path)] = true; }
  writeFileSync(join(home, ".pi", "agent", "trust.json"), JSON.stringify(trusted, null, 2));
  copyFileSync(join(homedir(), ".pi", "agent", "auth.json"), join(home, ".pi", "agent", "auth.json"));
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
    lastChangelogVersion: "9.99.0",
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-sol",
    defaultThinkingLevel: "low",
    hideThinkingBlock: true,
    enabledModels: ["openai-codex/gpt-5.6-sol", "anthropic/claude-fable-5"],
    enableInstallTelemetry: false,
    enableAnalytics: false,
  }, null, 2));
  writeFileSync(join(cwd, "AGENTS.md"), "# meridian\nInternal ops dashboard for the Meridian reliability team.\nKeep answers short; this fixture exists to exercise pi extensions.\n");
  writeFileSync(join(cwd, "README.md"), "# meridian\nOps dashboard fixture project for the pine-of-glass live smoke.\n");
  writeFileSync(join(cwd, "notes", "dataset.md"), dataset());
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
    extensions: [
      join(repoRoot, "extensions", "pi-contextimate", "index.ts"),
      join(repoRoot, "extensions", "pi-cachemire", "index.ts"),
      ...(existsSync(OAUTH_FIX) ? [OAUTH_FIX] : []),
    ],
  }, null, 2));
  return { home, cwd };
}

// --- panel inspection (contextimate is chat-anchored: /contextimate expanded rebuilds
// the panel with current state; the freshest render is the last one in scrollback) ----
async function inspectPanel(what) {
  await sendCommand("/contextimate expanded");
  await sleep(2200); // let the panel render (and hold for the video)
  const rows = captureText(true).split("\n").filter((l) => l.includes("Total request"));
  const row = rows[rows.length - 1] ?? "";
  console.log(`     panel[${what}]: ${row.trim()}`);
  return row;
}

const widgetLine = (text) => text.split("\n").reverse().find((l) => l.includes("\u25cd cache")) ?? "";
const turnCount = () => (captureText(true).match(/\u25cd turn:/g) ?? []).length;

// Submit a prompt and wait for the *turn* to finish (cachemire's ◍ turn: line renders
// at turn end). Waiting on the first widget update races multi-call turns: a prompt
// sent mid-turn queues as a steering message and derails the scenario.
async function sendPromptAndWait(text, label, timeoutMs = 240000) {
  const before = turnCount();
  sendText(text);
  await waitFor(label, (t) => turnCount() > before && !t.includes("Working..."), { timeoutMs });
  await sleep(1200);
}

// --- the scenario ----------------------------------------------------------------------
async function scenario(fixture) {
  const launch = tmux(
    "new-session", "-d", "-s", session, "-x", "170", "-y", "45",
    `cd ${JSON.stringify(fixture.cwd)} && HOME=${JSON.stringify(fixture.home)} COLORTERM=truecolor pi --no-session 2>${JSON.stringify(join(outDir, "pi-err.log"))}`,
  );
  if (launch.status !== 0) throw new Error(`tmux launch failed: ${launch.stderr}`);
  startRecorder();

  phase = "1/7  baseline: real turns on openai-codex/gpt-5.6-sol";
  await waitFor("pi startup (contextimate panel)", (t) => t.includes("[Contextimate]"), { timeoutMs: 90000 });
  await sleep(1200);
  await sendPromptAndWait("Read notes/dataset.md and reply with one short sentence about what it contains.", "sol turn 1 completes");
  check("baseline: sol clock speaks band wording", /cache likely warm .* since last call/.test(widgetLine(captureText())), widgetLine(captureText()));

  await sendPromptAndWait("Reply with exactly: ready", "sol turn 2 completes", 120000);
  const solWarmDeadline = Date.now() + 5 * 60 * 1000; // sol's band soft window for phase 6

  phase = "2/7  /model \u2192 fable: forecast flips BEFORE anything is sent (#57)";
  await sendCommand("/model anthropic/claude-fable-5");
  await waitFor("model switched to fable", (t) => /cache cold expected/.test(t), { timeoutMs: 30000 });
  await sleep(1400);
  let forecastTokens;
  {
    const line = widgetLine(captureText());
    check("switch: BLUF forecast in fable currency, signed breakdown, est-marked",
      /cache cold expected \u00b7 model switched \u00b7 next send ~[\d.]+k uncached to anthropic \([\d.]+k [+-][\d.]+k tokenizer.*\u00b7 est\)/.test(line), line);
    forecastTokens = Number(line.match(/next send ~([\d.]+)k uncached/)?.[1]);
  }

  phase = "3/7  contextimate names the pre-switch currency (#58)";
  {
    const row = await inspectPanel("post-switch");
    check("panel: exact count names its old currency", row.includes("(pre-switch usage \u00b7 gpt-5.6-sol tokens)"), row);
    check("panel: no share of the new window is claimed", !/% \//.test(row), row);
  }

  phase = "4/7  adversarial: abort fable's first response mid-stream";
  const noticesBefore = (captureText(true).match(/cache (breaking|broke|held)/g) ?? []).length;
  sendText("Count from 1 to 400, one number per line, no other text.");
  await waitFor("break notice posts at send (est, model switch cause)",
    () => (captureText(true).match(/cache (breaking|broke|held)/g) ?? []).length > noticesBefore, { timeoutMs: 60000 });
  {
    // Newest notice only: sol's own resolved cold-start line sits higher in scrollback.
    // Long notices wrap, so rejoin the matched line with its continuations.
    const all = captureText(true).split("\n");
    let idx = -1;
    for (let i = all.length - 1; i >= 0; i--) if (/cache (breaking|broke|held)/.test(all[i])) { idx = i; break; }
    const notice = idx === -1 ? "" : all.slice(idx, idx + 3).join(" ");
    if (notice.includes("cache breaking")) {
      check("notice: BLUF, sized in target currency, est-marked",
        /cache breaking \u00b7 sending ~[\d.]+k uncached to anthropic \(.*est/.test(notice), notice);
    }
    if (notice.includes("cache held")) {
      // Back-to-back runs leave anthropic's cache warm for the identical fixture prefix:
      // the resolved line must speak fable's own currency, never sol's 20.6k expectation.
      check("notice: switched send resolved warm in its own currency only",
        /cache held \u00b7 read [\d.]+k \(\d+% of prompt\) \u00b7 the new model already had the prefix cached/.test(notice), notice);
    } else {
      check("notice: cause names the switch", /cause: model switched/.test(notice), notice);
    }
  }
  await sleep(2200); // let fable start streaming
  sendKey("Escape");
  await sleep(3000);
  {
    const line = widgetLine(captureText());
    // Both honest outcomes: abort before billing keeps the pending forecast; abort
    // after billing re-baselines the clock (anthropic wrote the cache while reading).
    const held = /cache cold expected \u00b7 model switched/.test(line);
    const rebaselined = /\u25cd cache \d/.test(line) && !/model switched/.test(line);
    check(`abort: clock in an honest state (${held ? "held forecast" : "re-baselined by billed abort"})`, held || rebaselined, line);
    const row = await inspectPanel("post-abort");
    if (held) {
      check("abort: pi's exact count still anchored pre-switch — panel naming holds",
        row.includes("(pre-switch usage \u00b7 gpt-5.6-sol tokens)"), row);
    } else {
      check("abort: billed abort re-baselined the panel too", !row.includes("pre-switch"), row);
    }
  }

  phase = "5/7  a completed fable call re-baselines everything";
  await sendPromptAndWait("Reply with exactly: hello from fable", "fable completes");
  await waitFor("clock re-baselines to fable's contract window", (t) => {
    const line = widgetLine(t);
    return /\u25cd cache \d/.test(line) && !/model switched/.test(line) && !/likely/.test(line);
  }, { timeoutMs: 30000 });
  check("re-baseline: contract countdown in fable's own window", true);
  {
    const row = await inspectPanel("re-baselined");
    check("re-baseline: share of the window returns", /% \//.test(row), row);
    check("re-baseline: pre-switch naming gone", !row.includes("pre-switch"), row);
    // Forecast accuracy against billed reality, in fable's own currency: the panel's
    // re-baselined total is that prompt whether it was re-written or read back warm
    // (a stray sol re-wrote line must never be the comparator — wrong currency).
    const realTokens = Number(row.match(/Total request\s+([\d.]+)k tokens/)?.[1]);
    if (forecastTokens && realTokens) {
      const ratio = forecastTokens / realTokens;
      check(`forecast accuracy: ~${forecastTokens}k est vs ${realTokens}k billed (${ratio.toFixed(2)}x)`,
        ratio > 0.55 && ratio < 1.8);
    }
  }

  phase = "6/7  A\u2192B\u2192A: switch back inside sol's warm window";
  check("timing: still inside sol's 5m band window", Date.now() < solWarmDeadline,
    `${Math.round((Date.now() - (solWarmDeadline - 300000)) / 1000)}s since sol's last call`);
  await sendCommand("/model openai-codex/gpt-5.6-sol");
  await waitFor("switch-back speaks warm-prior wording", (t) => /may still be warm/.test(t), { timeoutMs: 30000 });
  await sleep(1400);
  {
    const line = widgetLine(captureText());
    check("A\u2192B\u2192A: defers to sol's own prior entry, no cold overclaim",
      /cache may still be warm \u00b7 last gpt-5\.6-sol call .+ ago \u00b7 next send confirms/.test(line), line);
  }

  phase = "7/7  confirm on sol + the /cache ledger tells the story";
  await sendPromptAndWait("Reply with exactly: done", "sol confirms", 120000);
  await sendCommand("/cache");
  const ledger = await waitFor("ledger renders", (t) => /cache & loop ledger/.test(t), { timeoutMs: 30000, scrollback: true });
  // Two honest outcomes for fable's first call: a miss attributed to the switch, or a
  // warm hold (the aborted send's write served it) whose resolved line told the story.
  const heldWarm = /the new model already had the prefix cached/.test(captureText(true));
  check(`ledger: fable's first call attributed (${heldWarm ? "warm hold" : "switch miss"})`,
    /model switched/.test(ledger) || heldWarm);
  check("ledger: multiple calls recorded", (ledger.match(/\u25cf|\u25cb|\u25d1|\u25cc/g) ?? []).length >= 3);
  await sleep(4500); // hold the ledger for the video

  phase = "";
}

// --- video ---------------------------------------------------------------------------
async function renderVideo(frameList) {
  const amber = (s) => `\x1b[38;2;224;175;104m${s}\x1b[0m`;
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const caption = (label) =>
    `\x1b[48;2;30;32;44m\x1b[38;2;224;175;104m\x1b[1m  ${(label || "pine-of-glass \u00b7 model-switch live smoke").padEnd(166).slice(0, 166)}\x1b[0m`;

  console.log(`rendering ${frameList.length} frames \u2192 mp4 ...`);
  const htmlDir = join(outDir, "html");
  const pngDir = join(outDir, "png");
  mkdirSync(htmlDir, { recursive: true });
  mkdirSync(pngDir, { recursive: true });

  const jobs = frameList.map((frame, i) => async () => {
    const name = `v${String(i).padStart(4, "0")}`;
    const capped = `${caption(frame.phase)}\n\n${readFileSync(frame.file, "utf8")}`;
    const txt = join(htmlDir, `${name}.txt`);
    writeFileSync(txt, capped);
    const html = join(htmlDir, `${name}.html`);
    let r = run(["node", join(here, "screenshots", "ansi2html.mjs"), txt, "--title", "pi \u2014 model-switch live smoke", "--out", html, "--cols", "170"]);
    if (r.status !== 0) throw new Error(`ansi2html: ${r.stderr}`);
    r = run(["python3", join(here, "screenshots", "html2png.py"), html, join(pngDir, `${name}.png`), "--width", "2950", "--height", "3400"]);
    if (r.status !== 0) throw new Error(`html2png(${name}): ${r.stderr}`);
  });
  let next = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (next < jobs.length) { const i = next++; await jobs[i](); if (i % 25 === 0) console.log(`  frame ${i}/${jobs.length}`); }
  });
  await Promise.all(workers);

  // Uniform canvas: pad every frame to the max dimensions (autocrop can differ by a
  // few px between frames), then concat with real-time durations capped for review.
  const probe = run(["python3", "-c", `
import sys, os
from PIL import Image
d = ${JSON.stringify(pngDir)}
w = h = 0
for f in sorted(os.listdir(d)):
    if f.endswith('.png'):
        im = Image.open(os.path.join(d, f)); w = max(w, im.width); h = max(h, im.height)
print(w + (w % 2), h + (h % 2))
`]);
  const [W, H] = probe.stdout.trim().split(" ").map(Number);
  const list = [];
  for (let i = 0; i < frameList.length; i++) {
    const cur = frameList[i];
    const nxt = frameList[i + 1];
    const real = nxt ? (nxt.ts - cur.ts) / 1000 : 3.0;
    const d = cur.hold ? cur.hold / 1000 : Math.min(Math.max(real, 0.22), 1.3);
    list.push(`file 'png/v${String(i).padStart(4, "0")}.png'`, `duration ${d.toFixed(3)}`);
  }
  list.push(`file 'png/v${String(frameList.length - 1).padStart(4, "0")}.png'`);
  writeFileSync(join(outDir, "concat.txt"), list.join("\n") + "\n");
  const video = join(outDir, "model-switch-live-smoke.mp4");
  const ff = run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", join(outDir, "concat.txt"),
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0c10,format=yuv420p`,
    "-r", "30", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", video]);
  if (ff.status !== 0) throw new Error(`ffmpeg: ${ff.stderr?.slice(-800)}`);
  console.log(`video: ${video}`);
  return video;
}

function endCard() {
  const ok = results.filter((r) => r.cond).length;
  const lines = ["", "", `   \x1b[1mmodel-switch live smoke \u2014 ${ok}/${results.length} checks passed\x1b[0m`, ""];
  for (const r of results) {
    lines.push(`   ${r.cond ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m"} ${r.label}`);
  }
  addCard(lines, 7000, "results");
}

// --- main ----------------------------------------------------------------------------
async function main() {
  const videoOnlyIx = process.argv.indexOf("--video-only");
  if (videoOnlyIx >= 0) {
    const dir = process.argv[videoOnlyIx + 1];
    const files = readdirSync(dir).filter((f) => /^f\d+\.txt$/.test(f)).sort();
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const video = await renderVideo(meta.map((m, i) => ({ ...m, file: join(dir, files[i]) })));
    run(["open", video]);
    return;
  }

  for (const bin of [["tmux", "-V"], ["pi", "--version"], ["ffmpeg", "-version"]]) {
    if (run(bin).status !== 0) { console.error(`${bin[0]} unavailable`); process.exit(2); }
  }
  if (!existsSync(CHROME)) { console.error("Chrome not found"); process.exit(2); }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  tmux("kill-session", "-t", session);

  const fixture = makeFixture();
  addCard(["", "", "   \x1b[1mpine-of-glass \u00b7 model-switch forecasting (#57) & mixed-currency safety (#58)\x1b[0m", "",
    dimLine("   live adversarial smoke: real pi, real model calls, isolated HOME"),
    dimLine("   sol \u2192 fable \u2192 abort \u2192 complete \u2192 back to sol"), ""], 3500, "title");
  let failed = false;
  try {
    await scenario(fixture);
  } catch (error) {
    failed = true;
    console.error(`scenario error: ${error.message}`);
  } finally {
    clearInterval(recorder);
    if (!keep) {
      tmux("send-keys", "-t", session, "-l", "/quit");
      tmux("send-keys", "-t", session, "Enter");
      await sleep(1500);
      tmux("kill-session", "-t", session);
      rmSync(fixture.home, { recursive: true, force: true });
    } else {
      console.log(`kept: tmux -L poglive attach -t ${session}  (HOME=${fixture.home})`);
    }
  }
  endCard();
  writeFileSync(join(framesDir, "meta.json"), JSON.stringify(frames.map(({ ts, phase: p, hold }) => ({ ts, phase: p, hold })), null, 1));

  const video = await renderVideo(frames);
  const ok = results.filter((r) => r.cond).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  run(["open", video]);
  process.exit(failed || ok !== results.length ? 1 : 0);
}

function dimLine(s) { return `\x1b[2m${s}\x1b[0m`; }

main().catch((error) => { console.error(error); process.exit(1); });
