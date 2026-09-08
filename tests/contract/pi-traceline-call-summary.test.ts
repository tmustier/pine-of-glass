import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createReadTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { assistantBefore } from "../traceline/runtime-fixtures.ts";

initTheme(undefined, false);
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);
afterEach(() => trace.setTracelineChat(undefined));

let nextCallId = 0;
function row(call: string, state: "success" | "running" | "error" = "success") {
  const definition = {
    ...createReadTool("/tmp"), name: "custom_action",
    renderCall: () => new Text(call, 0, 0),
    renderResult: () => new Text("SECRET_OUTPUT", 0, 0),
  };
  const comp = new ToolExecutionComponent("custom_action", `call-${nextCallId++}`, {}, {}, definition, { requestRender() {} } as never, "/tmp");
  if (state !== "running") comp.updateResult({ content: [{ type: "text", text: "SECRET_OUTPUT" }], isError: state === "error" });
  trace.setTracelineChat({ children: [assistantBefore([comp as unknown as ToolRowLike], [], true), comp] });
  return comp;
}
function painted(comp: ToolExecutionComponent, width = 100) {
  return comp.render(width).map(trace.stripAnsi).filter((line) => line.trim());
}

test("status-only call headers retain their command for every execution state", () => {
  for (const state of ["success", "running", "error"] as const) {
    const verb = state === "running" ? "Running" : "Ran";
    assert.deepEqual(painted(row(`• ${verb}\n  └ surf tabs.list`, state)), [`  ▏ › ${verb} · surf tabs.list`]);
  }
});

test("code and exploration calls retain every non-empty call line, not results", () => {
  assert.deepEqual(painted(row("• Ran code\n  const tab = 1;\n\n  await inspect(tab);\n  └ browser")), [
    "  ▏ › Ran code · const tab = 1; · await inspect(tab); · browser",
  ]);
  assert.deepEqual(painted(row("• Explored\n  ├ Read file.ts\n  └ Search keyword")), [
    "  ▏ › Explored · Read file.ts · Search keyword",
  ]);
});

test("matching headers do not fold different underlying invocations together", () => {
  const a = row("• Ran\n  └ surf tabs.list"), b = row("• Ran\n  └ surf tabs.close");
  const rows = [a, b];
  trace.setTracelineChat({ children: [assistantBefore(rows as unknown as ToolRowLike[], [], true), ...rows] });
  assert.deepEqual(painted(a), ["  ▏ › Ran · surf tabs.list"]);
  assert.deepEqual(painted(b), ["  ▏ › Ran · surf tabs.close"]);
});

test("continuation styling survives removal of indentation and tree markers", () => {
  const comp = row("• Ran\n\x1b[36m  └ surf tabs.list\x1b[39m");
  const lines = comp.render(100);
  assert.ok(lines.some((line) => line.includes("\x1b[36msurf tabs.list\x1b[39m")));
  assert.deepEqual(painted(comp), ["  ▏ › Ran · surf tabs.list"]);
});

test("single-line calls keep their presentation and narrow summaries retain the tail", () => {
  assert.deepEqual(painted(row("• Lookup customer")), ["  ▏ › Lookup customer"]);
  const comp = row(`• Ran\n  └ ${"long-command ".repeat(15)}FINAL_ARGUMENT`);
  for (let width = 1; width <= 100; width++) {
    assert.ok(comp.render(width).every((line) => visibleWidth(line) <= width));
  }
  assert.match(painted(comp, 50)[0]!, /Ran.*….*FINAL_ARGUMENT$/);
});

test("clicking a flattened summary still opens native multiline call and result", () => {
  const comp = row("• Ran\n  └ surf tabs.list");
  const compact = comp.render(100);
  const y = compact.findIndex((line) => trace.stripAnsi(line).includes("surf tabs.list"));
  assert.ok(y >= 0);
  assert.ok(comp.handleMouse({
    type: "click", button: "left", x: 12, y, screenX: 12, screenY: y,
    width: 100, height: compact.length, shift: false, alt: false, ctrl: false,
  })?.handled);
  const expanded = painted(comp);
  assert.ok(expanded.some((line) => line.includes("└ surf tabs.list")));
  assert.ok(expanded.some((line) => line.includes("SECRET_OUTPUT")));
  comp.setExpanded(false);
  assert.deepEqual(painted(comp), ["  ▏ › Ran · surf tabs.list"]);
});
