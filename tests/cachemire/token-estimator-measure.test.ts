import assert from "node:assert/strict";
import test from "node:test";
import { ESTIMATED_IMAGE_CHARS } from "../../extensions/_lib/provider-prompt.ts";
import { safeMinifiedJson } from "../../extensions/_lib/tool-payloads.ts";
import { measureProviderPrompt } from "../../scripts/cachemire/token-estimator-measure.ts";

const openAITarget = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.6-sol",
};

const anthropicTarget = {
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-fable-5",
};

test("OpenAI provider measurement separates semantic history from framing", () => {
  const call = { id: "call-1", name: "read", arguments: { path: "x" } };
  const measured = measureProviderPrompt({
    instructions: "system",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "large-base64" }] },
      { type: "reasoning", encrypted_content: "0123456789", summary: [{ type: "summary_text", text: "why" }] },
      { type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) },
      { type: "function_call_output", call_id: call.id, output: "done" },
    ],
    tools: [{ type: "function", name: "read", description: "Read.", parameters: { type: "object" }, strict: null }],
  }, openAITarget);
  assert.ok(measured);
  assert.equal(measured.shape, "openai-responses");
  assert.equal(measured.systemChars, 6);
  assert.equal(measured.messageCount, 1);
  assert.equal(measured.textChars, 5);
  assert.equal(measured.toolCallChars, safeMinifiedJson(call).length);
  assert.equal(measured.toolResultChars, 4);
  assert.equal(measured.readableReasoningChars, 3);
  assert.equal(measured.opaqueReasoningChars, 10);
  assert.equal(measured.retainedReasoningChars, 10);
  assert.equal(measured.imageCount, 1);
  assert.equal(
    measured.normalizedHistoryChars,
    5 + safeMinifiedJson(call).length + 4 + 10 + ESTIMATED_IMAGE_CHARS,
  );
  assert.ok(measured.framingChars > 0);
  assert.ok(measured.normalizedToolTokens > 0);
});

test("Anthropic provider measurement counts injected system text and signed reasoning separately", () => {
  const call = { id: "tool-1", name: "read", arguments: { path: "x" } };
  const measured = measureProviderPrompt({
    system: [{ type: "text", text: "abc" }, { type: "text", text: "defg", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thoughts", signature: "signature" },
          { type: "tool_use", id: call.id, name: call.name, input: call.arguments },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: call.id, content: "result" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(20_000) } },
        ],
      },
    ],
    tools: [],
  }, anthropicTarget);
  assert.ok(measured);
  assert.equal(measured.shape, "anthropic");
  assert.equal(measured.systemChars, 7);
  assert.equal(measured.messageCount, 2);
  assert.equal(measured.toolCallChars, safeMinifiedJson(call).length);
  assert.equal(measured.toolResultChars, 6);
  assert.equal(measured.readableReasoningChars, 8);
  assert.equal(measured.opaqueReasoningChars, 9);
  assert.equal(measured.retainedReasoningChars, 9);
  assert.equal(measured.imageCount, 1);
  assert.ok(measured.messageJsonChars < 10_000);
});

test("Pi-message provider measurement uses Pi tool-call and reasoning block shapes", () => {
  const call = { id: "tool-1", name: "read", arguments: { path: "x" } };
  const measured = measureProviderPrompt({
    context: {
      systemPrompt: "system",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thoughts", thinkingSignature: "signature" },
            { type: "toolCall", ...call, thoughtSignature: "tool-signature" },
          ],
        },
        { role: "toolResult", content: [{ type: "text", text: "result" }, { type: "image", data: "large-base64" }] },
      ],
      tools: [],
    },
  }, { provider: "radius", api: "pi-messages", id: "gpt-5.6-sol" });
  assert.ok(measured);
  assert.equal(measured.shape, "pi-messages");
  assert.equal(measured.toolCallChars, safeMinifiedJson(call).length);
  assert.equal(measured.toolResultChars, 6);
  assert.equal(measured.readableReasoningChars, 8);
  assert.equal(measured.opaqueReasoningChars, 9 + 14);
  assert.equal(measured.retainedReasoningChars, 9 + 14);
  assert.equal(measured.imageCount, 1);
});

test("unknown payload shapes are not guessed", () => {
  assert.equal(measureProviderPrompt({ prompt: "text" }, openAITarget), undefined);
});
