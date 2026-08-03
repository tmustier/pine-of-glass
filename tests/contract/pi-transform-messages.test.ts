// Contract: _lib/forecast.ts mirrors the size-material rules of pi-ai's
// transformMessages. The forecast cannot import that function at runtime (pi's loader
// only aliases the compat surface), so this suite runs BOTH implementations over the
// same histories and compares the resulting material char counts. When a case fails
// after `pi update`, update extensions/_lib/forecast.ts to match the real transform.
import { test } from "node:test";
import assert from "node:assert/strict";

import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { Message, Model, Api } from "@earendil-works/pi-ai";

import {
  forecastHistoryForTarget,
  normalizeForecastToolCallId,
  type ForecastMessage,
} from "../../extensions/_lib/forecast.ts";
import { ESTIMATED_IMAGE_CHARS } from "../../extensions/_lib/provider-prompt.ts";
import { assistantMessage } from "../helpers.ts";

function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
    ...overrides,
  } as Model<Api>;
}

type AssistantContent = Extract<Message, { role: "assistant" }>["content"];

// The forecast's char conventions applied to real transform *output*: text and
// tool-call structure verbatim, encrypted payloads at signature length, images at
// pi's flat estimate. Applying one convention to both sides isolates the transform
// rules themselves — any drop/convert/skip disagreement shifts the totals apart.
function materialCharsOfTransform(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
      else if (block.type === "toolCall") {
        chars += JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments }).length;
        chars += block.thoughtSignature?.length ?? 0;
      } else if (block.type === "thinking") {
        chars += block.thinkingSignature !== undefined ? block.thinkingSignature.length : block.thinking.length;
      }
    }
  }
  return chars;
}

function materialCharsOfForecast(messages: Message[], model: Model<Api>): number {
  const forecast = forecastHistoryForTarget(messages as unknown as ForecastMessage[], {
    provider: model.provider,
    id: model.id,
    api: model.api,
    input: model.input,
  });
  return forecast.textChars + forecast.keptReasoningChars + forecast.imageChars;
}

function assertMirror(messages: Message[], model: Model<Api>, label: string): void {
  assert.equal(
    materialCharsOfForecast(messages, model),
    materialCharsOfTransform(transformMessages(messages, model)),
    `forecast disagrees with transformMessages: ${label}`,
  );
}

// A history exercising every transform rule at once. Tool calls have matching
// results (orphans get synthetic results pi inserts and the forecast deliberately
// ignores — pinned separately below).
function richHistory(): Message[] {
  return [
    { role: "user", content: "plain string user message", timestamp: 1 } as Message,
    {
      role: "user",
      timestamp: 2,
      content: [
        { type: "text", text: "before images" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "image", data: "aGk=", mimeType: "image/png" }, // consecutive: one placeholder when non-vision
        { type: "text", text: "between" },
        { type: "image", data: "aGk=", mimeType: "image/png" }, // new run: second placeholder
      ],
    } as Message,
    assistantMessage(
      [
        { type: "thinking", thinking: "readable summary", thinkingSignature: "ENCRYPTED-SOL-PAYLOAD" },
        { type: "thinking", thinking: "", thinkingSignature: "SIGNATURE-ONLY" },
        { type: "thinking", thinking: "   \n  ", thinkingSignature: undefined }, // blank: vanishes even same-model
        { type: "thinking", thinking: "", thinkingSignature: "REDACTED", redacted: true },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" }, thoughtSignature: "TOOL-THOUGHT" },
      ] as AssistantContent,
      { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-sol", stopReason: "toolUse" },
    ),
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [
        { type: "text", text: "tool result text" },
        { type: "image", data: "aGk=", mimeType: "image/png" }, // tool placeholder differs from user placeholder
      ],
      isError: false,
      timestamp: 4,
    } as Message,
    assistantMessage([{ type: "text", text: "half an answer" }] as AssistantContent, { stopReason: "aborted" }),
    assistantMessage([{ type: "text", text: "failed" }] as AssistantContent, { stopReason: "error", errorMessage: "boom" }),
    assistantMessage(
      [{ type: "thinking", thinking: "unsigned readable thinking" }, { type: "text", text: "the answer" }] as AssistantContent,
      { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-4-8" },
    ),
  ];
}

test("mirror: cross-model transform to a vision target", () => {
  assertMirror(richHistory(), fakeModel(), "sol/opus history → luna");
});

test("mirror: cross-model transform to a non-vision target (image placeholders)", () => {
  assertMirror(richHistory(), fakeModel({ input: ["text"] }), "sol/opus history → non-vision luna");
});

test("mirror: same-model replay keeps reasoning payloads", () => {
  const opus = fakeModel({ id: "claude-opus-4-8", api: "anthropic-messages", provider: "anthropic", contextWindow: 200_000 });
  assertMirror(richHistory(), opus, "sol/opus history → opus (opus turns replay)");
  const sol = fakeModel({ id: "gpt-5.6-sol" });
  assertMirror(richHistory(), sol, "sol/opus history → sol (sol turns replay)");
});

test("mirror: cross-provider tool call IDs use pi's normalization callback", () => {
  const originalId = `call|${"+/=".repeat(180)}`;
  const history = [
    assistantMessage(
      [{ type: "toolCall", id: originalId, name: "read", arguments: { path: "/tmp/x" } }] as AssistantContent,
      { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-sol", stopReason: "toolUse" },
    ),
    {
      role: "toolResult", toolCallId: originalId, toolName: "read",
      content: [{ type: "text", text: "result" }], isError: false, timestamp: 4,
    } as Message,
  ];
  const target = fakeModel({ id: "claude-opus-4-8", api: "anthropic-messages", provider: "anthropic" });
  const transformed = transformMessages(history, target, (id, model, source) =>
    normalizeForecastToolCallId(id, model, source as unknown as ForecastMessage));
  const firstBlock = (transformed[0] as Extract<Message, { role: "assistant" }>).content[0];
  assert.equal(firstBlock?.type, "toolCall");
  assert.equal(firstBlock?.type === "toolCall" ? firstBlock.id.length : 0, 64);
  assert.equal(
    materialCharsOfForecast(history, target),
    materialCharsOfTransform(transformed),
    "the forecast must count the normalized wire ID, not the 545-char source ID",
  );
});

test("known divergence: pi synthesizes results for orphaned tool calls; the forecast ignores them", () => {
  const orphaned = [
    assistantMessage(
      [{ type: "toolCall", id: "t9", name: "bash", arguments: { command: "ls" } }] as AssistantContent,
      { stopReason: "toolUse" },
    ),
  ];
  const synthetic = transformMessages(orphaned, fakeModel()).filter((message) => message.role === "toolResult");
  assert.equal(synthetic.length, 1, "pi must still synthesize a result — otherwise the forecast's omission is wrong");
  assert.ok(
    materialCharsOfTransform(synthetic) < 100,
    "a synthetic result must stay immaterial for the forecast to keep ignoring it",
  );
});
