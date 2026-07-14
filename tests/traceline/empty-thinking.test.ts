import { test } from "node:test";
import assert from "node:assert/strict";

import { dedupeThinkingLabels } from "../../extensions/pi-traceline/thinking-preview.ts";

const LABEL = "\x1b[3mThinking...\x1b[23m";

test("empty thinking payloads neither hang nor consume the next native label", () => {
  const emptyBeforeReal = {
    hiddenThinkingLabel: "Thinking...",
    lastMessage: { content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "\n \t\n" },
      { type: "thinking", thinking: "real reasoning" },
    ] },
  };
  assert.deepEqual(
    dedupeThinkingLabels(emptyBeforeReal, [LABEL]),
    ["\x1b[3mThinking: real reasoning\x1b[23m"],
    "empty blocks Pi does not render must not consume the next native label",
  );

  for (const thinking of ["", "\n \t\n"]) {
    const emptyOnly = {
      hiddenThinkingLabel: "Thinking...",
      lastMessage: { content: [{ type: "thinking", thinking }] },
    };
    assert.deepEqual(
      dedupeThinkingLabels(emptyOnly, ["visible prose"]),
      ["visible prose"],
      "empty thinking payloads leave real Pi output unchanged without hanging",
    );
  }
});
