// Runtime-faithful synthetic chat fixtures. These preserve the causal Pi invariants
// that traceline depends on while leaving unrelated component fields out of unit tests.
import { captureWriteCallSnapshot } from "../../extensions/pi-traceline/write-diff.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";



type AssistantContentBlock = { type: string; [key: string]: unknown };

let nextToolCallId = 0;

export function toolCallFor(row: ToolRowLike) {
  const id = typeof row.toolCallId === "string" ? row.toolCallId : `fixture-tool-${++nextToolCallId}`;
  row.toolCallId = id;
  return {
    type: "toolCall",
    id,
    name: String(row.toolName),
    arguments: row.args ?? {},
  };
}

export function assistantBefore(
  rows: ToolRowLike[],
  content: AssistantContentBlock[] = [],
  hideThinkingBlock = false,
) {
  return {
    setHideThinkingBlock: () => {},
    hideThinkingBlock,
    ...(hideThinkingBlock ? { hiddenThinkingLabel: "Thinking..." } : {}),
    lastMessage: { content: [...content, ...rows.map(toolCallFor)] },
  };
}

export function nativeBashLines(command: string, timeout?: number): string[] {
  return command.split("\n").map((part, index, parts) =>
    `${index === 0 ? "$ " : ""}${part}${index === parts.length - 1 && timeout ? ` (timeout ${timeout}s)` : ""}`
  );
}

// A completed read row; the native renderer text derives from the same arguments.
export function completedReadRow(path: string, offset: number, limit: number, resultChars = 1_000): ToolRowLike {
  return {
    toolName: "read",
    args: { path, offset, limit },
    result: { content: [{ type: "text", text: "x".repeat(resultChars) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ${path}:${offset}-${offset + limit - 1}`] },
  };
}

// A whole-file read (no offset/limit), the common shape in sibling-file sweeps.
export function wholeFileReadRow(path: string, resultChars = 1_000): ToolRowLike {
  return {
    toolName: "read",
    args: { path },
    result: { content: [{ type: "text", text: "x".repeat(resultChars) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ${path}`] },
  };
}

export function completedWriteRow(cwd: string, path: string, content: string): ToolRowLike {
  const row: ToolRowLike = {
    toolName: "write",
    args: { path, content },
    cwd,
    result: undefined,
    isPartial: true,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`write ${path}`] },
  };

  const toolCall = toolCallFor(row);
  captureWriteCallSnapshot(toolCall.id, toolCall.arguments, cwd);
  const absolutePath = resolve(cwd, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  row.result = {
    content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
    isError: false,
  };
  row.isPartial = false;
  return row;
}

// --- composed calls (design language §9.14) ----------------------------------------------

export type NestedFixture = {
  name: string;
  args: JsonObject;
  status?: "ok" | "error" | "running" | "cancelled";
  durationMs?: number;
  error?: string;
};

export type ComposedOptions = {
  cwd?: string;
  /** The script's output text after pi's header; defaults to a healthy 200-char result. */
  output?: string;
  wallSeconds?: number;
  /** Codemode's cap kicked in: pi spilled the full output and prefixed a warning. */
  trimmed?: boolean;
  failed?: boolean;
  running?: boolean;
  /** Omit the streamed details ledger, as a session restored from disk does. */
  restored?: boolean;
};

let nextComposedId = 0;

// A codemode row exactly as pi's ToolExecutionComponent holds it: the streamed
// `details.calls` ledger (args as a JSON preview string), the persisted `nestedCalls`
// record (typed arguments), and a result opening with the "Script completed" header.
export function composedCall(id: string, nested: NestedFixture[], options: ComposedOptions = {}) {
  const calls = nested.map((call, index) => ({
    id: `${id}/${index + 1}`,
    name: call.name,
    status: call.status ?? "ok",
    arguments: call.args,
    durationMs: call.durationMs ?? 20,
    ...(call.error ? { error: call.error } : {}),
  }));
  type StreamedCall = { id: string; name: string; args: string; status: string; durationMs: number; error?: string };
  const details: { calls?: StreamedCall[]; fullOutputPath?: string } = options.restored
    ? {}
    : { calls: calls.map((call) => ({ id: call.id, name: call.name, args: JSON.stringify(call.arguments).slice(0, 200), status: call.status, durationMs: call.durationMs, ...(call.error ? { error: call.error } : {}) })) };
  const output = options.output ?? "x".repeat(200);
  const notice = options.trimmed
    ? `Warning: truncated output (original token count: ${Math.ceil(output.length / 4)})\nTotal output lines: 3\n\n`
    : "";
  if (options.trimmed) details.fullOutputPath = "/tmp/pi-codemode-fixture.txt";
  const header = `Script ${options.failed ? "failed" : "completed"}\nWall time ${(options.wallSeconds ?? 0.4).toFixed(1)} seconds\nOutput:\n`;
  return {
    args: { code: "await Promise.allSettled(paths.map(async (path) => text(await tools.read({ path }))));" },
    result: options.running
      ? { content: [], isError: false, details }
      : { content: [{ type: "text", text: header }, { type: "text", text: `${notice}${output}` }], isError: options.failed === true, details, nestedCalls: { calls, complete: true } },
  };
}

export function composedRow(nested: NestedFixture[], options: ComposedOptions = {}): ToolRowLike {
  const id = `fixture-composed-${++nextComposedId}`;
  return {
    toolName: "codemode",
    toolCallId: id,
    cwd: options.cwd,
    ...composedCall(id, nested, options),
    isPartial: options.running === true,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => ["codemode"] },
  };
}
