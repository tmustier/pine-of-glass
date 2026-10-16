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
import { isJsonObject, nonNegativeNumberValue, stringValue } from "../_lib/boundary.ts";
import { resultTextCharCount, type ToolRowDataLike, type ToolResultLike } from "../_lib/chat.ts";
import { resultImageFact } from "./image-fact.ts";
import { lineRange } from "./path-rows.ts";

type NestedStatus = "ok" | "error" | "running" | "cancelled";

type ParsedArguments = { kind: "parsed"; path: string | undefined; command: string | undefined; range: string; text: string };
type NestedArguments = ParsedArguments | { kind: "preview"; path?: never; command?: never; range?: never; text: string };

export interface NestedCall {
  id: string;
  name: string;
  args: NestedArguments;
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
  args: ParsedArguments | undefined;
  resultChars: number | undefined;
  imageFact: string | undefined;
  isError: boolean | undefined;
  /** The complete error text of a failed result; codemode's own record caps it. */
  error: string | undefined;
}

// Captures survive a hot reload like the render cache does; a session change clears them.
const CAPTURE_CAP = 4096; // agent-default (not a user rule): 2026-09-30
type NestedGlobal = typeof globalThis & { __tracelineNestedCaptures?: Map<string, NestedCapture> };
// SAFETY: the family's reload-safe global slot convention (see index.ts TracelineGlobal); only this key is read.
const captures = ((globalThis as NestedGlobal).__tracelineNestedCaptures ??= new Map<string, NestedCapture>());

export function clearNestedCaptures(): void {
  captures.clear();
}

export function recordNestedStart(toolCallId: string, args: unknown): void {
  const existing = captures.get(toolCallId);
  captures.set(toolCallId, {
    args: parseArguments(args) ?? existing?.args,
    resultChars: existing?.resultChars,
    imageFact: existing?.imageFact,
    isError: existing?.isError,
    error: existing?.error,
  });
  if (captures.size > CAPTURE_CAP) {
    captures.delete(captures.keys().next().value!);
  }
}

export function recordNestedEnd(toolCallId: string, result: ToolResultLike, isError: boolean): void {
  const existing = captures.get(toolCallId);
  const resultRow = { result };
  captures.set(toolCallId, {
    args: existing?.args,
    resultChars: resultTextCharCount(resultRow),
    imageFact: resultImageFact(resultRow) || undefined,
    isError,
    error: isError ? resultTexts(result).join("\n") || undefined : undefined,
  });
}

function resultTexts(result: ToolResultLike | undefined): string[] {
  if (!Array.isArray(result?.content)) return [];
  return result.content.flatMap((block) =>
    isJsonObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []);
}

// --- parsing ------------------------------------------------------------------------------

function parseArguments(value: unknown): ParsedArguments | undefined {
  if (!isJsonObject(value)) return undefined;
  const path = value.path ?? value.file_path;
  const command = value.command;
  return {
    kind: "parsed",
    path: typeof path === "string" && path.length > 0 ? path : undefined,
    command: typeof command === "string" && command.trim().length > 0 ? command : undefined,
    range: lineRange(value),
    text: JSON.stringify(value),
  };
}

function parseCalls(value: unknown): NestedCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: NestedCall[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) continue;
    const name = stringValue(entry.name);
    const status = entry.status === "unfinished" ? "cancelled" : entry.status;
    if (name === undefined || (status !== "ok" && status !== "error" && status !== "running" && status !== "cancelled")) continue;
    const preview = stringValue(entry.args);
    let args = parseArguments(entry.arguments);
    if (!args && preview !== undefined) {
      try {
        const parsed: unknown = JSON.parse(preview);
        args = parseArguments(parsed);
      } catch {
        // Codemode cuts previews mid-JSON; retain the text below.
      }
    }
    calls.push({
      id: stringValue(entry.id) ?? "",
      name,
      args: args ?? { kind: "preview", text: preview ?? "" },
      status,
      durationMs: nonNegativeNumberValue(entry.durationMs),
      error: stringValue(entry.error),
      resultChars: undefined,
      imageFact: undefined,
    });
  }
  return calls;
}

// Codemode's result opens with its own header; the wall time is pi's observation.
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\n/;
const TRUNCATION_NOTICE = /^Warning: truncated output \(original token count: \d+\)/m;

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
    if (record?.args.kind === "parsed" && call.args.kind === "preview") call.args = record.args;
    const live = call.id ? captures.get(call.id) : undefined;
    if (live) {
      if (live.args && call.args.kind === "preview") call.args = live.args;
      call.resultChars = live.resultChars;
      call.imageFact = live.imageFact;
      if (call.status === "ok" && live.isError) call.status = "error";
      if (live.error) call.error = live.error;
    }
  }
  const complete = nested?.complete !== false;
  const texts = resultTexts(result);
  const wall = SCRIPT_HEADER.exec(texts[0] ?? "")?.[1];
  const wallMs = wall !== undefined ? Math.round(Number(wall) * 1000) : undefined;
  const trimmed = typeof details?.fullOutputPath === "string" || TRUNCATION_NOTICE.test(texts.join(""));
  return { calls, complete, wallMs: Number.isFinite(wallMs) ? wallMs : undefined, trimmed };
}
