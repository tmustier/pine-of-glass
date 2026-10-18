import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { isNoticeRow, isToolRow } from "../_lib/chat.ts";

// Ctrl+T is decisive over z1 (design language §9.12): Ctrl+O, a click or a drill pin
// leaves rows expanded, and they would stay pinned to z1 after reasoning hides again.
// Collapse them before the key reaches Pi's native reasoning handler. Release/repeat
// events are consumed so one physical press produces one transition under the Kitty
// keyboard protocol.
export function handleThinkingToggleTerminalInput(
  data: string,
  ui: Pick<ExtensionUIContext, "getToolsExpanded" | "setToolsExpanded">,
  chatChildren: () => readonly unknown[] | undefined,
  afterToggle?: () => void,
): { consume: true } | undefined {
  if (!matchesKey(data, "ctrl+t")) return undefined;
  if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
  if (ui.getToolsExpanded()) ui.setToolsExpanded(false);
  for (const row of chatChildren() ?? []) {
    if (isToolRow(row) && row.expanded) row.setExpanded(false);
    else if (isNoticeRow(row) && row._expanded) row.setExpanded(false);
  }
  queueMicrotask(() => afterToggle?.());
  return undefined;
}
