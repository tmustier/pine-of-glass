import { test } from "node:test";
import assert from "node:assert/strict";

import * as pi from "@earendil-works/pi-coding-agent";

import { internals as traceline } from "../../extensions/pi-traceline/index.ts";
import { assistantMessage } from "../helpers.ts";

function collapsedLines(content: Parameters<typeof assistantMessage>[0], width = 80) {
  pi.initTheme(undefined, false);
  const component = new pi.AssistantMessageComponent(assistantMessage(content));
  component.setHideThinkingBlock(true);
  const native = component.render(width);
  const preview = traceline.replaceThinkingLabels(component as never, native, width);
  const normalize = (lines: string[]) => lines.map((line) => traceline.stripAnsi(line).trim());
  return { native: normalize(native), preview: normalize(preview) };
}

test("current Pi thinking runs map one-to-one to Traceline previews", () => {
  const { native, preview } = collapsedLines([
    { type: "thinking", thinking: "first adjacent step" },
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: "second adjacent step" },
    { type: "toolCall", id: "contract-call", name: "read", arguments: {} },
    { type: "thinking", thinking: "after tool" },
    { type: "text", text: "visible bridge" },
    { type: "thinking", thinking: "after text" },
  ]);

  assert.equal(native.filter((line) => line === "Thinking...").length, 3);
  assert.deepEqual(preview, [
    "",
    "first adjacent step · second adjacent step",
    "",
    "after tool",
    "",
    "visible bridge",
    "after text",
  ]);
});

test("prose matching the native label is not mistaken for a thinking run", () => {
  const { native, preview } = collapsedLines([
    { type: "text", text: "Thinking..." },
    { type: "thinking", thinking: "actual reasoning" },
  ]);

  assert.deepEqual(preview, native);
});

test("source lines and Markdown flatten within the native row width", () => {
  const { preview } = collapsedLines([
    { type: "thinking", thinking: "**Planning the change**\n\n**Implementing the renderer**" },
    { type: "thinking", thinking: "**Verifying the result**\n\n**Preparing the report**" },
  ]);

  assert.deepEqual(preview, [
    "",
    "Planning the change · Implementing …Verifying the result · Preparing the report",
  ]);
});
