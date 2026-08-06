// Drill mode's raw terminal-input hook (design language §9.13), fed by Traceline's
// onTerminalInput listener in index.ts. A foreign modifier chord ends the mode instead
// of dying in it: the exit is synchronous (Pi restores the editor inline in `close`)
// and the chord is not consumed, so the same keystroke lands in the restored editor.

import { isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import { drillState, exitDrillMode } from "./drill.ts";

export function handleDrillTerminalInput(data: string): undefined {
  if (drillState() && isForeignChord(data)) exitDrillMode();
  return undefined;
}

// The mode owns only unmodified keys (digits, j/k, arrows, p, esc, enter, …). A chord
// carrying alt/ctrl/meta/super can never be one of them and can never be typed text,
// so it can only mean "I want something outside the mode" (§9.13). Key releases are
// ignored: the press already decided.
const FOREIGN_CHORD_MODIFIER = /(?:^|\+)(?:alt|ctrl|meta|super)\+/;

export function isForeignChord(data: string): boolean {
  if (isKeyRelease(data)) return false;
  const key = parseKey(data);
  return key !== undefined && FOREIGN_CHORD_MODIFIER.test(key);
}
