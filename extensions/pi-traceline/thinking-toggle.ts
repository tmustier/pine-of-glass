import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { isNoticeRow, isToolRow } from "../_lib/chat.ts";

// Ctrl+T is decisive over z1 (design language §9.12). Ctrl+O's global expansion writes
// `expanded = true` onto every row, and a click or drill pin writes it onto one. Without
// clearing that state, a later Ctrl+T can hide reasoning while those rows stay pinned to
// z1's native renderer, so the trace appears not to toggle. Collapse them before the key
// reaches Pi's native reasoning handler: Ctrl+T remains decisive, while Ctrl+O can opt
// back into z1 afterwards. Release/repeat events are consumed as before so one physical
// press produces one transition under the Kitty keyboard protocol.
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
