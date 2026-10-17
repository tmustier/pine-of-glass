import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditTool, createWriteTool, createEditToolDefinition, createWriteToolDefinition,
  initTheme, ToolExecutionComponent, type EditToolInput, type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import { assistantBefore } from "../traceline/runtime-fixtures.ts";

initTheme(undefined, false);
// SAFETY: Pi's private row fields satisfy Traceline's structural adapter; this
// contract test exercises that seam through the SDK's real component and renderers.
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);
afterEach(() => trace.setTracelineChat(undefined));

const ui = new TuiMainScreen(new ProcessTerminal());
type Result = Parameters<ToolExecutionComponent["updateResult"]>[0];

// Pi's real edit and write tools run against real files, so each row carries the
// preview Pi draws under its header: the diff, or the first lines of the new file.
function painted(comp: ToolExecutionComponent, result: Result) {
  comp.setArgsComplete();
  comp.markExecutionStarted();
  comp.updateResult(result);
  trace.setTracelineChat({ children: [assistantBefore([comp as unknown as ToolRowLike], [], true), comp] });
  return comp.render(120).map(stripAnsi).filter((line) => line.trim());
}

test("edit and write rows are Pi's header line, never its preview, and read ./ through a symlink (§9.5)", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "traceline-mutation-")));
  // The model names the repo through a symlink (macOS `/tmp` is `/private/tmp`) while
  // Pi's cwd is the resolved folder: the rows still read ./ (§9.5).
  const cwd = join(scratch, "repo"), alias = join(scratch, "alias");
  try {
    mkdirSync(join(cwd, "src"), { recursive: true });
    symlinkSync(cwd, alias);
    writeFileSync(join(cwd, "src/price.ts"), "export const discount = (amount: number, percent: number) =>\n  amount - (amount * percent) / 10;\n");
    const editTool = createEditToolDefinition(cwd);
    const editArgs: EditToolInput = {
      path: join(alias, "src/price.ts"),
      edits: [{ oldText: "(amount * percent) / 10;", newText: "(amount * percent) / 100;" }],
    };
    const editResult = await createEditTool(cwd).execute("edit-1", editArgs);
    const edit = new ToolExecutionComponent("edit", "edit-1", editArgs, {}, editTool, ui, cwd);
    assert.deepEqual(painted(edit, { ...editResult, isError: false }), ["  ▏ › edit ./src/price.ts +1 -1"]);

    const writeTool = createWriteToolDefinition(cwd);
    const writeArgs: WriteToolInput = {
      path: join(alias, "src/receipt.ts"),
      content: "export function receipt() {\n  return \"Total: £0.00\";\n}\n",
    };
    const writeResult = await createWriteTool(cwd).execute("write-1", writeArgs);
    const write = new ToolExecutionComponent("write", "write-1", writeArgs, {}, writeTool, ui, cwd);
    // A write's +N -M needs the live pre-write snapshot (one-line.test.ts covers it);
    // a resumed row has none, so the header stands alone.
    assert.deepEqual(painted(write, { ...writeResult, isError: false }), ["  ▏ › write ./src/receipt.ts"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
