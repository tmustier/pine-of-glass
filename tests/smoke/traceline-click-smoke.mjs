#!/usr/bin/env node
// Real fullscreen Pi, raw SGR mouse input through an isolated tmux PTY. No model calls.
import assert from "node:assert/strict";
import { join } from "node:path";
import { createClickFixture } from "./click-fixture.mjs";

const {
  cwd, artifacts, timestamp, assistant, append, tmux, session,
  capture, keys, wait, point, raw, click, sleep, launch, close, shot,
} = createClickFixture("tool-click");

try {
  append({ role: "user", content: [{ type: "text", text: "Mouse expansion fixture" }], timestamp });
  append(assistant([{ type: "text", text: "Inspect three sibling files, then a separate call." }]));
  for (const [i, path] of ["src/alpha.txt", "src/beta.txt", "src/gamma.txt", "other/solo.txt"].entries()) {
    const id = `call-${i}`;
    append(assistant([{ type: "toolCall", id, name: "read", arguments: { path: join(cwd, path) } }], "toolUse"));
    append({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `OUTPUT_${path.split("/").pop().split(".")[0].toUpperCase()}\nsecond result line\nthird result line` }], isError: false, timestamp });
  }
  append(assistant([{ type: "text", text: "CLICK_FIXTURE_READY" }]));
  launch(100, 40);
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
  const p = point("beta.txt");
  raw(0, p.x, p.y); raw(32, p.x + 4, p.y); raw(0, p.x + 4, p.y, true);
  sleep(200);
  assert.ok(!capture().includes("OUTPUT_"), "drag expanded a call");
  assert.ok(capture().includes("draft stays here"), "clicks stole editor draft");
  click("beta.txt");
  wait((s) => s.includes("OUTPUT_BETA"), "click after drag failed");
  click("alpha.txt", 4);
  wait((s) => s.includes("3 calls") && !s.includes("OUTPUT_"), "group glyph did not collapse/refold members");
  shot("04-refolded");
  tmux("resize-window", "-t", session, "-x", "60", "-y", "40");
  wait((s) => s.split("\n").includes("─".repeat(60)), "resize did not repaint");
  click("gamma.txt");
  wait((s) => !s.includes("3 calls") && s.includes("▾"), "wrapped aggregate click failed");
  click("gamma.txt");
  wait((s) => s.includes("OUTPUT_GAMMA"), "resized individual click failed");
  shot("05-narrow-expanded");
  click("gamma.txt");
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
  close();
}
