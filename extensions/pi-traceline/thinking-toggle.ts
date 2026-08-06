import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

// Ctrl+O's global expansion writes `expanded = true` onto every tool row. Without
// clearing that state, a later Ctrl+T can hide reasoning while every row stays pinned
// to z1's native renderer, so the trace appears not to toggle. Collapse z1 before the
// key reaches Pi's native reasoning handler: Ctrl+T remains decisive, while Ctrl+O can
// opt back into z1 afterwards. Release/repeat events are consumed as before so one
// physical press produces one transition under the Kitty keyboard protocol.
export function handleThinkingToggleTerminalInput(
  data: string,
  ui: Pick<ExtensionUIContext, "getToolsExpanded" | "setToolsExpanded">,
  afterToggle?: () => void,
): { consume: true } | undefined {
  if (!matchesKey(data, "ctrl+t")) return undefined;
  if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
  if (ui.getToolsExpanded()) ui.setToolsExpanded(false);
  queueMicrotask(() => afterToggle?.());
  return undefined;
}
