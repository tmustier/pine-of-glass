import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TuiAltScreen, TuiMainScreen, type Terminal, type TUI } from "@earendil-works/pi-tui";

import { patchRequestRender } from "../../extensions/pi-traceline/request-render.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

test("traceline's render hook follows Pi's stable TUI reference across modes", async () => {
  const { createInteractiveTuiReference } = await import(
    pathToFileURL(join(piRoot, "dist/modes/interactive/interactive-mode.js")).href
  ) as { createInteractiveTuiReference: (getTui: () => TUI) => TUI };
  const terminal: Terminal = {
    columns: 100,
    rows: 30,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  let renderer: TUI = new TuiMainScreen(terminal, false, tmpdir());
  const stableTui = createInteractiveTuiReference(() => renderer);
  let renders = 0;

  patchRequestRender(stableTui, () => { renders += 1; });
  try {
    stableTui.requestRender();
    assert.equal(renders, 1);
    renderer.stop();

    renderer = new TuiAltScreen(terminal, false, tmpdir());
    stableTui.requestRender();
    assert.equal(renders, 2);
  } finally {
    renderer.stop();
  }
});
