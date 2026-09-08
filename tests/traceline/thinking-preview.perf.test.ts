import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import type { AssistantRowDataLike } from "../../extensions/_lib/chat.ts";
import { installThinkingPreviews } from "../../extensions/pi-traceline/thinking-preview.ts";
import { assistantMessage } from "../helpers.ts";

initTheme(undefined, false);

const REASONING_LINE =
  "The `patchAssistantRowPrototype` wrapper runs on **every** render pass, so let me trace how `AssistantRow.render()` gets invoked while deltas stream in.";
const BLOCK_TEXT = Array.from({ length: 120 }, (_, i) => (i % 12 === 0 ? "" : `${REASONING_LINE} (${i})`)).join("\n");

function longConversationMessage() {
  return assistantMessage(Array.from({ length: 40 }, (_, turn) => [
    ...Array.from({ length: 3 }, () => ({ type: "thinking" as const, thinking: BLOCK_TEXT })),
    { type: "text" as const, text: `turn ${turn} result` },
  ]).flat());
}

function install(comp: AssistantMessageComponent): void {
  installThinkingPreviews(comp as unknown as AssistantRowDataLike);
}

function painted(comp: AssistantMessageComponent): string[] {
  install(comp);
  return comp.render(100).map((line) => stripAnsi(line).trim());
}

test("long-conversation shape produces the expected previews", () => {
  const comp = new AssistantMessageComponent(longConversationMessage(), true);
  const out = painted(comp);
  assert.equal(out.filter((line) => line.startsWith("The patchAssistantRowPrototype")).length, 40);
  assert.ok(out.every((line) => line !== "Thinking..."));
});

test("unchanged thinking blocks are not reparsed across component rebuilds", (t) => {
  const message = longConversationMessage();
  const comp = new AssistantMessageComponent(message, true);
  install(comp);
  // Click expansion now caches installed children already. Exercise rebuilds too:
  // streaming updates and thinking toggles recreate children but retain block objects.
  const render = t.mock.method(Markdown.prototype, "render");
  for (let frame = 0; frame < 20; frame++) {
    comp.updateContent(message, true);
    install(comp);
  }
  assert.equal(render.mock.callCount(), 0, "historical blocks must not reparse Markdown");
});

test("a streaming block grows without re-deriving unrelated work", (t) => {
  const historical = { type: "thinking" as const, thinking: "Historical thought." };
  const streaming = { type: "thinking" as const, thinking: REASONING_LINE };
  const message = assistantMessage([historical, streaming]);
  const comp = new AssistantMessageComponent(message, true);
  const before = painted(comp);
  const render = t.mock.method(Markdown.prototype, "render");
  streaming.thinking += "\nSecond thought about **caching**.";
  comp.updateContent(message, true);
  install(comp);
  assert.equal(render.mock.callCount(), 2, "only the growing block's two lines should reparse");
  const after = painted(comp);
  assert.ok(before.every((line) => !line.includes("Second thought")));
  assert.ok(after.some((line) => line.includes("Second thought about caching")));
});
