// Composed calls (design language §9.14): the boundary between pi's three records of
// a tool's nested calls and one typed ledger.
//
// - `result.details.calls`: codemode's own ledger, streamed through onUpdate while the
//   script runs (status `running`, then `ok`/`error`/`cancelled`), args as a JSON
//   preview string cut at 200 chars, durations and truncated error text.
// - `result.nestedCalls`: pi's generic record on the persisted tool result message
//   (any `ctx.executeTool()` caller), with parsed arguments and `complete`. A resumed
//   session's rows carry only this.
// - live `tool_execution_start`/`tool_execution_end` events with `parentToolCallId`:
//   the full arguments and the full result, never persisted. They are the only
//   source of a nested result's size.
//
// Everything here is parsing; ink and layout live in nested-rows.ts.
import { isJsonObject, nonNegativeNumberValue, stringValue, type JsonFields } from "../_lib/boundary.ts";
import { resultTextCharCount, type ToolRowDataLike } from "../_lib/chat.ts";
import { resultImageFact } from "./image-fact.ts";

export type NestedStatus = "ok" | "error" | "running" | "cancelled";

export interface NestedCall {
  id: string;
  name: string;
  /** Typed arguments when pi recorded them or a live event supplied them. */
  args: JsonFields | undefined;
  /** Codemode's JSON preview when the typed arguments are unknown (may be cut). */
  argsPreview: string | undefined;
  status: NestedStatus;
  durationMs: number | undefined;
  error: string | undefined;
  /** Live-observed result facts (§9.14): absent on a resumed session. */
  resultChars: number | undefined;
  imageFact: string | undefined;
}

export interface ComposedFacts {
  calls: NestedCall[];
  /** False when pi dropped calls or arguments from its record. */
  complete: boolean;
  /** Codemode's reported wall time, an event-boundary observation (§10.1). */
  wallMs: number | undefined;
  /** The tool cut its output to a cap; the model saw head and tail (§9.14). */
  trimmed: boolean;
}

// --- live capture -----------------------------------------------------------------------

interface NestedCapture {
  name: string;
  args: JsonFields | undefined;
  resultChars: number | undefined;
  imageFact: string | undefined;
  isError: boolean | undefined;
}

// Captures survive a hot reload like the render cache does; a session change clears them.
const CAPTURE_CAP = 4096; // agent-default (not a user rule): 2026-09-30
type NestedGlobal = typeof globalThis & { __tracelineNestedCaptures?: Map<string, NestedCapture> };
// SAFETY: the family's reload-safe global slot convention (see index.ts TracelineGlobal); only this key is read.
const captures = ((globalThis as NestedGlobal).__tracelineNestedCaptures ??= new Map<string, NestedCapture>());

export function clearNestedCaptures(): void {
  captures.clear();
}

export function recordNestedStart(toolCallId: string, toolName: string, args: unknown): void {
  const existing = captures.get(toolCallId);
  captures.set(toolCallId, {
    name: toolName,
    args: isJsonObject(args) ? args : existing?.args,
    resultChars: existing?.resultChars,
    imageFact: existing?.imageFact,
    isError: existing?.isError,
  });
  if (captures.size > CAPTURE_CAP) {
    const oldest = captures.keys().next().value;
    if (oldest !== undefined) captures.delete(oldest);
  }
}

export function recordNestedEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
  const existing = captures.get(toolCallId);
  // SAFETY: the pi event carries the tool's AgentToolResult; only its text/image blocks are read, through the same guarded readers trace rows use.
  const resultRow = { result: result as ToolRowDataLike["result"] };
  captures.set(toolCallId, {
    name: toolName,
    args: existing?.args,
    resultChars: resultTextCharCount(resultRow),
    imageFact: resultImageFact(resultRow) || undefined,
    isError,
  });
}

// --- parsing ------------------------------------------------------------------------------

function statusValue(value: unknown): NestedStatus | undefined {
  switch (value) {
    case "ok":
      return "ok";
    case "error":
      return "error";
    case "running":
      return "running";
    case "cancelled":
    case "unfinished":
      return "cancelled";
    default:
      return undefined;
  }
}

function parsePreview(preview: string): JsonFields | undefined {
  try {
    const parsed: unknown = JSON.parse(preview);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined; // a cut preview is not JSON; the row keeps the preview text
  }
}

function fromRecord(value: unknown): NestedCall | undefined {
  if (!isJsonObject(value)) return undefined;
  const name = stringValue(value.name);
  const status = statusValue(value.status);
  if (name === undefined || status === undefined) return undefined;
  const preview = stringValue(value.args);
  const args = isJsonObject(value.arguments) ? value.arguments : preview !== undefined ? parsePreview(preview) : undefined;
  return {
    id: stringValue(value.id) ?? "",
    name,
    args,
    argsPreview: args === undefined ? preview : undefined,
    status,
    durationMs: nonNegativeNumberValue(value.durationMs),
    error: stringValue(value.error),
    resultChars: undefined,
    imageFact: undefined,
  };
}

function parseCalls(value: unknown): NestedCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: NestedCall[] = [];
  for (const entry of value) {
    const call = fromRecord(entry);
    if (call) calls.push(call);
  }
  return calls;
}

// Codemode's result opens with its own header; the wall time is pi's observation.
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\n/;
const TRUNCATION_NOTICE = /^Warning: truncated output \(original token count: \d+\)/m;

function firstText(row: ToolRowDataLike): string | undefined {
  const content = row.result?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isJsonObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

function allText(row: ToolRowDataLike): string {
  const content = row.result?.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (isJsonObject(block) && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/** The composed-call facts of a row, or undefined when it is an ordinary call. A
 * codemode row is always composed (its native row would otherwise show code); any
 * other tool is composed once its result records at least one nested call. */
export function composedFactsOf(row: ToolRowDataLike | undefined): ComposedFacts | undefined {
  if (!row) return undefined;
  const codemode = row.toolName === "codemode";
  const result = row.result;
  const details = isJsonObject(result?.details) ? result.details : undefined;
  const nested = isJsonObject(result?.nestedCalls) ? result.nestedCalls : undefined;
  const streamed = parseCalls(details?.calls);
  const persisted = parseCalls(nested?.calls);
  if (!codemode && !(streamed?.length || persisted?.length)) return undefined;

  // The streamed ledger leads (it knows running and cancelled); the persisted record
  // overlays typed arguments by id; live captures overlay arguments and result facts.
  const calls = streamed ?? persisted ?? [];
  const byId = new Map<string, NestedCall>();
  for (const call of persisted ?? []) if (call.id) byId.set(call.id, call);
  for (const call of calls) {
    const record = call.id ? byId.get(call.id) : undefined;
    if (record?.args && !call.args) {
      call.args = record.args;
      call.argsPreview = undefined;
    }
    const live = call.id ? captures.get(call.id) : undefined;
    if (live) {
      if (live.args && !call.args) {
        call.args = live.args;
        call.argsPreview = undefined;
      }
      call.resultChars = live.resultChars;
      call.imageFact = live.imageFact;
      if (call.status === "ok" && live.isError) call.status = "error";
    }
  }
  const complete = nested?.complete !== false;
  const text = firstText(row);
  const wall = text ? SCRIPT_HEADER.exec(text)?.[1] : undefined;
  const wallMs = wall !== undefined ? Math.round(Number(wall) * 1000) : undefined;
  const trimmed = typeof details?.fullOutputPath === "string" || TRUNCATION_NOTICE.test(allText(row));
  return { calls, complete, wallMs: Number.isFinite(wallMs) ? wallMs : undefined, trimmed };
}
