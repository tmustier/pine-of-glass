// Drill mode's raw terminal-input hook (design language §9.13), fed by traceline's
// onTerminalInput listener in index.ts. While the mode is active every mouse report is
// consumed: the wheel scrolls the pager when open, else walks the selection (wheel up =
// older); clicks and drags are swallowed so they never reach pi's editor as garbage
// input. A foreign modifier chord ends the mode instead of dying in it: the exit is
// synchronous (pi restores the editor inline in `close`) and the chord is deliberately
// NOT consumed, so the very same keystroke lands in the restored editor and does what
// it always does — option+up edits a queue, ctrl+c aborts, the entry chord re-freezes
// the numbering through its own shortcut.

import { isKeyRelease, parseKey } from "@earendil-works/pi-tui";
import { drillState, exitDrillMode, setSelected } from "./drill.ts";

const SGR_MOUSE_EVENT = /\x1b\[<(\d+);\d+;\d+([Mm])/g;

/** Net wheel movement across a chunk of SGR mouse events: negative = wheel up. */
export function wheelDelta(data: string): number {
  let wheel = 0;
  SGR_MOUSE_EVENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE_EVENT.exec(data))) {
    if (match[2] !== "M") continue; // presses only; SGR release events end in lowercase m
    const cb = Number(match[1]);
    if ((cb & 64) === 0) continue; // not a wheel event
    const dir = cb & 3; // 0 = wheel up, 1 = wheel down; 2/3 are horizontal, ignored
    if (dir === 0 || dir === 1) wheel += dir === 0 ? -1 : 1;
  }
  return wheel;
}

export function handleDrillTerminalInput(data: string): { consume: true } | undefined {
  const st = drillState();
  if (!st) return undefined;
  if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) {
    const wheel = wheelDelta(data);
    if (wheel !== 0) {
      if (st.pager) st.pager.scrollBy(wheel * 3);
      else setSelected(st, st.selected - wheel);
    }
    return { consume: true };
  }
  if (isForeignChord(data)) exitDrillMode();
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
