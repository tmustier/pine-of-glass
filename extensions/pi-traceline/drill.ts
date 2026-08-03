// Drill mode (design language §9.13): the live transcript is the picker. Entry freezes
// a numbered list of visible tool targets (1 = most recent), re-inks each row's
// six-column prefix with its number at identical width (zero reflow), and swaps the
// editor for a two-line hint bar that owns the keyboard. A committed number or enter
// opens the peek pager (drill-pager.ts); `p` toggles the selected row's native
// expansion (§9.12 z1) in place; esc restores the editor and its draft. A modifier
// chord the mode does not own (option+up, ctrl+c, …) exits the same way without being
// consumed, so the keystroke lands in the restored editor. SGR mouse
// reporting, never enabled for the plain transcript, turns on only inside the mode and
// off at exit/shutdown/process-exit, with every mouse event consumed. State lives on
// globalThis so that after /reload the previously patched tool-row renderer and the
// freshly loaded controller share it, exactly like traceline's other seam globals.

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type KeyId } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_lib/ansi.ts";
import { isToolRow, type ToolRowLike } from "../_lib/chat.ts";
import { ELLIPSIS, SEP, ink, type Tone } from "../_lib/style.ts";
import { DrillPager } from "./drill-pager.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

/** Everything drill mode needs from traceline's render internals, injected by index.ts. */
export type DrillHost = {
  ui: ExtensionUIContext;
  theme(): Theme | undefined;
  chatChildren(): unknown[] | undefined;
  requestRender(): void;
  /** The row's trace-form lines at the given width (a fold carrier renders its fold,
   * which may wrap over several lines for sibling-file dir folds, §9.9). */
  traceLines(comp: ToolRowLike, width: number): string[];
  /** All rows of the folded read run this row carries, when it carries one (§9.9). */
  runRows(comp: ToolRowLike): ToolRowLike[] | undefined;
  /** True when the row renders nothing because an earlier row carries its fold. */
  hiddenByFold(comp: ToolRowLike): boolean;
  statusTone(comp: ToolRowLike): Tone;
  mouse: boolean;
};

export type DrillState = {
  host: DrillHost;
  /** Frozen targets, rows[0] = number 1 = most recent visible target (§9.13). */
  rows: ToolRowLike[];
  numbers: Map<unknown, number>;
  selected: number;
  digits: string;
  pager?: DrillPager;
  closeHint?: () => void;
  closePager?: () => void;
  mouseOn: boolean;
};

type DrillGlobal = typeof globalThis & {
  __tracelineDrill?: DrillState;
  __tracelineDrillMouseGuard?: boolean;
};
const g = globalThis as DrillGlobal;

export function drillState(): DrillState | undefined {
  return g.__tracelineDrill;
}

// --- numbering (rendered by index.ts's patched tool-row renderer) ----------------------

// The number cell holds the rail's three columns exactly, so a numbered row stays one
// line at the same width (§9.13). Numbers above 999 keep the rail (still j/k-reachable).
const MAX_NUMBER = 999;

function numberCell(theme: Theme | undefined, n: number, selected: boolean): string {
  const cell = String(n).padStart(3);
  return selected ? ink(theme, "accent", `${BOLD}${cell}${BOLD_OFF}`) : ink(theme, "dim", cell);
}

/** The six-column drill prefix for a numbered trace row, or undefined outside the mode. */
export function drillTracePrefix(theme: Theme | undefined, comp: unknown, bulletInk: string): string | undefined {
  const st = g.__tracelineDrill;
  const n = st?.numbers.get(comp);
  if (st === undefined || n === undefined || n > MAX_NUMBER) return undefined;
  return `${numberCell(theme, n, st.rows[st.selected] === comp)} ${bulletInk} `;
}

// A native-rendered (expanded or z2) row takes its number on the blank spacer line pi
// renders above the row (§9.13). Only a genuinely blank first line is replaced; any
// other shape passes through untouched, so this can never reflow a native row.
export function drillDecorateNativeRow(theme: Theme | undefined, comp: unknown, lines: unknown, bulletInk: string): unknown {
  const st = g.__tracelineDrill;
  if (!st || !Array.isArray(lines) || lines.length === 0) return lines;
  const n = st.numbers.get(comp);
  if (n === undefined || n > MAX_NUMBER) return lines;
  const first = lines[0];
  if (typeof first !== "string" || stripAnsi(first).trim() !== "") return lines;
  return [`${numberCell(theme, n, st.rows[st.selected] === comp)} ${bulletInk}`, ...lines.slice(1)];
}

// --- mode lifecycle --------------------------------------------------------------------

function collectTargets(host: DrillHost): ToolRowLike[] {
  const sibs = host.chatChildren() ?? [];
  const rows: ToolRowLike[] = [];
  for (let i = sibs.length - 1; i >= 0; i--) {
    const c = sibs[i];
    if (isToolRow(c) && !host.hiddenByFold(c)) rows.push(c);
  }
  return rows;
}

export function enterDrillMode(host: DrillHost): void {
  if (g.__tracelineDrill) return;
  const rows = collectTargets(host);
  if (rows.length === 0) {
    host.ui.notify("traceline: no tool rows to drill into", "info");
    return;
  }
  const st: DrillState = {
    host,
    rows,
    numbers: new Map(rows.map((row, i) => [row as unknown, i + 1])),
    selected: 0,
    digits: "",
    mouseOn: false,
  };
  g.__tracelineDrill = st;
  if (host.mouse) enableMouse(st);
  void host.ui
    .custom<undefined>((_tui, _theme, _kb, done) => {
      st.closeHint = () => done(undefined);
      return new DrillHintBar(st);
    })
    .catch(() => undefined)
    .finally(() => exitDrillMode());
  host.requestRender();
}

/** Idempotent teardown: clears the state first, so re-entry from close callbacks no-ops. */
export function exitDrillMode(): void {
  const st = g.__tracelineDrill;
  if (!st) return;
  g.__tracelineDrill = undefined;
  disableMouse(st);
  try {
    st.closePager?.();
    st.closeHint?.();
  } catch {
    // Pi seam: a dispose-time close may throw during shutdown; state and mouse are already restored.
  }
  st.host.requestRender();
}

// --- selection -------------------------------------------------------------------------

function clampIndex(st: DrillState, index: number): number {
  return Math.min(Math.max(index, 0), st.rows.length - 1);
}

export function setSelected(st: DrillState, index: number): void {
  st.selected = clampIndex(st, index);
  st.digits = "";
  st.host.requestRender();
}

export function togglePin(st: DrillState): void {
  const row = st.rows[st.selected];
  if (!row) return;
  try {
    const expanded = row.expanded !== true;
    for (const member of st.host.runRows(row) ?? [row]) member.setExpanded(expanded);
  } catch {
    // Pi seam: never let a pin toggle break the mode.
  }
  st.host.requestRender();
}

// Digit-buffer grammar (§9.13): a buffer commits the moment no longer valid number
// could follow; an impossible extension restarts the buffer from the new digit when
// that digit is itself a valid target, else clears it.
export function stepDigits(digits: string, ch: string, max: number): { digits: string; commit?: number } {
  if (!/^[0-9]$/.test(ch)) return { digits };
  for (const candidate of [digits + ch, ch]) {
    const n = Number(candidate);
    if (n >= 1 && n <= max) return n * 10 > max ? { digits: "", commit: n } : { digits: candidate };
  }
  return { digits: "" };
}

/** Feed a typed digit into the shared buffer; returns the committed number, if any. */
export function applyDigit(st: DrillState, ch: string): number | undefined {
  const step = stepDigits(st.digits, ch, st.rows.length);
  st.digits = step.digits;
  const target = step.commit ?? (st.digits ? Number(st.digits) : undefined); // pending previews too
  if (target !== undefined) st.selected = clampIndex(st, target - 1);
  st.host.requestRender();
  return step.commit;
}

/** Commit whatever the buffer holds (enter); returns the number, if valid. */
export function commitDigits(st: DrillState): number | undefined {
  const n = Number(st.digits);
  st.digits = "";
  if (!Number.isInteger(n) || n < 1 || n > st.rows.length) return undefined;
  st.selected = clampIndex(st, n - 1);
  st.host.requestRender();
  return n;
}

function typedDigit(data: string): string | undefined {
  for (let d = 0; d <= 9; d++) if (matchesKey(data, String(d) as KeyId)) return String(d);
  return undefined;
}

// --- the hint bar (replaces the editor while the mode is active) -----------------------

export function openPager(st: DrillState): void {
  if (st.pager) return st.host.requestRender();
  const pager = new DrillPager(st);
  st.pager = pager;
  void st.host.ui
    .custom<undefined>(
      (tui, _theme, _kb, done) => {
        pager.attach(tui);
        st.closePager = () => done(undefined);
        return pager;
      },
      { overlay: true, overlayOptions: () => ({ width: "100%", maxHeight: "100%", anchor: "top-left" }) },
    )
    .catch(() => undefined)
    .finally(() => {
      pager.dispose(); // kitty image ids are pager-scoped terminal state (§9.13)
      if (st.pager === pager) {
        st.pager = undefined;
        st.closePager = undefined;
      }
      st.host.requestRender();
    });
}

class DrillHintBar implements Component {
  private readonly st: DrillState;

  constructor(st: DrillState) {
    this.st = st;
  }

  render(width: number): string[] {
    const st = this.st;
    const theme = st.host.theme();
    const brand = ink(theme, "accent", `${BOLD}[Traceline]${BOLD_OFF}`);
    const pending = st.digits ? `${ink(theme, "dim", SEP)}${ink(theme, "accent", `#${st.digits}`)}` : "";
    const head = `${brand} ${ink(theme, "dim", `drill${SEP}row ${st.selected + 1} of ${st.rows.length}`)}${pending}`;
    const hint = `  ${ink(theme, "dim", `type a number${SEP}enter peek${SEP}p expand${SEP}j/k move${SEP}esc exit`)}`;
    return [truncateToWidth(head, Math.max(1, width), ELLIPSIS), truncateToWidth(hint, Math.max(1, width), ELLIPSIS)];
  }

  handleInput(data: string): void {
    const st = this.st;
    if (matchesKey(data, "escape")) {
      if (st.digits) {
        st.digits = "";
        st.host.requestRender();
        return;
      }
      exitDrillMode();
      return;
    }
    if (matchesKey(data, "enter")) {
      if (st.digits) commitDigits(st);
      openPager(st);
      return;
    }
    if (matchesKey(data, "backspace")) {
      st.digits = st.digits.slice(0, -1);
      st.host.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) return setSelected(st, st.selected + 1); // up = older
    if (matchesKey(data, "down") || matchesKey(data, "j")) return setSelected(st, st.selected - 1);
    if (matchesKey(data, "p")) return togglePin(st);
    const digit = typedDigit(data);
    if (digit !== undefined && applyDigit(st, digit) !== undefined) openPager(st);
  }

  invalidate(): void {}
}

// --- mouse (bounded to the mode; never active in the plain transcript) -----------------

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

function enableMouse(st: DrillState): void {
  if (st.mouseOn) return;
  try {
    process.stdout.write(MOUSE_ENABLE);
  } catch {
    return; // no mouse rather than a broken mode
  }
  st.mouseOn = true;
  if (!g.__tracelineDrillMouseGuard) {
    g.__tracelineDrillMouseGuard = true;
    process.on("exit", () => {
      // A crash mid-mode must not leave the terminal reporting mouse events.
      if (g.__tracelineDrill?.mouseOn) writeIgnoringErrors(MOUSE_DISABLE);
    });
  }
}

function disableMouse(st: DrillState): void {
  if (!st.mouseOn) return;
  st.mouseOn = false;
  writeIgnoringErrors(MOUSE_DISABLE);
}

function writeIgnoringErrors(sequence: string): void {
  try {
    process.stdout.write(sequence);
  } catch {
    // terminal already gone; nothing to restore
  }
}

// The raw terminal-input hook (mouse consumption + foreign-chord exit) lives in
// drill-input.ts; index.ts feeds it traceline's onTerminalInput listener.
