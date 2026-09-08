import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as pi from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

import * as chatline from "../../extensions/_lib/chatline.ts";
import { assistantMessage } from "../helpers.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

test("native thinking toggles preserve assistant and family-line identities", () => {
  pi.initTheme(undefined, false);
  const prototype = pi.InteractiveMode.prototype as unknown as {
    updateThinkingBlockVisibility: (this: unknown) => void;
    toggleThinkingBlockVisibility: (this: unknown) => void;
    showStatus: (this: unknown, message: string) => void;
  };
  const container = new piTui.Container();
  const assistant = new pi.AssistantMessageComponent(assistantMessage([{ type: "thinking", thinking: "kept" }]));
  const familyLine = new piTui.Text("cache line", 1, 0);
  container.addChild(assistant);
  container.addChild(familyLine);
  const persisted: boolean[] = [];
  const mode = {
    chatContainer: container,
    hideThinkingBlock: false,
    ui: { requestRender: () => {} },
    settingsManager: { setHideThinkingBlock: (hidden: boolean) => { persisted.push(hidden); } },
    updateThinkingBlockVisibility: prototype.updateThinkingBlockVisibility,
    showStatus: prototype.showStatus,
  };

  for (const hidden of [true, false]) {
    prototype.toggleThinkingBlockVisibility.call(mode);
    assert.equal((assistant as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock, hidden);
    assert.equal(container.children[0], assistant, "assistant identity changed");
    assert.equal(container.children[1], familyLine, "appended family line was dropped");
  }
  assert.deepEqual(persisted, [true, false]);
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

