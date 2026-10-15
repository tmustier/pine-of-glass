// Contract: the Ctrl+T status line traceline suppresses (design language §9.11).
// pi's toggleThinkingBlockVisibility ends with showStatus(`Thinking blocks: …`), which
// appends a Spacer + status Text pair to chatContainer. Traceline drops exactly that
// trailing pair; if the message text or the pair shape drifts, the caption reappears
// silently, so this contract names the seam against the installed pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as piTui from "@earendil-works/pi-tui";

import { internals as traceline } from "../../extensions/pi-traceline/index.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

test("Ctrl+T status line: pi's showStatus tail shape traceline suppresses", async () => {
  // pi's toggleThinkingBlockVisibility ends with showStatus(`Thinking blocks: …`),
  // which appends a Spacer(1) + Text pair to chatContainer. Traceline drops exactly
  // that trailing pair (design language §9.11); if the message text or the pair
  // shape drifts, the status line reappears silently — this contract names it.
  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.ok(
    source.includes('`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`'),
    "Ctrl+T status message text drifted — THINKING_TOGGLE_STATUS no longer matches",
  );
  // Since pi 0.99 the status text is a ThemedText: a Text subclass whose string is
  // built lazily by `build()` on first render, so it is still empty when traceline's
  // post-toggle microtask runs. The duck type must read the builder.
  assert.ok(
    /showStatus\(message\)\s*\{[\s\S]{0,900}?new Spacer\(1\);[\s\S]{0,200}?new ThemedText\(\(\) => theme\.fg\("dim", this\.lastStatusMessage\)[\s\S]{0,300}?addChild\(spacer\);[\s\S]{0,100}?addChild\(text\);/.test(source),
    "showStatus no longer appends a Spacer + lazily built dim ThemedText pair to the chat — suppression seam drifted",
  );
  const themedTextSource = readFileSync(join(piRoot, "dist/modes/interactive/components/themed-text.js"), "utf8");
  assert.ok(
    themedTextSource.includes("export class ThemedText extends Text") && themedTextSource.includes("this.setText(this.build());"),
    "ThemedText no longer a lazily built Text — the status duck type's build() fallback drifted",
  );

  // The real pi-tui components satisfy (and only the right one satisfies) the duck
  // types. The text is stored ANSI-styled (theme.fg("dim", message)); the duck type
  // strips ANSI, so any dim wrapper stands in for the live theme's.
  const text = new piTui.Text("\x1b[90mThinking blocks: hidden\x1b[0m", 1, 0);
  const spacer = new piTui.Spacer(1);
  assert.equal(traceline.isThinkingToggleStatusRow(text), true, "real Text no longer matches the status duck type");
  const themedText = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/components/themed-text.js")).href) as {
    ThemedText: new (build: () => string, paddingX?: number, paddingY?: number) => piTui.Text;
  };
  const lazy = new themedText.ThemedText(() => "\x1b[90mThinking blocks: hidden\x1b[0m", 1, 0);
  assert.equal(traceline.isThinkingToggleStatusRow(lazy), true, "unrendered ThemedText no longer matches the status duck type");
  assert.equal(
    traceline.isThinkingToggleStatusRow(new themedText.ThemedText(() => "\x1b[90mForked to new session\x1b[0m", 1, 0)),
    false,
  );
  assert.equal(traceline.isSpacerRow(spacer), true, "real Spacer no longer matches the spacer duck type");
  assert.equal(traceline.isSpacerRow(text), false);
  assert.equal(traceline.isThinkingToggleStatusRow(spacer), false);
  assert.equal(
    traceline.isThinkingToggleStatusRow(new piTui.Text("\x1b[90mForked to new session\x1b[0m", 1, 0)),
    false,
    "other showStatus messages must pass through",
  );

  // End-to-end against a real Container: mimic the toggle's tail, then suppress.
  const container = new piTui.Container();
  const keep = new piTui.Text("assistant prose", 1, 0);
  container.addChild(keep);
  container.addChild(spacer);
  container.addChild(text);
  const previousChat = traceline.getTracelineChat();
  traceline.setTracelineChat(container as never);
  try {
    traceline.suppressThinkingToggleStatus();
    assert.deepEqual(container.children, [keep], "trailing Spacer + Text status pair must be removed");
  } finally {
    traceline.setTracelineChat(previousChat);
  }
});
