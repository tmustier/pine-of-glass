// Shared harness for the composed-call suites (design language §9.14): real Pi
// ToolExecutionComponents hosting codemode rows, mounted under a traceline extension
// with a mouse viewport, so the suites exercise the SDK component output.
import assert from "node:assert/strict";

import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";

import piTraceline from "../../extensions/pi-traceline/index.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import type { JsonObject } from "../../extensions/_lib/boundary.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, RecordedUi, type HostedExtension } from "../harness/extension-host.ts";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";
import { composedCall, type NestedFixture, type ComposedOptions } from "./runtime-fixtures.ts";

export const ENOENT = "ENOENT: no such file or directory, access '/x/README.md'";

export class ComposedHarness {
  project = new IsolatedProject();
  cwd = this.project.dir;
  viewport = mouseViewport();
  chat = new Container();
  hosted: HostedExtension | undefined;
  toolCalls = new Map<ToolExecutionComponent, ToolCall>();

  constructor() {
    initTheme(undefined, false);
    this.viewport.view.addChild(this.chat);
  }

  // Pi's streamed preview and persisted arguments are distinct records. The contract
  // suite runs codemode itself; these rows exercise their visible SDK component output.
  composedRow(nested: NestedFixture[], options: ComposedOptions = {}): ToolExecutionComponent {
    const id = `composed-${this.toolCalls.size}`;
    const { args, result } = composedCall(id, nested, options);
    const row = new ToolExecutionComponent("codemode", id, args, {}, undefined, this.viewport.view, options.cwd ?? this.project.dir);
    this.toolCalls.set(row, { type: "toolCall", id, name: "codemode", arguments: args });
    row.updateResult(result, options.running === true);
    return row;
  }

  reads(paths: string[]): NestedFixture[] {
    return paths.map((path) => ({ name: "read", args: { path: `${this.cwd}/${path}` } }));
  }

  async mount(rows: ToolExecutionComponent[], config?: JsonObject): Promise<void> {
    if (config) this.project.writeProjectConfig("pi-traceline", config);
    this.chat.addChild(new AssistantMessageComponent(assistantMessage(rows.map((row) => this.toolCalls.get(row)!)), true));
    for (const row of rows) this.chat.addChild(row);
    this.hosted = await hostExtension(piTraceline, { project: this.project, ui: new RecordedUi(undefined, this.viewport.view) });
  }

  /** Emit a nested tool event through the hosted extension runner, as Pi would. */
  async emit(event: Parameters<HostedExtension["session"]["extensionRunner"]["emit"]>[0]): Promise<void> {
    await this.hosted!.session.extensionRunner.emit(event);
  }

  async dispose(): Promise<void> {
    try { await this.hosted?.dispose(); }
    finally { this.hosted = undefined; this.project.dispose(); }
  }
}

export function line(row: ToolExecutionComponent, width = 120): string {
  return lines(row, width)[0] ?? "";
}

export function lines(row: ToolExecutionComponent, width = 120): string[] {
  return row.render(width).map(stripAnsi).filter((text) => text.length > 0);
}

export function rawLine(row: ToolExecutionComponent, width = 120): string {
  return row.render(width).find((text) => text.trim().length > 0)!;
}

export function toggleLedger(row: ToolExecutionComponent, width = 120): void {
  const painted = row.render(width);
  const y = painted.findIndex((text) => stripAnsi(text).trim().length > 0);
  assert.equal(row.handleMouse({
    type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
    width, height: painted.length, shift: false, alt: false, ctrl: false,
  })?.handled, true);
}
