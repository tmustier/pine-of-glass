import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Terminal, TUI } from "@earendil-works/pi-tui";

import { findRequestRenderPrototype, patchRequestRender } from "../../extensions/pi-traceline/request-render.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

test("pi's stable TUI reference keeps traceline requestRender wrapping non-recursive", async () => {
  const interactive = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/interactive-mode.js")).href) as {
    createInteractiveTui: (options: {
      tuiMode: "regular" | "fullscreen";
      showHardwareCursor: boolean;
      logDirectory: string;
      terminal: Terminal;
    }) => TUI;
    createInteractiveTuiReference: (getTui: () => TUI) => TUI;
  };
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
  let renderer = interactive.createInteractiveTui({
    tuiMode: "regular",
    showHardwareCursor: false,
    logDirectory: tmpdir(),
    terminal,
  });
  const stableTui = interactive.createInteractiveTuiReference(() => renderer);
  const owner = findRequestRenderPrototype(stableTui);
  assert.ok(owner, "requestRender no longer has a writable prototype owner, traceline cannot install its delayed patch hook");

  const patchedProperties = ["requestRender", "__tracelineOriginalRequestRender", "__tracelineRRWrapVersion"] as const;
  const originalDescriptors = patchedProperties.map((name) => [name, Object.getOwnPropertyDescriptor(owner, name)] as const);
  let beforeRenders = 0;
  try {
    patchRequestRender(stableTui, 1, () => { beforeRenders += 1; });
    assert.doesNotThrow(
      () => stableTui.requestRender(),
      "stable-proxy requestRender recursed, do not assign the wrapper onto Pi's proxy/current renderer",
    );
    assert.equal(beforeRenders, 1, "regular renderer bypassed the traceline hook");
    renderer.stop();

    renderer = interactive.createInteractiveTui({
      tuiMode: "fullscreen",
      showHardwareCursor: false,
      logDirectory: tmpdir(),
      terminal,
    });
    assert.doesNotThrow(
      () => stableTui.requestRender(),
      "requestRender wrapper did not survive Pi's regular/fullscreen renderer replacement",
    );
    assert.equal(beforeRenders, 2, "fullscreen renderer bypassed the shared prototype hook");
  } finally {
    renderer.stop();
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(owner, name, descriptor);
      else Reflect.deleteProperty(owner, name);
    }
  }
});
