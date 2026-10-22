import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { assistantMessage } from "../helpers.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { payloadTextAdditions } from "../../extensions/pi-contextimate/request-messages.ts";
import { IsolatedProject } from "../harness/extension-host.ts";

function route<T extends Api>(api: T): Model<T> {
  return { provider: "fixture", id: "fixture", name: "Fixture", api, baseUrl: "http://127.0.0.1:9",
    reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

async function anthropicPayload(model: Model<"anthropic-messages">, context: ReturnType<typeof normalizeContext>) {
  let payload: unknown;
  const stream = streamAnthropic(model, context, { apiKey: "fixture-never-sent",
    onPayload: (body) => { payload = body; throw new Error("fixture stops before HTTP"); } });
  assert.equal((await stream.result()).stopReason, "error");
  assert.ok(payload);
  return payload;
}

const saved = [{ role: "user" as const, content: "same", timestamp: 1 }];
const item = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });

test("payload attribution preserves duplicate occurrences and ignores system and tool material", async () => {
  const payload = { instructions: "not an addition", tools: [{ description: "nor this" }], input: [
    { role: "developer", content: [{ type: "input_text", text: "not session text" }] },
    item("same"), item("same"), item("extra"),
    { type: "function_call_output", output: "not user text" },
  ] };
  assert.deepEqual(await payloadTextAdditions(saved, payload, route("openai-codex-responses")), { chars: 9, additive: true });
});

test("deletions, replacements and reordering are not falsely presented as additive counts", async () => {
  assert.deepEqual(await payloadTextAdditions(saved, { input: [item("replacement")] }, route("openai-responses")),
    { additive: false });
  assert.deepEqual(await payloadTextAdditions(saved, { input: [] }, route("openai-responses")),
    { additive: false });
  assert.deepEqual(await payloadTextAdditions([...saved, { role: "user", content: "next", timestamp: 2 }],
    { input: [item("next"), item("same")] }, route("openai-responses")), { additive: false });
});

test("unknown routes and malformed payloads do not claim outgoing text coverage", async () => {
  for (const payload of [null, {}, { input: "not an array" }]) {
    assert.equal(await payloadTextAdditions(saved, payload, route("openai-responses")), undefined);
  }
  assert.equal(await payloadTextAdditions(saved, { input: [item("extra")] }, route("unknown-api")), undefined);
});

test("native OpenAI replay drops aborted replies without losing genuine additions", async () => {
  const model = route("openai-responses");
  const history = [...saved,
    assistantMessage([{ type: "text", text: "partial aborted reply" }], { stopReason: "aborted" }),
  ];
  const context = normalizeContext({ messages: history });
  const input = convertResponsesMessages(model, context, new Set());
  assert.deepEqual(await payloadTextAdditions(history, { input }, model), { chars: 0, additive: true });
  assert.deepEqual(await payloadTextAdditions(history, { input: [...input, item("injected")] }, model),
    { chars: 8, additive: true });
});

test("native Anthropic unsigned thinking is not counted a second time", async () => {
  const model = route("anthropic-messages");
  const history = [...saved, assistantMessage([
    { type: "thinking", thinking: "unsigned thinking" }, { type: "text", text: "reply" },
  ], { provider: model.provider, model: model.id, api: model.api })];
  const payload = await anthropicPayload(model, normalizeContext({ messages: history }));
  assert.deepEqual(await payloadTextAdditions(history, payload, model), { chars: 0, additive: true });
});

test("bundled Pi attributes native payload additions without installed Pi peers", async () => {
  const fixtures = [];
  for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages"] as const) {
    const model = route(api);
    const history = [...saved, { role: "user" as const, content: "same\ud800 🚀", timestamp: 2 },
      assistantMessage([{ type: "text", text: "aborted reply" }], { stopReason: "aborted" }),
      assistantMessage([{ type: "text", text: "failed reply" }], { stopReason: "error" }),
      assistantMessage([{ type: "thinking", thinking: "foreign thinking" }, { type: "text", text: "foreign reply" }],
        { provider: "another-provider", model: "another-model", api: "anthropic-messages" }),
      assistantMessage([
        { type: "thinking", thinking: "unsigned thinking" },
        { type: "thinking", thinking: "signed thinking", thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: "fixture" }) },
        { type: "thinking", thinking: "redacted thinking", redacted: true,
          thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: "redacted" }) },
        { type: "thinking", thinking: "   " }, { type: "text", text: "same reply" },
      ], { provider: model.provider, model: model.id, api: model.api }),
    ];
    const context = normalizeContext({ messages: history });
    const payload = api === "anthropic-messages" ? await anthropicPayload(route(api), context)
      : { input: convertResponsesMessages(model, context, new Set()) };
    fixtures.push({ history, payload, model });
  }
  const project = new IsolatedProject();
  try {
    // Keep the extension outside node_modules so installed dev peers cannot mask #181.
    cpSync(new URL("../../extensions", import.meta.url), join(project.dir, "extensions"), { recursive: true });
    const probe = join(project.dir, "probe.ts");
    writeFileSync(probe, `
      import assert from "node:assert/strict";
      import { payloadTextAdditions } from "./extensions/pi-contextimate/request-messages.ts";
      export default async function () {
        for (const { history, payload, model } of ${JSON.stringify(fixtures)}) {
          for (let turn = 0; turn < 2; turn++) {
            assert.deepEqual(await payloadTextAdditions(history, payload, model), { additive: true, chars: 0 });
            const added = structuredClone(payload);
            const anthropic = model.api === "anthropic-messages";
            added[anthropic ? "messages" : "input"].push({ role: "user",
              content: [{ type: anthropic ? "text" : "input_text", text: "injected" }] });
            assert.deepEqual(await payloadTextAdditions(history, added, model), { additive: true, chars: 8 });
          }
        }
      }
    `);
    // SAFETY: the packaged bundle exposes the same SDK; unlike the unbundled entry,
    // its real extension loader uses virtual modules, the runtime seam behind #181.
    const { DefaultResourceLoader, SettingsManager } = await import(
      new URL("./bundle/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
    ) as typeof import("@earendil-works/pi-coding-agent");
    const loader = new DefaultResourceLoader({ cwd: project.dir, agentDir: project.home,
      settingsManager: SettingsManager.inMemory({ packages: [] }), additionalExtensionPaths: [probe] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
  } finally { project.dispose(); }
});

test("image conversions retain only hook coverage rather than mistaking generated captions for additions", async () => {
  const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
  const user = { role: "user" as const, content: [image], timestamp: 2 };
  assert.equal(await payloadTextAdditions([user], { input: [item("Image reading is disabled.")] }, route("openai-responses")), undefined);
  const tool = { role: "toolResult" as const, toolCallId: "call_abc|fc_def", toolName: "read",
    content: [image], isError: true, timestamp: 3 };
  assert.equal(await payloadTextAdditions([tool], { messages: [{ role: "user", content: "provider-generated caption" }] },
    route("anthropic-messages")), undefined);
});

test("Anthropic tool-result blocks and system instructions are not request-only conversation additions", async () => {
  const payload = { system: "instructions", messages: [
    { role: "user", content: [{ type: "text", text: "same" }, { type: "tool_result", content: "tool output" }] },
    { role: "assistant", content: [{ type: "text", text: "injected" }] },
  ] };
  assert.deepEqual(await payloadTextAdditions(saved, payload, route("anthropic-messages")), { chars: 8, additive: true });
});
