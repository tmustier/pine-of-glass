import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pi from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

import * as chatline from "../../extensions/_lib/chatline.ts";
import { assistantMessage } from "../helpers.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

function fakeTerminal(): piTui.Terminal {
  const noop = () => {};
  return {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start: noop,
    stop: noop,
    drainInput: async () => {},
    write: noop,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
  };
}

test("global thinking visibility updates preserve chat identities in both real renderer modes", async () => {
  pi.initTheme(undefined, false);
  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.doesNotMatch(
    source,
    /toggleThinkingBlockVisibility\(\)\s*\{[^}]*this\.chatContainer\.clear\(\)/s,
    "Ctrl+T must update existing assistant rows rather than rebuilding chat",
  );
  const tuiModule = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/tui-renderer.js")).href) as {
    createInteractiveTui: (options: {
      tuiMode: "regular" | "fullscreen";
      showHardwareCursor: boolean;
      logDirectory: string;
      terminal: piTui.Terminal;
    }) => piTui.TuiMainScreen | piTui.TuiAltScreen;
  };
  const prototype = pi.InteractiveMode.prototype as unknown as {
    updateThinkingBlockVisibility: (this: unknown) => void;
    toggleThinkingBlockVisibility: (this: unknown) => void;
    showStatus: (this: unknown, message: string) => void;
  };
  assert.equal(typeof prototype.updateThinkingBlockVisibility, "function", "global thinking visibility updater moved");
  assert.equal(typeof prototype.toggleThinkingBlockVisibility, "function", "global thinking visibility toggle moved");

  for (const tuiMode of ["regular", "fullscreen"] as const) {
    const renderer = tuiModule.createInteractiveTui({
      tuiMode,
      showHardwareCursor: false,
      logDirectory: "",
      terminal: fakeTerminal(),
    });
    assert.ok(
      tuiMode === "regular" ? renderer instanceof piTui.TuiMainScreen : renderer instanceof piTui.TuiAltScreen,
      `${tuiMode}: factory returned the wrong native renderer`,
    );
    let renders = 0;
    (renderer as unknown as { requestRender: () => void }).requestRender = () => { renders++; };

    const container = new piTui.Container();
    renderer.addChild(container);
    const assistant = new pi.AssistantMessageComponent(assistantMessage([{ type: "thinking", thinking: "kept" }]));
    const familyLine = new piTui.Text("cache line", 1, 0);
    container.addChild(assistant);
    container.addChild(familyLine);
    const persisted: boolean[] = [];
    const mode = {
      chatContainer: container,
      hideThinkingBlock: false,
      ui: renderer,
      settingsManager: { setHideThinkingBlock: (hidden: boolean) => { persisted.push(hidden); } },
      updateThinkingBlockVisibility: prototype.updateThinkingBlockVisibility,
      showStatus: prototype.showStatus,
      lastStatusSpacer: undefined,
      lastStatusText: undefined,
    };

    prototype.toggleThinkingBlockVisibility.call(mode);
    assert.equal(mode.hideThinkingBlock, true, `${tuiMode}: first toggle did not hide thinking`);
    assert.equal((assistant as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock, true);
    assert.equal(container.children[0], assistant, `${tuiMode}: assistant identity changed on hide`);
    assert.equal(container.children[1], familyLine, `${tuiMode}: appended family line was dropped on hide`);

    prototype.toggleThinkingBlockVisibility.call(mode);
    assert.equal(mode.hideThinkingBlock, false, `${tuiMode}: second toggle did not show thinking`);
    assert.equal((assistant as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock, false);
    assert.equal(container.children[0], assistant, `${tuiMode}: assistant identity changed on show`);
    assert.equal(container.children[1], familyLine, `${tuiMode}: appended family line was dropped on show`);
    assert.deepEqual(persisted, [true, false]);
    assert.ok(renders >= 2, `${tuiMode}: toggles must request a render`);
  }
});

test("native chat rebuild restores anchored lines and drops missing anchors", async () => {
  pi.initTheme(undefined, false);
  const realTool = () => new pi.ToolExecutionComponent("read", "tool-9", { path: "/tmp/x" }, undefined, undefined, {} as never, tmpdir());
  assert.equal(chatline.childAnchorKey(realTool()), "tool#tool-9", "tool anchor identity drifted");
  const timestamp = Date.UTC(2026, 5, 10, 22);
  const realAssistant = () => new pi.AssistantMessageComponent(
    assistantMessage([{ type: "text", text: "hi" }], { timestamp }),
  );
  assert.equal(chatline.childAnchorKey(realAssistant()), `assistant#${timestamp}`, "assistant anchor identity drifted");

  const chatContainer = new piTui.Container();
  const originalTool = realTool();
  chatContainer.addChild(realAssistant());
  chatContainer.addChild(originalTool);
  const host: chatline.ChatLineHost = { chat: chatContainer as never, anchored: [] };
  const line = chatline.appendAnchoredLine(host, "contract", "kept");
  assert.ok(line, "appendAnchoredLine failed against the real Container");
  const spacer = host.anchored[0]!.spacer as piTui.Component;

  let includeAnchor = true;
  let rebuiltTool: pi.ToolExecutionComponent | undefined;
  const receiver = {
    chatContainer,
    sessionManager: { buildContextEntries: () => [] },
    renderSessionEntries: (_entries: unknown[]) => {
      chatContainer.addChild(realAssistant());
      if (includeAnchor) {
        rebuiltTool = realTool();
        chatContainer.addChild(rebuiltTool);
      }
    },
  };
  const rebuild = (pi.InteractiveMode.prototype as unknown as {
    rebuildChatFromMessages: (this: unknown) => void;
  }).rebuildChatFromMessages;

  rebuild.call(receiver);
  await Promise.resolve();
  assert.ok(rebuiltTool && rebuiltTool !== originalTool, "rebuild must replace the native tool component");
  assert.deepEqual(chatContainer.children.slice(-3), [rebuiltTool, spacer, line]);
  assert.equal(host.anchored.length, 1);

  includeAnchor = false;
  rebuild.call(receiver);
  await Promise.resolve();
  assert.equal(chatContainer.children.includes(line), false, "line survived after its anchor vanished");
  assert.equal(chatContainer.children.includes(spacer), false, "orphaned spacer survived");
  assert.deepEqual(host.anchored, [], "vanished anchor did not retire its tracked line");
});

test("mounted transcript retains the structure used to discover chat", () => {
  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.ok(source.includes("this.documentContainer.addChild(this.loadedResourcesContainer);"));
  assert.ok(source.includes("this.documentContainer.addChild(this.chatContainer);"));
  assert.ok(source.includes("this.documentContainer,"));
  assert.ok(
    source.indexOf("this.documentContainer.addChild(this.loadedResourcesContainer);") <
      source.indexOf("this.documentContainer.addChild(this.chatContainer);"),
    "loaded resources no longer precede chat",
  );
  assert.ok(/addLoadedSection[\s\S]{0,400}this\.loadedResourcesContainer\.addChild\(section\)/.test(source));
  for (const name of ["Skills", "Prompts", "Extensions", "Themes"]) {
    assert.ok(source.includes(`"${name}"`), `startup section [${name}] renamed`);
  }
});

