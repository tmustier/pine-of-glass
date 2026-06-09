// SGR parameter filtering (recolouring without nuking bold/underline) and SGR mouse
// event parsing (wheel/release/modifier clicks must never count as a row click).
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-traceline/index.ts";

const { stripSgrForegrounds, stripSgrBackgrounds, parseSgrMouse, isLeftMousePress } = internals;

test("foreground stripping drops colour params but keeps text attributes", () => {
  assert.equal(stripSgrForegrounds("\x1b[1;31mX\x1b[0m"), "\x1b[1mX\x1b[0m");
  assert.equal(stripSgrForegrounds("\x1b[38;2;10;20;30mX"), "X");
  assert.equal(stripSgrForegrounds("\x1b[38;5;100mX"), "X");
  assert.equal(stripSgrForegrounds("\x1b[4;39;97mX"), "\x1b[4mX");
  assert.equal(stripSgrForegrounds("\x1b[90mX"), "X");
  // Background params survive a foreground strip.
  assert.equal(stripSgrForegrounds("\x1b[31;48;5;2mX"), "\x1b[48;5;2mX");
});

test("background stripping drops bg params but keeps fg and attributes", () => {
  assert.equal(stripSgrBackgrounds("\x1b[48;2;1;2;3mX"), "X");
  assert.equal(stripSgrBackgrounds("\x1b[48;5;7mX"), "X");
  assert.equal(stripSgrBackgrounds("\x1b[41mX"), "X");
  assert.equal(stripSgrBackgrounds("\x1b[100mX"), "X");
  assert.equal(stripSgrBackgrounds("\x1b[49mX"), "X");
  assert.equal(stripSgrBackgrounds("\x1b[1;31;41mX"), "\x1b[1;31mX");
});

test("bare reset escape is normalized, not dropped", () => {
  // \x1b[m means reset; filtering must keep the reset semantics.
  assert.equal(stripSgrForegrounds("\x1b[mX"), "\x1b[0mX");
});

test("SGR mouse parsing accepts exactly well-formed events", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;10;5M"), { code: 0, col: 10, row: 5, isPress: true });
  assert.deepEqual(parseSgrMouse("\x1b[<0;10;5m"), { code: 0, col: 10, row: 5, isPress: false });
  assert.equal(parseSgrMouse("\x1b[<0;10M"), undefined);
  assert.equal(parseSgrMouse("garbage"), undefined);
  assert.equal(parseSgrMouse("\x1b[<0;10;5Mtrailing"), undefined);
});

test("only a plain left-button press counts as a click", () => {
  assert.equal(isLeftMousePress(parseSgrMouse("\x1b[<0;1;1M")!), true);
  assert.equal(isLeftMousePress(parseSgrMouse("\x1b[<0;1;1m")!), false, "release is not a click");
  assert.equal(isLeftMousePress(parseSgrMouse("\x1b[<64;1;1M")!), false, "wheel up is not a click");
  assert.equal(isLeftMousePress(parseSgrMouse("\x1b[<65;1;1M")!), false, "wheel down is not a click");
  assert.equal(isLeftMousePress(parseSgrMouse("\x1b[<2;1;1M")!), false, "right button is not a click");
  assert.equal(isLeftMousePress(parseSgrMouse("\x1b[<1;1;1M")!), false, "middle button is not a click");
});
