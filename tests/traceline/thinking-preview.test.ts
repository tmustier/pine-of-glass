import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { replaceThinkingLabels } from "../../extensions/pi-traceline/thinking-preview.ts";

const LABEL = "\x1b[3mThinking...\x1b[23m";

function thinkingComp(thinking: string) {
  return {
    hiddenThinkingLabel: "Thinking...",
    lastMessage: { content: [{ type: "thinking", thinking }] },
  };
}

test("a collapsed run becomes one plain inline preview", () => {
  assert.deepEqual(
    replaceThinkingLabels(
      thinkingComp("\n  **first reasoning line**\n\n2 * 3 = 6"),
      ["", LABEL],
    ),
    ["", "\x1b[3mfirst reasoning line · 2 * 3 = 6\x1b[23m"],
  );
});

test("the preview preserves its native row and fits the terminal width", () => {
  const zoneMark = "\x1b]133;C\x07";
  const preview = replaceThinkingLabels(
    thinkingComp("first framing thought\nintermediate detail that will be cut\nnewest appended thought"),
    [`${zoneMark}${LABEL}`],
    52,
  )[0]!;

  assert.ok(preview.startsWith(zoneMark), `native zone mark must survive: ${JSON.stringify(preview)}`);
  assert.ok(visibleWidth(preview) <= 52, stripAnsi(preview));
  assert.match(stripAnsi(preview), /^first.*….*newest appended thought$/);
});

test("missing message metadata leaves native rendering unchanged", () => {
  const lines = [LABEL];
  assert.strictEqual(replaceThinkingLabels({ hiddenThinkingLabel: "Thinking..." }, lines), lines);
});
