// Suppressing pi's Ctrl+T status line (design language §12.24): the dim
// "Thinking blocks: hidden/visible" Spacer + Text pair pi appends to the chat tail is
// dropped before it renders — the toggle is self-evident under traceline — while every
// other showStatus message passes through untouched. Comps here are synthetic
// stand-ins satisfying the duck types; the contract suite proves the duck types match
// the real pi-tui Text/Spacer and the real showStatus tail shape.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-traceline/index.ts";

const { isThinkingToggleStatusRow, isSpacerRow, suppressThinkingToggleStatus } = internals;

const g = globalThis as Record<string, unknown>;

function statusText(text: string) {
  return { text: `\x1b[90m${text}\x1b[0m`, setText: () => {}, render: () => [] };
}

function spacer() {
  return { lines: 1, setLines: () => {}, render: () => [""] };
}

function prose() {
  return { render: () => ["some assistant prose"] };
}

beforeEach(() => {
  g.__tracelineChat = undefined;
});

test("duck types: pi's status Text and Spacer match; neighbours do not", () => {
  assert.equal(isThinkingToggleStatusRow(statusText("Thinking blocks: hidden")), true);
  assert.equal(isThinkingToggleStatusRow(statusText("Thinking blocks: visible")), true);
  assert.equal(isThinkingToggleStatusRow(statusText("  Thinking blocks: hidden  ")), true);
  // Only the exact toggle caption matches — other statuses announce invisible actions.
  assert.equal(isThinkingToggleStatusRow(statusText("Forked to new session")), false);
  assert.equal(isThinkingToggleStatusRow(statusText("Thinking blocks: hidden today")), false);
  assert.equal(isThinkingToggleStatusRow(prose()), false);
  assert.equal(isThinkingToggleStatusRow(undefined), false);

  assert.equal(isSpacerRow(spacer()), true);
  assert.equal(isSpacerRow(statusText("Thinking blocks: hidden")), false);
  assert.equal(isSpacerRow(prose()), false);
});

test("drops the trailing Spacer + Text pair pi's toggle appends", () => {
  const keep = prose();
  const children = [keep, spacer(), statusText("Thinking blocks: hidden")];
  g.__tracelineChat = { children };
  suppressThinkingToggleStatus();
  assert.deepEqual(children, [keep], "status pair must be removed from the chat tail");
});

test("removes only its own Spacer: a non-spacer neighbour survives", () => {
  const keep = prose();
  const children = [keep, statusText("Thinking blocks: visible")];
  g.__tracelineChat = { children };
  suppressThinkingToggleStatus();
  assert.deepEqual(children, [keep], "status text removed; the prose before it must not be eaten as a spacer");
});

test("leaves other statuses and non-tail matches alone", () => {
  const other = [prose(), spacer(), statusText("Forked to new session")];
  g.__tracelineChat = { children: [...other] };
  suppressThinkingToggleStatus();
  assert.equal((g.__tracelineChat as { children: unknown[] }).children.length, 3, "other statuses pass through");

  // A stale match not at the tail is history, not the fresh announcement.
  const buried = [spacer(), statusText("Thinking blocks: hidden"), prose()];
  g.__tracelineChat = { children: [...buried] };
  suppressThinkingToggleStatus();
  assert.equal((g.__tracelineChat as { children: unknown[] }).children.length, 3, "non-tail matches untouched");

  g.__tracelineChat = { children: [] };
  suppressThinkingToggleStatus(); // empty chat: no throw
  g.__tracelineChat = undefined;
  suppressThinkingToggleStatus(); // no chat container yet: no throw
});
