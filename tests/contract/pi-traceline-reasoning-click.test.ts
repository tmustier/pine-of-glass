import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantRowPrototypeLike } from "../../extensions/_lib/chat.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";
import { assistantMessage } from "../helpers.ts";

initTheme(undefined, false);
trace.patchAssistantRowPrototype(AssistantMessageComponent.prototype as unknown as AssistantRowPrototypeLike);

function event(y: number, x = 3, type: TuiMouseEvent["type"] = "click", width = 80): TuiMouseEvent {
  return { type, button: "left", x, y, screenX: x, screenY: y, width, height: 100, shift: false, alt: false, ctrl: false };
}

function painted(comp: AssistantMessageComponent, width = 80): string[] {
  return comp.render(width).map((line) => trace.stripAnsi(line).trimEnd());
}

function clickText(comp: AssistantMessageComponent, text: string, width = 80) {
  const lines = painted(comp, width);
  const y = lines.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, `missing ${text} in ${lines.join("\n")}`);
  return comp.handleMouse({ ...event(y, lines[y]!.indexOf(text), "click", width), height: lines.length });
}

test("compact reasoning previews keep Pi's run-level click state and independent expansion", () => {
  const comp = new AssistantMessageComponent(assistantMessage([
    { type: "thinking", thinking: "first block\nnewest first detail" },
    { type: "thinking", thinking: "second adjacent block" },
    { type: "text", text: "visible bridge" },
    { type: "thinking", thinking: "independent final run\nfinal detail" },
  ]), true);

  assert.deepEqual(painted(comp).map((line) => line.trim()), [
    "", "first block · newest first detail · second adjacent block", "", "visible bridge", "independent final run · final detail",
  ]);
  assert.ok(clickText(comp, "first block")?.handled);
  const firstExpanded = painted(comp).map((line) => line.trim());
  assert.deepEqual(firstExpanded.slice(1, 4), ["first block", "newest first detail", ""]);
  assert.ok(firstExpanded.includes("second adjacent block"), "adjacent provider blocks remain one native reasoning run");
  assert.ok(firstExpanded.includes("independent final run · final detail"), "another run stays compact");

  assert.ok(clickText(comp, "independent final run")?.handled);
  assert.ok(painted(comp).some((line) => line.trim() === "first block"));
  assert.ok(painted(comp).some((line) => line.trim() === "final detail"));
  assert.ok(clickText(comp, "first block")?.handled);
  assert.ok(painted(comp).some((line) => line.includes("first block · newest first detail")));
  assert.ok(painted(comp).some((line) => line.trim() === "final detail"));
});

test("streaming rebuilds compact geometry while Ctrl+T clears native overrides", () => {
  const comp = new AssistantMessageComponent(assistantMessage([
    { type: "thinking", thinking: "stream starts" },
  ]), true);
  clickText(comp, "stream starts");
  comp.updateContent(assistantMessage([{ type: "thinking", thinking: "stream starts\nthen grows" }]), true);
  assert.deepEqual(painted(comp).map((line) => line.trim()), ["", "stream starts", "then grows"]);

  comp.setHideThinkingBlock(true);
  assert.deepEqual(painted(comp).map((line) => line.trim()), ["", "stream starts · then grows"]);
  comp.setHideThinkingBlock(false);
  assert.deepEqual(painted(comp).map((line) => line.trim()), ["", "stream starts", "then grows"]);
  comp.setHideThinkingBlock(true);
  assert.ok(clickText(comp, "stream starts · then grows")?.handled);
});

test("visible streaming reasoning does not render unused previews", (t) => {
  const render = t.mock.method(Markdown.prototype, "render");
  const comp = new AssistantMessageComponent(assistantMessage([
    { type: "thinking", thinking: "visible first line\nvisible second line" },
  ]), false);
  painted(comp);
  comp.updateContent(assistantMessage([
    { type: "thinking", thinking: "visible first line\nvisible second line\nnew streamed line" },
  ]), true);
  painted(comp);
  assert.ok(render.mock.callCount() > 0);
  assert.ok(render.mock.calls.every((call) => call.arguments[0] <= 80), "visible reasoning must render only at viewport width");
});

test("compact previews preserve native width and ignore non-click gestures", () => {
  const comp = new AssistantMessageComponent(assistantMessage([
    { type: "thinking", thinking: "opening thought\nintermediate detail that should be cut\nnewest thought" },
  ]), true);
  const lines = painted(comp, 42);
  assert.match(lines[1]!, /^ opening.*….*newest thought$/);
  for (const type of ["press", "move", "drag", "release"] as const) {
    assert.equal(comp.handleMouse({
      ...event(1, 5, type, 42), button: type === "move" ? "none" : "left", height: lines.length,
    }), undefined);
  }
  assert.equal(painted(comp, 42).length, 2);
});

test("expanded reasoning keeps Pi links and drag selection ahead of collapse", () => {
  const { view, urls, mouse } = mouseViewport();
  const comp = new AssistantMessageComponent(assistantMessage([
    { type: "thinking", thinking: "[example](https://example.com) rationale\nanother detail" },
  ]), true);
  assert.ok(clickText(comp, "example rationale")?.handled);
  view.addChild(comp);

  try {
    view.start(); view.paint();
    const lines = painted(comp);
    const y = lines.findIndex((line) => line.includes("example"));
    const x = lines[y]!.indexOf("example") + 2;
    mouse(0, x, y); mouse(0, x, y, true);
    assert.deepEqual(urls, ["https://example.com"]);
    assert.ok(painted(comp).some((line) => line.trim() === "another detail"), "link activation must not collapse");

    const rx = lines[y]!.indexOf("rationale");
    mouse(0, rx, y); mouse(32, rx + 4, y); mouse(0, rx + 4, y, true);
    assert.equal(view.hasActiveSelection(), true);
    assert.ok(painted(comp).some((line) => line.trim() === "another detail"), "selection must not collapse");
  } finally {
    view.stop();
  }
});
