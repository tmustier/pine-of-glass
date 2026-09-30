// Contract: the pi seams behind composed-call rows (design language §9.14), proven by
// running a real codemode script through the installed pi's agent loop. The model is a
// scripted stream that issues one `codemode` call; pi's real tool pipeline executes the
// script, runs the nested tools, emits their events and records them on the result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piTraceline from "../../extensions/pi-traceline/index.ts";
import { isJsonObject } from "../../extensions/_lib/boundary.ts";
import { composedFactsOf } from "../../extensions/pi-traceline/nested-calls.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { assistantMessage } from "../helpers.ts";
import { IsolatedProject, hostExtension } from "../harness/extension-host.ts";

// A scripted provider registered through the public extension API: the session's
// request-time auth and streaming both resolve to it, so nothing leaves the process.
const PROVIDER = "pog-fixture";
const MODEL_ID = "scripted";

type ExecutionEvent = { type: string; toolCallId: string; toolName: string; parentToolCallId?: string; isError?: boolean; result?: unknown };

function scriptedProvider(pi: ExtensionAPI, toolCall: ToolCall): void {
  let turns = 0;
  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "fixture-never-sent",
    api: "openai-completions",
    models: [{ id: MODEL_ID, name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }],
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      const overrides = { provider: PROVIDER, model: MODEL_ID, api: "openai-completions" as const };
      const message: AssistantMessage = turns++ === 0
        ? assistantMessage([toolCall], { ...overrides, stopReason: "toolUse" })
        : assistantMessage([{ type: "text", text: "done" }], overrides);
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        stream.end(message);
      });
      return stream;
    },
  });
}

test("codemode's nested calls reach traceline through details.calls, nestedCalls and parent-tagged events", async () => {
  const project = new IsolatedProject();
  mkdirSync(join(project.dir, "docs"));
  writeFileSync(join(project.dir, "docs/a.md"), "alpha\n".repeat(400));
  writeFileSync(join(project.dir, "docs/b.md"), "beta\n");
  const events: ExecutionEvent[] = [];
  const observer = (pi: ExtensionAPI) => {
    pi.on("tool_execution_start", (event) => {
      events.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, parentToolCallId: event.parentToolCallId });
    });
    pi.on("tool_execution_end", (event) => {
      events.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, parentToolCallId: event.parentToolCallId, isError: event.isError, result: event.result });
    });
  };
  const code = [
    "// @options: {\"max_output_tokens\": 60}",
    'const a = await tools.read({ path: "docs/a.md" });',
    'const b = await tools.read({ path: "docs/b.md" });',
    'await tools.bash({ command: "printf ok" });',
    'try { await tools.read({ path: "docs/missing.md" }); } catch {}',
    "text(a + b);",
  ].join("\n");
  const toolCall: ToolCall = { type: "toolCall", id: "call_composed_1", name: "codemode", arguments: { code } };
  const factories = [createCodemodeExtension({ models: false }), observer, piTraceline, (pi: ExtensionAPI) => scriptedProvider(pi, toolCall)];
  const hosted = await hostExtension((pi) => { for (const factory of factories) factory(pi); }, { project, noTools: "builtin" as never });
  try {
    const { session } = hosted;
    const model = session.modelRuntime.getModelOfType("chat", PROVIDER, MODEL_ID);
    assert.ok(model, "scripted provider registered");
    await session.setModel(model);
    session.setActiveToolsByName(["read", "bash", "codemode"]);
    await session.prompt("run the script");

    // 1. The persisted tool result carries both ledgers with the shapes nested-calls.ts parses.
    const result = session.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCall.id);
    assert.ok(result, "codemode result message recorded");
    assert.equal(result.isError, false);
    const details = result.details;
    assert.ok(isJsonObject(details) && Array.isArray(details.calls), "details.calls ledger present");
    assert.equal(typeof details.fullOutputPath, "string", "max_output_tokens cap spilled the output to a file");
    const nested = result.nestedCalls;
    assert.ok(nested && Array.isArray(nested.calls), "nestedCalls record present");
    assert.deepEqual(nested.calls.map((call) => [call.name, call.status]), [["read", "ok"], ["read", "ok"], ["bash", "ok"], ["read", "error"]]);
    assert.ok(nested.calls.every((call) => call.id.startsWith(`${toolCall.id}/`)), "nested ids are <parent>/<n>");
    assert.ok(nested.calls.every((call) => isJsonObject(call.arguments) && typeof call.durationMs === "number"));
    assert.match(String(nested.calls[3]!.error), /ENOENT|not found|no such file/i);
    const header = result.content[0];
    assert.ok(header?.type === "text" && /^Script completed\nWall time [\d.]+ seconds\nOutput:\n$/.test(header.text), "script header shape");
    const body = result.content.slice(1).map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(body, /^Warning: truncated output \(original token count: \d+\)/, "truncation notice shape");

    // 2. Nested execution events carry parentToolCallId and the full nested result.
    const nestedEvents = events.filter((event) => event.parentToolCallId === toolCall.id);
    assert.equal(nestedEvents.filter((event) => event.type === "tool_execution_start").length, 4);
    const ends = nestedEvents.filter((event) => event.type === "tool_execution_end");
    assert.equal(ends.length, 4);
    assert.equal(ends[3]!.isError, true);
    const firstRead = ends[0]!.result as { content?: Array<{ type: string; text?: string }> };
    assert.ok(firstRead.content?.[0]?.text && firstRead.content[0].text.length >= 2_400, "nested result text is the full read, never persisted");

    // 3. traceline's parser sees one ledger with live sizes overlaid from those events.
    const row = { toolName: "codemode", toolCallId: toolCall.id, args: toolCall.arguments, result, isPartial: false } as unknown as ToolRowLike;
    const facts = composedFactsOf(row);
    assert.ok(facts);
    assert.equal(facts.calls.length, 4);
    assert.equal(facts.trimmed, true);
    assert.ok(facts.wallMs !== undefined && facts.wallMs >= 0);
    assert.equal(facts.calls[0]!.resultChars, firstRead.content![0]!.text!.length, "live capture supplies the nested result size");
    assert.equal(facts.calls[3]!.status, "error");
    assert.equal(facts.calls[2]!.args?.command, "printf ok");
  } finally {
    await hosted.dispose();
    project.dispose();
  }
});
