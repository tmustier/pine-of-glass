// SGR parameter filtering: recolouring without nuking bold/underline.
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-traceline/index.ts";

const { stripSgrForegrounds, stripSgrBackgrounds } = internals;

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
