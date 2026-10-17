// Real SDK dispatch, with Contextimate and the injector loaded as separate extensions.
// The scripted provider exercises the outgoing-payload hook without a network request.
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type ExtensionFactory, type ContextEvent, type ContextWithSystemEvent,
} from "@earendil-works/pi-coding-agent";
import contextimate from "../../extensions/pi-contextimate/index.ts";
import { scanSession, estimateSessionBreakdown } from "../../extensions/pi-contextimate/session-accounting.ts";
import { assistantMessage, plainTheme, stripAnsi, expectGolden, normalizeKeyHints } from "../helpers.ts";
import { renderSummary, renderCompact, renderExpanded } from "../../extensions/pi-contextimate/render.ts";
import { buildSnapshot } from "../../extensions/pi-contextimate/snapshot.ts";
import { IsolatedProject } from "../harness/extension-host.ts";

const PROVIDER = "contextimate-request-fixture";
const INJECTION = "Request-only audit text. ".repeat(100);

async function fixture(event: "context" | "context_with_system", api: "openai-responses" | "anthropic-messages", toolRound = false, virtual = false) {
  const project = new IsolatedProject();
  let injection: AgentMessage | undefined = { role: "user", content: INJECTION, timestamp: 1 };
  const errors: string[] = [];
  const outgoing: string[] = [];
  const inject: ExtensionFactory = (pi) => {
    const handler = (e: ContextEvent | ContextWithSystemEvent) => injection ? { messages: [...e.messages, injection] } : undefined;
    if (event === "context") pi.on("context", handler);
    else pi.on("context_with_system", handler);
    pi.registerTool({ name: "fixture_tool", label: "Fixture tool", description: "Return fixture output",
      parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "fixture tool output" }], details: {} }) });
    pi.registerCommand("saved", { handler: async () => {
      pi.sendMessage({ customType: "fixture-saved", content: "Saved custom text", display: false });
    } });
  };
  const provider: ExtensionFactory = (pi) => {
    pi.registerVirtualModel({ provider: PROVIDER, id: "virtual", name: "Virtual fixture",
      route: (_request, ctx) => {
        const model = ctx.modelRegistry.find(PROVIDER, "fixture");
        assert.ok(model);
        return { model, thinkingLevel: "off" };
      } });
    pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:9", apiKey: "fixture-never-sent", api,
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 100 }],
    streamSimple: (model, context, options) => {
      const messages = context.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content.flatMap((block) => block.type === "text"
          ? [{ type: api === "anthropic-messages" ? "text" : m.role === "user" ? "input_text" : "output_text", text: block.text }] : []),
      }));
      const payload = api === "anthropic-messages" ? { messages } : { input: messages };
      outgoing.push(JSON.stringify(payload));
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.(payload, model);
        const afterTool = context.messages.some((m) => m.role === "toolResult");
        const callTool = toolRound && !afterTool;
        const prompt = toolRound && afterTool ? 12_010 : 10_000;
        const message = assistantMessage(callTool
          ? [{ type: "toolCall", id: "fixture-call", name: "fixture_tool", arguments: {} }]
          : [{ type: "text", text: "OK" }], {
          provider: PROVIDER, model: "fixture", api, stopReason: callTool ? "toolUse" : "stop",
          usage: { input: prompt - 9_000, output: 10, cacheRead: 9_000, cacheWrite: 0,
            totalTokens: prompt + 10, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        });
        stream.push({ type: "done", reason: callTool ? "toolUse" : "stop", message });
        stream.end(message);
      })().catch((error: Error) => stream.end(assistantMessage([], { stopReason: "error", errorMessage: error.message })));
      return stream;
    },
    });
  };
  const cwd = project.dir;
  const loader = new DefaultResourceLoader({ cwd, agentDir: project.home,
    extensionFactories: [contextimate, inject, provider] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, agentDir: project.home, resourceLoader: loader,
    sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, images: { blockImages: true } }) });
  await session.bindExtensions({ mode: "print", onError: (e) => errors.push(e.error) });
  const model = session.modelRuntime.getModel(PROVIDER, virtual ? "virtual" : "fixture");
  assert.ok(model);
  await session.setModel(model);
  return { session, manager, outgoing,
    setInjection: (text: string) => { injection = text ? { role: "user", content: text, timestamp: 1 } : undefined; },
    setMessageInjection: (message: AgentMessage) => { injection = message; },
    async dispose() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose(); project.dispose(); assert.deepEqual(errors, []);
    } };
}

for (const event of ["context", "context_with_system"] as const) {
  for (const api of ["openai-responses", "anthropic-messages"] as const) {
    test(`${event} additions from a later extension get their own row on ${api}`, async () => {
      const host = await fixture(event, api);
      try {
        await host.session.prompt("go");
        assert.ok(host.outgoing.at(-1)?.includes(INJECTION));
        assert.ok(!JSON.stringify(host.manager.getEntries()).includes(INJECTION), "only counts persist, never injection text");
        const breakdown = scanSession(host.manager).breakdown!;
        assert.deepEqual(breakdown.requestOnly, { chars: INJECTION.length });
        assert.equal(breakdown.messageChars, 4, "only go and OK are saved messages");
        assert.equal(breakdown.firstPrompt, undefined, "injection must not become measured harness");
        const options = { denominator: 4, harnessTokens: 1_000, contextTokens: 10_010 };
        const estimate = estimateSessionBreakdown(breakdown, options);
        assert.equal(estimate.requestOnlyTokens, INJECTION.length / 4);
        assert.equal(estimate.totalTokens, 9_010, "the estimate is not added to the provider total");
        assert.equal(estimate.unattributedTokens, 9_010 - 1 - INJECTION.length / 4);

      } finally { await host.dispose(); }
    });
  }
}

test("each request replaces its additions and a clean request clears them", async () => {
  const host = await fixture("context", "openai-responses");
  try {
    await host.session.prompt("go");
    await host.session.prompt("again");
    assert.equal(scanSession(host.manager).breakdown?.requestOnly?.chars, INJECTION.length);
    host.setInjection("smaller");
    await host.session.prompt("change");
    assert.equal(scanSession(host.manager).breakdown?.requestOnly?.chars, 7);
    host.setInjection("");
    await host.session.prompt("stop");
    assert.equal(scanSession(host.manager).breakdown?.requestOnly, undefined);
  } finally { await host.dispose(); }
});

test("zero-character additions still prevent contaminated harness and tool measurements", async () => {
  const host = await fixture("context", "openai-responses", true);
  try {
    host.setMessageInjection(assistantMessage([{ type: "thinking", thinking: "opaque reasoning",
      thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: "opaque" }) }]));
    await host.session.prompt("go");
    const breakdown = scanSession(host.manager).breakdown!;
    assert.deepEqual(breakdown.requestOnly, { chars: 0 });
    assert.equal(breakdown.firstPrompt, undefined);
    assert.equal(breakdown.measuredToolOutputTokens, 0);
  } finally { await host.dispose(); }
});

test("injected image conversions do not get counted in addition to the observed image marker", async () => {
  const host = await fixture("context", "openai-responses");
  try {
    host.setMessageInjection({ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 });
    await host.session.prompt("go");
    assert.ok(host.outgoing.at(-1)?.includes("Image reading is disabled."));
    assert.equal(scanSession(host.manager).breakdown?.requestOnly?.chars, "[image:image/png:4 chars]".length);
  } finally { await host.dispose(); }
});

test("SDK blocked images do not become request-only text on a clean request", async () => {
  const host = await fixture("context", "openai-responses");
  try {
    host.setInjection("");
    await host.session.prompt("go", { images: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", mimeType: "image/png" }] });
    assert.ok(host.outgoing.at(-1)?.includes("Image reading is disabled."), host.outgoing.join("\n"));
    const breakdown = scanSession(host.manager).breakdown!;
    assert.equal(breakdown.requestOnly, undefined);
    assert.ok(breakdown.firstPrompt, "a generated placeholder must not disable harness measurement");
  } finally { await host.dispose(); }
});

test("a virtual selection reconciles late additions using the physical response model", async () => {
  const host = await fixture("context_with_system", "openai-responses", false, true);
  try {
    assert.equal(host.session.model?.api, "pi-virtual");
    await host.session.prompt("go");
    assert.equal(scanSession(host.manager).breakdown?.requestOnly?.chars, INJECTION.length);
    assert.equal(scanSession(host.manager).breakdown?.firstPrompt, undefined);
  } finally { await host.dispose(); }
});

test("tool rounds count one injection and do not label its prompt growth as measured tool output", async () => {
  const host = await fixture("context", "openai-responses", true);
  try {
    await host.session.prompt("run the fixture tool");
    const breakdown = scanSession(host.manager).breakdown!;
    assert.equal(host.outgoing.length, 2);
    assert.equal(breakdown.toolOutputChars, "fixture tool output".length);
    assert.equal(breakdown.requestOnly?.chars, INJECTION.length);
    assert.equal(breakdown.measuredToolOutputTokens, 0);
    assert.equal(breakdown.measuredToolOutputChars, 0);
  } finally { await host.dispose(); }
});

test("saved custom messages are not counted again, and branch selection restores only its own request", async () => {
  const host = await fixture("context", "openai-responses");
  try {
    await host.session.prompt("go");
    const injectedLeaf = host.manager.getLeafId()!;
    assert.equal(host.manager.getLeafEntry()?.type, "message", "the branch target is the assistant, not metadata");
    await host.session.prompt("/saved");
    await host.session.prompt("use saved");
    assert.equal(scanSession(host.manager).breakdown?.requestOnly?.chars, INJECTION.length);
    assert.ok(scanSession(host.manager).breakdown!.messageChars >= "Saved custom text".length);
    host.setInjection("");
    await host.session.prompt("clean branch");
    assert.equal(scanSession(host.manager).breakdown?.requestOnly, undefined);
    host.manager.branch(injectedLeaf);
    assert.equal(scanSession(host.manager).breakdown?.requestOnly?.chars, INJECTION.length);

    // Replay uses serialized entries, so attribution cannot depend on a live object cache.
    const restoredEntries = structuredClone(host.manager.getEntries());
    const restored = { getEntries: () => restoredEntries, getLeafId: () => injectedLeaf };
    assert.deepEqual(scanSession(restored).breakdown?.requestOnly, { chars: INJECTION.length });
    host.manager.appendContextEdit(injectedLeaf, { content: [{ type: "text", text: "edited reply" }] });
    assert.deepEqual(scanSession(host.manager).breakdown?.requestOnly, { chars: INJECTION.length });
    assert.equal(scanSession(host.manager).breakdown?.firstPrompt, undefined, "context edits cannot restore a contaminated measurement");
    host.manager.appendCompaction("compacted", injectedLeaf, 10_000);
    assert.equal(scanSession(host.manager).breakdown?.requestOnly, undefined, "compaction drops old request additions");
  } finally { await host.dispose(); }
});

test("the request-only row keeps the shared token alignment in every panel view", async () => {
  const host = await fixture("context", "openai-responses");
  try {
    await host.session.prompt("go");
    const snapshot = buildSnapshot({ getActiveTools: () => [], getAllTools: () => [] }, {
      systemPrompt: "Fixture prompt", sessionManager: host.manager,
      contextUsage: { tokens: 10_010, contextWindow: 200_000, percent: 5.005 },
    });
    for (const width of [48, 80, 120]) {
      const lines = renderSummary(snapshot, plainTheme, width);
      expectGolden(`contextimate-request-only-${width}.txt`, normalizeKeyHints(stripAnsi(lines.join("\n"))));
    }
    for (const render of [renderSummary, renderCompact, renderExpanded]) {
      const lines = render(snapshot, plainTheme, 80).map(stripAnsi);
      const added = lines.find((line) => line.includes("Request-only"))!;
      const saved = lines.find((line) => line.includes("Messages"))!;
      assert.ok(added.includes("not saved"));
      assert.equal(added.indexOf(" tokens"), saved.indexOf(" tokens"));
    }
  } finally { await host.dispose(); }
});
