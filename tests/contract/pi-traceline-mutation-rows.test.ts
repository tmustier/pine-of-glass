import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition, createWriteToolDefinition, initTheme, ToolExecutionComponent,
  type EditToolInput, type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { assistantBefore } from "../traceline/runtime-fixtures.ts";

initTheme(undefined, false);
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);
afterEach(() => trace.setTracelineChat(undefined));

type Definition = ConstructorParameters<typeof ToolExecutionComponent>[4];
type Result = Parameters<ToolExecutionComponent["updateResult"]>[0];

// Pi's real edit and write tools run against real files, so each row carries the
// preview Pi draws under its header: the diff, or the first lines of the new file.
function painted(name: string, cwd: string, args: EditToolInput | WriteToolInput, definition: Definition, result: Result) {
  const comp = new ToolExecutionComponent(name, `${name}-1`, args, {}, definition, { requestRender() {} } as never, cwd);
  comp.setArgsComplete();
  comp.markExecutionStarted();
  comp.updateResult(result);
  trace.setTracelineChat({ children: [assistantBefore([comp as unknown as ToolRowLike], [], true), comp] });
  return comp.render(120).map(trace.stripAnsi).filter((line) => line.trim());
}

test("edit and write rows are Pi's header line, never its preview (§9.5)", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "traceline-mutation-")));
  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/price.ts"), "export const discount = (amount: number, percent: number) =>\n  amount - (amount * percent) / 10;\n");
    const editTool = createEditToolDefinition(cwd);
    const editArgs: EditToolInput = {
      path: join(cwd, "src/price.ts"),
      edits: [{ oldText: "(amount * percent) / 10;", newText: "(amount * percent) / 100;" }],
    };
    const editResult = await editTool.execute("edit-1", editArgs, undefined, undefined, {} as never);
    assert.deepEqual(painted("edit", cwd, editArgs, editTool, { ...editResult, isError: false }), ["  ▏ › edit ./src/price.ts +1 -1"]);

    const writeTool = createWriteToolDefinition(cwd);
    const writeArgs: WriteToolInput = {
      path: join(cwd, "src/receipt.ts"),
      content: "export function receipt() {\n  return \"Total: £0.00\";\n}\n",
    };
    const writeResult = await writeTool.execute("write-1", writeArgs, undefined, undefined, {} as never);
    // A write's +N -M needs the live pre-write snapshot (one-line.test.ts covers it);
    // a resumed row has none, so the header stands alone.
    assert.deepEqual(painted("write", cwd, writeArgs, writeTool, { ...writeResult, isError: false }), ["  ▏ › write ./src/receipt.ts"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
