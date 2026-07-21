// Drill mode (design language §9.13): digit grammar, zero-reflow numbering, expanded-row
// (§9.12 z1) grammar opt-outs, and the full hint-bar → pager keyboard flow against a
// fake ExtensionUIContext. Comps are the same synthetic duck types the other suites
// use; the contract suite proves the duck type (including the expanded flag and the
// blank leading spacer line of a native render) matches the real installed pi.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { internals } from "../../extensions/pi-traceline/index.ts";
import {
  drillDecorateNativeRow,
  drillState,
  drillTracePrefix,
  enterDrillMode,
  exitDrillMode,
  stepDigits,
  type DrillHost,
} from "../../extensions/pi-traceline/drill.ts";
import { handleDrillTerminalInput, isForeignChord, wheelDelta } from "../../extensions/pi-traceline/drill-input.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";

const { foldedReadLines, isExpandedToolRow, leadingBlank, oneLine, readRun, renderTraceRow, setTracelineChat, statusTone, stripAnsi } = internals;

function toolComp(overrides: Partial<ToolRowLike> = {}): ToolRowLike {
  const args = overrides.args ?? { path: "/tmp/demo/file.ts", offset: 1, limit: 40 };
  return {
    toolName: "read",
    result: { content: [{ type: "text", text: "x".repeat(1437) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded(expanded: boolean) {
      (this as { expanded?: boolean }).expanded = expanded;
    },
    callRendererComponent: { render: () => [`read ${String(args.path)}:1-40`] },
    ...overrides,
    args,
  } as ToolRowLike;
}

type FakeComponent = { render(width: number): string[]; handleInput?(data: string): void };
type CustomCall = { component: FakeComponent; overlay: boolean };

function fakeUiContext(calls: CustomCall[], notifications: string[]): ExtensionUIContext {
  return {
    custom<T>(
      factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
      options?: { overlay?: boolean },
    ): Promise<T> {
      return new Promise<T>((resolve) => {
        const component = factory({ terminal: { rows: 16, columns: 80 } }, undefined, undefined, resolve);
        calls.push({ component: component as FakeComponent, overlay: options?.overlay === true });
      });
    },
    notify(message: string) {
      notifications.push(message);
    },
  } as unknown as ExtensionUIContext;
}

function makeHost(children: unknown[], calls: CustomCall[] = [], notifications: string[] = []): DrillHost {
  setTracelineChat({ children });
  return {
    ui: fakeUiContext(calls, notifications),
    theme: () => undefined,
    chatChildren: () => children,
    requestRender: () => {},
    traceLines: (comp, width) => {
      const run = readRun(comp);
      return run && run.index === 0 ? foldedReadLines(run.rows, width) : [oneLine(comp, width)];
    },
    runRows: (comp) => {
      const run = readRun(comp);
      return run && run.index === 0 ? run.rows : undefined;
    },
    hiddenByFold: (comp) => (readRun(comp)?.index ?? 0) > 0,
    statusTone: (comp) => statusTone(comp),
    mouse: false,
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  exitDrillMode();
  setTracelineChat(undefined);
});
afterEach(() => {
  exitDrillMode();
  setTracelineChat(undefined);
});

// --- digit grammar ----------------------------------------------------------------------

test("stepDigits: commits when no longer number could follow, else stays pending", () => {
  assert.deepEqual(stepDigits("", "5", 37), { digits: "", commit: 5 }); // 50 > 37
  assert.deepEqual(stepDigits("", "1", 37), { digits: "1" }); // 1, 1x both possible
  assert.deepEqual(stepDigits("1", "2", 37), { digits: "", commit: 12 });
  assert.deepEqual(stepDigits("", "1", 9), { digits: "", commit: 1 }); // single-digit block
});

test("stepDigits: zero and impossible extensions restart or clear the buffer", () => {
  assert.deepEqual(stepDigits("", "0", 37), { digits: "" });
  assert.deepEqual(stepDigits("3", "9", 37), { digits: "", commit: 9 }); // 39 invalid → restart at 9
  assert.deepEqual(stepDigits("1", "8", 200), { digits: "18" }); // 18, 18x both possible
  assert.deepEqual(stepDigits("1", "8", 120), { digits: "", commit: 18 }); // no 18x fits under 120
  assert.deepEqual(stepDigits("", "7", 5), { digits: "" }); // no valid reading at all
});

// --- numbering: zero reflow -------------------------------------------------------------

test("drill numbering re-inks the six-column prefix at identical width", () => {
  const rows = [toolComp(), toolComp({ args: { path: "/tmp/elsewhere/other.ts" } })];
  const host = makeHost(rows);
  const before = renderTraceRow(rows[1]!, 80);
  enterDrillMode(host);
  const after = renderTraceRow(rows[1]!, 80);

  assert.equal(after.length, before.length, "numbering must not change a row's line count");
  const beforeLine = stripAnsi(before[before.length - 1]!);
  const afterLine = stripAnsi(after[after.length - 1]!);
  assert.equal(afterLine.length, beforeLine.length, "numbering must not change a row's width");
  assert.match(afterLine, /^ {2}1 › /, "newest row wears number 1 in the rail cell");
  assert.equal(afterLine.slice(6), beforeLine.slice(6), "body and suffix untouched beyond the prefix");
});

test("selection wears accent bold; other numbers are dim; strangers keep the rail", () => {
  const rows = [toolComp({ args: { path: "/tmp/aaa/a.ts" } }), toolComp({ args: { path: "/tmp/bbb/b.ts" } })];
  enterDrillMode(makeHost(rows));
  const selected = drillTracePrefix(undefined, rows[1], "›")!; // rows[1] is newest = number 1 = selected
  const other = drillTracePrefix(undefined, rows[0], "›")!;
  assert.ok(selected.includes("\x1b[1m"), "selected number must be bold");
  assert.ok(!other.includes("\x1b[1m"), "unselected numbers stay dim, not bold");
  assert.equal(visibleWidth(selected), 6, "drill prefix must hold the rail prefix's six columns");
  assert.equal(visibleWidth(other), 6);
  assert.equal(stripAnsi(other), "  2 › ");
  assert.equal(drillTracePrefix(undefined, toolComp(), "›"), undefined, "rows streamed in after entry stay unnumbered");
});

test("numbers above 999 keep the rail; outside the mode the prefix is untouched", () => {
  const rows = [toolComp()];
  enterDrillMode(makeHost(rows));
  drillState()!.numbers.set(rows[0], 1000);
  assert.equal(drillTracePrefix(undefined, rows[0], "›"), undefined);
  exitDrillMode();
  assert.equal(drillTracePrefix(undefined, rows[0], "›"), undefined);
});

test("drillDecorateNativeRow numbers only a genuinely blank leading spacer line", () => {
  const rows = [toolComp()];
  enterDrillMode(makeHost(rows));
  const decorated = drillDecorateNativeRow(undefined, rows[0], ["", "read file", "output"], "›") as string[];
  assert.equal(stripAnsi(decorated[0]!).trim(), "1 ›", "blank spacer line takes the number cell");
  assert.deepEqual(decorated.slice(1), ["read file", "output"], "native lines below stay untouched");
  const untouched = ["not blank", "output"];
  assert.equal(drillDecorateNativeRow(undefined, rows[0], untouched, "›"), untouched, "non-blank first line passes through");
  assert.deepEqual(drillDecorateNativeRow(undefined, toolComp(), ["", "x"], "›"), ["", "x"], "strangers pass through unnumbered");
});

// --- expanded rows (§9.12 z1) opt out of trace-block grammar ----------------------------

test("an expanded read never folds, and a trace block after it starts with a blank", () => {
  const page1 = toolComp({ args: { path: "/tmp/demo/file.ts", offset: 1, limit: 200 } });
  const page2 = toolComp({ args: { path: "/tmp/demo/file.ts", offset: 201, limit: 200 } });
  setTracelineChat({ children: [page1, page2] });
  assert.ok(readRun(page2), "sanity: adjacent same-file reads fold");

  page2.setExpanded(true);
  assert.equal(isExpandedToolRow(page2), true);
  assert.equal(readRun(page2), undefined, "an expanded row must leave the read run");
  assert.equal(readRun(page1), undefined, "a one-row remainder is no run at all");

  const after = toolComp({ args: { path: "/tmp/demo/zeta.ts" } });
  setTracelineChat({ children: [page1, page2, after] });
  assert.equal(leadingBlank(after), true, "a trace block after an expanded row starts with its own blank");
  page2.setExpanded(false);
  assert.equal(leadingBlank(after), false, "collapsing back restores the tight group");
});

// --- the mode end to end -----------------------------------------------------------------

test("drill flow: enter, digit auto-commit to pager, h/l switch, esc unwinds", async () => {
  // one directory per row: sibling reads in one dir would fold into a single target (§9.9)
  const rows = Array.from({ length: 12 }, (_, i) => toolComp({ args: { path: `/tmp/d${i}/f${i}.ts` } }));
  const calls: CustomCall[] = [];
  const notifications: string[] = [];
  const host = makeHost(rows, calls, notifications);

  enterDrillMode(host);
  assert.ok(drillState(), "mode state installed");
  assert.equal(calls.length, 1, "hint bar replaces the editor");
  assert.equal(calls[0]!.overlay, false);
  enterDrillMode(host);
  assert.equal(calls.length, 1, "re-entry is a no-op while active");

  const hint = calls[0]!.component;
  const hintLines = hint.render(80);
  assert.equal(hintLines.length, 2, "hint bar is exactly two lines");
  assert.match(stripAnsi(hintLines[0]!), /\[Traceline\] drill · row 1 of 12/);

  hint.handleInput!("k"); // older
  assert.equal(drillState()!.selected, 1);
  hint.handleInput!("j"); // newer
  assert.equal(drillState()!.selected, 0);

  hint.handleInput!("1"); // 1 pending: 10-12 still possible
  assert.equal(drillState()!.digits, "1");
  assert.equal(calls.length, 1, "pending digit must not open the pager");
  hint.handleInput!("0"); // 10 commits: 100 > 12
  assert.equal(calls.length, 2, "committed number opens the pager");
  assert.equal(calls[1]!.overlay, true, "pager rides the overlay path");
  assert.equal(drillState()!.selected, 9);

  const pager = calls[1]!.component;
  const pagerLines = pager.render(80);
  assert.equal(pagerLines.length, 16, "pager fills the full terminal height");
  assert.match(stripAnsi(pagerLines[0]!), /\[Traceline\] peek · row 10 of 12/);
  const pagerText = pagerLines.map((line) => stripAnsi(line)).join("\n");
  assert.match(pagerText, /read \/tmp\/d2\/f2\.ts:1-40/, "invocation section shows the call renderer's line");
  assert.match(pagerText, /result · success · 1\.4k ch/, "result label carries status and size");
  assert.match(pagerText, /xxxx/, "result text is present");

  pager.handleInput!("h"); // older without closing
  assert.match(stripAnsi(pager.render(80)[0]!), /row 11 of 12/);
  pager.handleInput!("l");
  assert.match(stripAnsi(pager.render(80)[0]!), /row 10 of 12/);

  pager.handleInput!("\x1b"); // esc closes the pager only
  await settle();
  assert.ok(drillState(), "mode survives closing the pager");
  assert.equal(drillState()!.pager, undefined);

  hint.handleInput!("\x1b"); // esc exits the mode
  await settle();
  assert.equal(drillState(), undefined, "esc tears the mode down");
  assert.deepEqual(notifications, []);
});

test("drill refuses an empty transcript with a notify instead of a dead mode", () => {
  const calls: CustomCall[] = [];
  const notifications: string[] = [];
  enterDrillMode(makeHost([], calls, notifications));
  assert.equal(drillState(), undefined);
  assert.equal(calls.length, 0);
  assert.equal(notifications.length, 1);
});

test("p toggles the selected row's expansion in place", () => {
  const rows = [toolComp()];
  const calls: CustomCall[] = [];
  enterDrillMode(makeHost(rows, calls));
  const hint = calls[0]!.component;
  hint.handleInput!("p");
  assert.equal(rows[0]!.expanded, true, "pin writes pi's own expanded flag");
  hint.handleInput!("p");
  assert.equal(rows[0]!.expanded, false);
});

test("a folded read run is one numbered target", () => {
  const page1 = toolComp({ args: { path: "/tmp/demo/file.ts", offset: 1, limit: 200 } });
  const page2 = toolComp({ args: { path: "/tmp/demo/file.ts", offset: 201, limit: 200 } });
  const other = toolComp({ args: { path: "/tmp/other-dir/other.ts" } });
  enterDrillMode(makeHost([page1, page2, other]));
  const st = drillState()!;
  assert.equal(st.rows.length, 2, "the fold collapses to one target");
  assert.equal(st.rows[0], other, "newest row is number 1");
  assert.equal(st.rows[1], page1, "the fold's carrier (its first row) is the target");
  exitDrillMode();

  // §9.9's sibling-file dir fold is also one target, carried by its first row.
  const sibling = toolComp({ args: { path: "/tmp/demo/sibling.ts" } });
  enterDrillMode(makeHost([page1, page2, sibling]));
  const dirFold = drillState()!;
  assert.equal(dirFold.rows.length, 1, "a sibling dir fold is one target");
  assert.equal(dirFold.rows[0], page1, "the dir fold's carrier is its first row");
});

// --- mouse -------------------------------------------------------------------------------

test("wheelDelta reads SGR wheel presses and ignores releases and buttons", () => {
  assert.equal(wheelDelta("\x1b[<64;10;5M"), -1); // wheel up
  assert.equal(wheelDelta("\x1b[<65;10;5M\x1b[<65;10;5M"), 2); // two wheel downs
  assert.equal(wheelDelta("\x1b[<0;10;5M\x1b[<0;10;5m"), 0); // click press+release
  assert.equal(wheelDelta("\x1b[<68;10;5M"), -1); // shift+wheel up still scrolls
});

test("terminal-input hook consumes all mouse reports while active, none outside", () => {
  assert.equal(handleDrillTerminalInput("\x1b[<64;1;1M"), undefined, "inactive: nothing consumed");
  const rows = [toolComp({ args: { path: "/tmp/aaa/a.ts" } }), toolComp({ args: { path: "/tmp/bbb/b.ts" } })];
  enterDrillMode(makeHost(rows));
  assert.equal(drillState()!.selected, 0);
  assert.deepEqual(handleDrillTerminalInput("\x1b[<64;1;1M"), { consume: true });
  assert.equal(drillState()!.selected, 1, "wheel up walks to the older row");
  assert.deepEqual(handleDrillTerminalInput("\x1b[<0;3;3M"), { consume: true }, "clicks are swallowed, not leaked");
  assert.equal(handleDrillTerminalInput("plain keys"), undefined, "keyboard input passes through");
});

// --- foreign chords (§9.13: the mode never silently eats an app-level keystroke) --------

test("isForeignChord: modifier chords only, presses only", () => {
  assert.equal(isForeignChord("\x1b[1;3A"), true, "alt+up is foreign");
  assert.equal(isForeignChord("\x1b\r"), true, "alt+enter is foreign");
  assert.equal(isForeignChord("\x03"), true, "ctrl+c is foreign — abort must not die in the mode");
  assert.equal(isForeignChord("\x1bt"), true, "the entry chord is foreign too: it re-freezes via its shortcut");
  assert.equal(isForeignChord("\x1b[1;3:3A"), false, "a key release never exits");
  for (const own of ["\x1b", "\r", "k", "j", "p", "5", "G", " ", "\x7f", "\x1b[A", "\x1b[5~"]) {
    assert.equal(isForeignChord(own), false, `mode-owned or plain key treated as foreign: ${JSON.stringify(own)}`);
  }
});

test("a foreign chord exits the mode synchronously and is not consumed", () => {
  const rows = [toolComp({ args: { path: "/tmp/aaa/a.ts" } }), toolComp({ args: { path: "/tmp/bbb/b.ts" } })];
  enterDrillMode(makeHost(rows));
  assert.equal(handleDrillTerminalInput("5"), undefined);
  assert.ok(drillState(), "the mode's own keys must not exit");
  assert.equal(handleDrillTerminalInput("\x1b"), undefined);
  assert.ok(drillState(), "esc belongs to the hint bar, not the hook");
  assert.equal(handleDrillTerminalInput("\x1b[1;3A"), undefined, "the chord must flow on to the restored editor");
  // Synchronous on purpose: pi dispatches this same keystroke to the focused component
  // right after the listener returns, so the editor must already be restored.
  assert.equal(drillState(), undefined, "exit must complete before the hook returns");
});

test("a foreign chord exits from the pager too", () => {
  const rows = Array.from({ length: 3 }, (_, i) => toolComp({ args: { path: `/tmp/d${i}/f${i}.ts` } }));
  const calls: CustomCall[] = [];
  enterDrillMode(makeHost(rows, calls));
  calls[0]!.component.handleInput!("3");
  assert.ok(drillState()!.pager, "sanity: a committed digit opened the pager");
  assert.equal(handleDrillTerminalInput("\x1b[1;3A"), undefined);
  assert.equal(drillState(), undefined, "the chord ends the whole mode, pager included");
});
