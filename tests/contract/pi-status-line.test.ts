import { test } from "node:test";
import assert from "node:assert/strict";
import { InteractiveMode, SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { suppressThinkingToggleStatus } from "../../extensions/pi-traceline/status-line.ts";

initTheme(undefined, false);

// SAFETY: these private Pi methods own the native status pair and toggle caption.
// Calling them here catches drift through behaviour, not source-text matching.
const native = InteractiveMode.prototype as unknown as {
  toggleThinkingBlockVisibility: (this: unknown) => void;
  updateThinkingBlockVisibility: (this: unknown) => void;
  showStatus: (this: unknown, message: string) => void;
};

function mode() {
  const chatContainer = new Container();
  chatContainer.addChild(new Text("assistant prose", 0, 0));
  return {
    chatContainer,
    hideThinkingBlock: false,
    settingsManager: SettingsManager.inMemory(),
    ui: { requestRender() {} },
    updateThinkingBlockVisibility: native.updateThinkingBlockVisibility,
    showStatus: native.showStatus,
  };
}

test("both native thinking toggles lose their status pair, not the preceding prose", () => {
  const receiver = mode();
  const keep = [...receiver.chatContainer.children];
  for (const hidden of [true, false]) {
    native.toggleThinkingBlockVisibility.call(receiver);
    assert.equal(receiver.settingsManager.getHideThinkingBlock(), hidden);
    assert.equal(receiver.chatContainer.children.length, keep.length + 2);
    assert.equal(suppressThinkingToggleStatus(receiver.chatContainer.children), true);
    assert.deepEqual(receiver.chatContainer.children, keep);
  }
});

test("unrelated native statuses and historical toggle captions survive", () => {
  const receiver = mode();
  native.showStatus.call(receiver, "Forked to new session");
  const keep = [...receiver.chatContainer.children];
  assert.equal(suppressThinkingToggleStatus(receiver.chatContainer.children), false);
  assert.deepEqual(receiver.chatContainer.children, keep);

  native.toggleThinkingBlockVisibility.call(receiver);
  receiver.chatContainer.addChild(new Text("later prose", 0, 0));
  const history = [...receiver.chatContainer.children];
  assert.equal(suppressThinkingToggleStatus(receiver.chatContainer.children), false);
  assert.deepEqual(receiver.chatContainer.children, history);
});
