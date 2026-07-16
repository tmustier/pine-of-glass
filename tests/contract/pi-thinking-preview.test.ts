// Contract tests against Pi's installed AssistantMessageComponent. These use real
// payloads and native spacing, not a mock of how Pi might render thinking blocks.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as pi from "@earendil-works/pi-coding-agent";

import { internals as traceline } from "../../extensions/pi-traceline/index.ts";
import { assistantMessage } from "../helpers.ts";

function collapsedLines(content: Parameters<typeof assistantMessage>[0]): { native: string[]; preview: string[] } {
  pi.initTheme(undefined, false);
  const component = new pi.AssistantMessageComponent(assistantMessage(content));
  component.setHideThinkingBlock(true);
  const native = component.render(80);
  const preview = traceline.dedupeThinkingLabels(component as never, native, 80);
  const normalize = (lines: string[]) => lines.map((line) => traceline.stripAnsi(line).trim());
  return { native: normalize(native), preview: normalize(preview) };
}

test("empty thinking blocks are skipped natively and do not shift Traceline previews", () => {
  pi.initTheme(undefined, false);
  const component = new pi.AssistantMessageComponent(assistantMessage([
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: " \n\t\n " },
    { type: "thinking", thinking: "informative reasoning survives" },
    { type: "text", text: "resume sentinel" },
  ]));
  component.setHideThinkingBlock(true);

  const native = component.render(80);
  const visibleNative = native.map((line) => traceline.stripAnsi(line).trim()).filter(Boolean);
  assert.equal(
    visibleNative.filter((line) => line === "Thinking...").length,
    1,
    "Pi's empty-thinking rendering contract changed: re-check preview alignment",
  );

  const deduped = traceline.dedupeThinkingLabels(component as never, native, 80);
  const visibleDeduped = deduped.map((line) => traceline.stripAnsi(line).trim()).filter(Boolean);
  assert.ok(
    visibleDeduped.includes("Thinking: informative reasoning survives"),
    `empty blocks consumed the informative preview: ${JSON.stringify(visibleDeduped)}`,
  );
});

test("one native run label becomes one appended preview across adjacent empty fragments", () => {
  const { native, preview } = collapsedLines([
    { type: "thinking", thinking: "first adjacent step" },
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: " \n\t " },
    { type: "thinking", thinking: "second adjacent step" },
    { type: "thinking", thinking: "third adjacent step" },
  ]);

  assert.equal(
    native.filter((line) => line === "Thinking...").length,
    1,
    "Pi's label-per-adjacent-run contract changed: re-check grouping",
  );
  assert.deepEqual(preview, [
    "",
    "Thinking: first adjacent step · second adjacent step · third adjacent step",
  ]);
});

test("tool calls and text keep native boundaries between thinking runs", () => {
  const { preview } = collapsedLines([
    { type: "thinking", thinking: "before tool" },
    { type: "toolCall", id: "contract-call", name: "read", arguments: {} },
    { type: "thinking", thinking: "after tool" },
    { type: "text", text: "visible bridge" },
    { type: "thinking", thinking: "after text" },
  ]);

  assert.deepEqual(preview, [
    "",
    "Thinking: before tool",
    "",
    "Thinking: after tool",
    "",
    "visible bridge",
    "Thinking: after text",
  ]);
});

test("a single collapsed block flattens source lines and prose paragraphs", () => {
  const { preview } = collapsedLines([
    { type: "thinking", thinking: "single first line\n\nsingle second line" },
  ]);
  assert.deepEqual(preview, [
    "",
    "Thinking: single first line · single second line",
  ]);
});

test("standalone summary paragraphs append into one native-backed row", () => {
  const { native, preview } = collapsedLines([
    { type: "thinking", thinking: "**Planning the change**\n\n**Implementing the renderer**" },
    { type: "thinking", thinking: "**Verifying the result**\n\n**Preparing the report**" },
  ]);
  assert.equal(native.filter((line) => line === "Thinking...").length, 1);
  assert.deepEqual(preview, [
    "",
    "Thinking: Planning the change · Imp…Verifying the result · Preparing the report",
  ]);
});
