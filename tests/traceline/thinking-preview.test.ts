import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import type { AssistantRowDataLike } from "../../extensions/_lib/chat.ts";
import { installThinkingPreviews } from "../../extensions/pi-traceline/thinking-preview.ts";
import { assistantMessage } from "../helpers.ts";

initTheme(undefined, false);

function preview(thinking: string, width = 80) {
  const comp = new AssistantMessageComponent(assistantMessage([{ type: "thinking", thinking }]), true);
  installThinkingPreviews(comp as unknown as AssistantRowDataLike);
  return comp.render(width);
}

test("a collapsed run becomes one plain inline preview", () => {
  const lines = preview("\n  **first reasoning line**\n\n2 * 3 = 6");
  assert.deepEqual(lines.map((line) => stripAnsi(line).trim()), ["", "first reasoning line · 2 * 3 = 6"]);
});

test("the preview preserves native zone marks and fits the terminal width", () => {
  const lines = preview("first framing thought\nintermediate detail that will be cut\nnewest appended thought", 52);
  assert.ok(lines[0]!.includes("\x1b]133;A\x07"));
  assert.ok(lines[1]!.includes("\x1b]133;C\x07"));
  assert.ok(visibleWidth(lines[1]!) <= 52);
  assert.match(stripAnsi(lines[1]!).trim(), /^first.*….*newest appended thought$/);
});

test("a run without printable preview text keeps its native label", () => {
  assert.deepEqual(preview("\x01\x02").map((line) => stripAnsi(line).trim()), ["", "Thinking..."]);
});
