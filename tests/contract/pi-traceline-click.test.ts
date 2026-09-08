import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, ToolExecutionComponent, createReadTool } from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiAltScreen, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { isRevealed, resetRevealedFolds } from "../../extensions/pi-traceline/click.ts";
import { assistantBefore } from "../traceline/runtime-fixtures.ts";

initTheme(undefined, false);
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as ToolRowLike);
afterEach(() => { trace.setTracelineChat(undefined); resetRevealedFolds(); });

function row(name: string, path: string, result = true, shell: "default" | "self" = "default") {
  const definition = {
    ...createReadTool("/tmp"),
    renderShell: shell,
    renderCall: () => new Text(`${name} ${path}`, 0, 0),
    renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(options.expanded ? "OUTPUT\nsecond line" : "preview", 0, 0),
  };
  const comp = new ToolExecutionComponent(name, path, { path }, {}, definition, { requestRender() {} } as never, "/tmp");
  if (result) comp.updateResult({ content: [{ type: "text", text: "OUTPUT" }], isError: false });
  return comp;
}
function seam(comp: ToolExecutionComponent): ToolRowLike { return comp as unknown as ToolRowLike; }
function chat(rows: ToolExecutionComponent[], hidden = true) {
  const container = new Container();
  trace.setTracelineChat({ children: [assistantBefore(rows.map(seam), [], hidden), ...rows] });
  rows.forEach((comp) => container.addChild(comp));
  return container;
}
function event(y: number, x = 10, type: TuiMouseEvent["type"] = "click", width = 80): TuiMouseEvent {
  return { type, button: "left", x, y, screenX: x, screenY: y, width, height: 100, shift: false, alt: false, ctrl: false };
}
function painted(container: Container, width = 80): string[] { return container.render(width).map(trace.stripAnsi); }
function clickLine(container: Container, text: string, x = 10, width = 80) {
  const lines = painted(container, width);
  const y = lines.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, `missing ${text} in ${lines.join("\n")}`);
  return container.handleMouse({ ...event(y, x, "click", width), height: lines.length });
}

test("compact hit areas expand only their call, then native header/output collapse it", () => {
  for (const shell of ["default", "self"] as const) {
    const a = row("read", "/a/a.txt", true, shell);
    const b = row("read", "/b/b.txt", true, shell);
    const c = chat([a, b]);
    assert.ok(clickLine(c, "a.txt")?.handled);
    assert.equal(seam(a).expanded, true);
    assert.equal(seam(b).expanded, false);
    clickLine(c, "b.txt");
    assert.equal(seam(a).expanded, true);
    assert.equal(seam(b).expanded, true);
    clickLine(c, "OUTPUT");
    assert.equal(seam(a).expanded, false);
    clickLine(c, "b.txt");
    assert.equal(seam(b).expanded, false);
  }
});

test("aggregate click reveals members first; glyph refolds the snapshot", () => {
  const a = row("read", "/src/a.txt"), b = row("read", "/src/b.txt");
  const c = chat([a, b]);
  assert.ok(painted(c).some((line) => line.includes("▸") && line.includes("2 calls")));
  clickLine(c, "2 calls");
  assert.equal(seam(a).expanded, false);
  assert.equal(seam(b).expanded, false);
  assert.ok(isRevealed(seam(a)) && isRevealed(seam(b)));
  assert.ok(painted(c).some((line) => line.includes("▾") && line.includes("a.txt")));
  assert.ok(!painted(c).some((line) => line.includes("2 calls")));
  clickLine(c, "b.txt");
  assert.equal(seam(b).expanded, true);
  clickLine(c, "a.txt", 4);
  assert.equal(seam(b).expanded, false);
  assert.ok(painted(c).some((line) => line.includes("2 calls")));
});

test("same-file pages and repeated tool calls also reveal before expansion", () => {
  for (const name of ["read", "lookup"]) {
    const a = row(name, "/src/a.txt"), b = row(name, "/src/a.txt");
    const c = chat([a, b]);
    clickLine(c, name === "read" ? "2 calls" : "×2");
    assert.equal(painted(c).filter((line) => line.includes("a.txt")).length, 2);
    assert.equal(seam(a).expanded, false);
    assert.equal(seam(b).expanded, false);
  }
});

test("wrapped aggregate continuations are clickable; hidden members have no hit area", () => {
  const rows = ["very-long-alpha.txt", "very-long-beta.txt", "very-long-gamma.txt"].map((p) => row("read", `/src/${p}`));
  const c = chat(rows);
  const before = painted(c, 55);
  assert.ok(before.length > 2);
  clickLine(c, "gamma", 14, 55);
  assert.ok(rows.every((r) => isRevealed(seam(r)) && seam(r).expanded === false));
  assert.equal(painted(c, 55).filter((line) => /read /.test(line)).length, 3);
});

test("blank spacing, margins, wheel, press, drag, release and wrong buttons never toggle", () => {
  const a = row("read", "/src/a.txt");
  const c = chat([a]);
  const lines = painted(c);
  for (const e of [event(0), event(1, 0), event(1, 79), { ...event(1, 10, "wheel"), button: "none" as const, wheelDelta: 1 }, ...["press", "drag", "release", "move"].map((type) => event(1, 10, type as TuiMouseEvent["type"])), { ...event(1), button: "right" as const }]) {
    assert.equal(c.handleMouse({ ...e, height: lines.length }), undefined);
    assert.equal(seam(a).expanded, false);
  }
});

test("pending rows wait for a partial result; streaming retains expansion and reveal state", () => {
  const a = row("read", "/src/a.txt", false);
  const c = chat([a]);
  assert.equal(clickLine(c, "a.txt"), undefined);
  a.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
  clickLine(c, "a.txt");
  a.updateResult({ content: [{ type: "text", text: "final" }], isError: false });
  assert.equal(seam(a).expanded, true);
  a.setExpanded(false);
  const b = row("read", "/src/b.txt");
  const pair = chat([a, b]);
  clickLine(pair, "2 calls");
  b.updateResult({ content: [{ type: "text", text: "more" }], isError: false });
  b.invalidate();
  assert.equal(painted(pair).filter((line) => line.includes("read ")).length, 2);
  const later = row("read", "/src/c.txt");
  const triple = chat([a, b, later]);
  assert.equal(painted(triple).filter((line) => line.includes("read ")).length, 3);
  assert.equal(isRevealed(seam(later)), false);
  resetRevealedFolds();
  assert.ok(painted(triple).some((line) => line.includes("3 calls")));
});

test("fullscreen viewport preserves OSC 8 links, selection, overlay ownership and editor focus", () => {
  let input: (data: string) => void = () => {};
  const noop = () => {};
  const terminal: Terminal = {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start: (onInput) => { input = onInput; }, stop: noop, drainInput: async () => {},
    write: noop, moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop,
    clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop,
  };
  class Viewport extends TuiAltScreen { paint() { this.doRender(); } }
  const urls: string[] = [], typed: string[] = [];
  const view = new Viewport(terminal, false, undefined, { openUrl: (url) => urls.push(url), copyOnSelect: false });
  const link = row("lookup", "\x1b]8;;https://example.com\x07example\x1b]8;;\x07");
  const a = row("read", "/solo/a.txt");
  const c = chat([link, a]);
  view.addChild(c);
  view.setFocus({ render: () => [], invalidate() {}, handleInput: (data) => typed.push(data) });
  const mouse = (button: number, x: number, y: number, release = false) => input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
  try {
    view.start(); view.paint();
    const lines = painted(c);
    const y = lines.findIndex((line) => line.includes("example"));
    const x = lines[y]!.indexOf("example") + 2;
    mouse(0, x, y); mouse(0, x, y, true);
    assert.deepEqual(urls, ["https://example.com"]);
    assert.equal(seam(link).expanded, false, "link activation must not expand");
    const ay = lines.findIndex((line) => line.includes("a.txt"));
    const ax = lines[ay]!.indexOf("a.txt");
    mouse(0, ax, ay); mouse(32, ax + 3, ay); mouse(0, ax + 3, ay, true);
    assert.equal(view.hasActiveSelection(), true);
    assert.equal(seam(a).expanded, false);
    mouse(0, ax, ay); mouse(0, ax, ay, true);
    assert.equal(seam(a).expanded, true);
    input("z");
    assert.deepEqual(typed, ["z"], "click must leave keyboard focus alone");
    a.setExpanded(false); view.paint();
    const overlay = view.showOverlay(new Text("modal owns this area\nsecond row\nthird row", 0, 0), { row: 0, col: 0, width: 80 });
    view.paint();
    mouse(0, ax, ay); mouse(0, ax, ay, true);
    assert.equal(seam(a).expanded, false, "overlay must block transcript clicks");
    overlay.hide();
  } finally { view.stop(); }
});

test("native mode keeps Pi mouse behaviour", () => {
  const a = row("read", "/src/a.txt");
  const native = chat([a], false);
  clickLine(native, "preview");
  assert.equal(seam(a).expanded, true);
});
