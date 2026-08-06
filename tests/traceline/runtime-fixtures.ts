// Runtime-faithful synthetic chat fixtures. These preserve the causal Pi invariants
// that traceline depends on while leaving unrelated component fields out of unit tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { internals } from "../../extensions/pi-traceline/index.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";

const { captureWriteCallSnapshot } = internals;

type AssistantContentBlock = { type: string; [key: string]: unknown };

let nextToolCallId = 0;

export function toolCallFor(row: ToolRowLike) {
  const linked = row as ToolRowLike & { toolCallId?: string };
  linked.toolCallId ??= `fixture-tool-${++nextToolCallId}`;
  return {
    type: "toolCall",
    id: linked.toolCallId,
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
  } as ToolRowLike;
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
  } as ToolRowLike;
}

export function completedWriteRow(cwd: string, path: string, content: string): ToolRowLike {
  const row = {
    toolName: "write",
    args: { path, content },
    cwd,
    result: undefined,
    isPartial: true,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`write ${path}`] },
  } as ToolRowLike;

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
