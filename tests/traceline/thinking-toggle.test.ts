// Ctrl+T is decisive over Ctrl+O's global z1 expansion (design language §9.12):
// Traceline collapses expanded tool rows before letting Pi's native reasoning toggle
// handle the same press. Kitty release/repeat events remain consumed so one physical
// press produces one transition.
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleThinkingToggleTerminalInput } from "../../extensions/pi-traceline/thinking-toggle.ts";

function toolsUi(expanded: boolean) {
  const writes: boolean[] = [];
  return {
    writes,
    ui: {
      getToolsExpanded: () => expanded,
      setToolsExpanded: (next: boolean) => {
        expanded = next;
        writes.push(next);
      },
    },
  };
}

test("Ctrl+T collapses Ctrl+O expansion and continues to Pi's native toggle", () => {
  const { ui, writes } = toolsUi(true);

  assert.equal(handleThinkingToggleTerminalInput("\x14", ui), undefined, "press must continue to Pi");
  assert.deepEqual(writes, [false], "expanded z1 rows must collapse before Pi toggles reasoning");
});

test("Ctrl+T leaves an already-collapsed tool view alone", () => {
  const { ui, writes } = toolsUi(false);

  assert.equal(handleThinkingToggleTerminalInput("\x14", ui), undefined);
  assert.deepEqual(writes, [], "avoid a redundant global expansion write and render");
});

test("unrelated keys pass through; Kitty repeats and releases are consumed", () => {
  const { ui, writes } = toolsUi(true);

  assert.equal(handleThinkingToggleTerminalInput("x", ui), undefined);
  assert.deepEqual(handleThinkingToggleTerminalInput("\x1b[116;5:2u", ui), { consume: true });
  assert.deepEqual(handleThinkingToggleTerminalInput("\x1b[116;5:3u", ui), { consume: true });
  assert.deepEqual(writes, [], "only a fresh Ctrl+T press may change expansion state");
});
