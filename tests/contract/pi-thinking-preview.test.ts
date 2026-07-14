// Contract test against Pi's installed AssistantMessageComponent. Empty thinking blocks
// are intentionally real payloads here, not a mock of how Pi might render them.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as pi from "@earendil-works/pi-coding-agent";

import { internals as traceline } from "../../extensions/pi-traceline/index.ts";
import { assistantMessage } from "../helpers.ts";

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
