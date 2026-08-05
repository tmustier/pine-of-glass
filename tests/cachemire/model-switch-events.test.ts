// Model-switch event flow (issue #57): the real extension wired to a probe pi,
// driven through session_start, model_select, before_provider_request and
// message_end; asserts on the widget and notice strings users actually see.
import { test } from "node:test";
import assert from "node:assert/strict";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function usage(input: number, cacheRead: number, cacheWrite: number) {
  return { input, output: 10, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

type Handler = (...args: unknown[]) => unknown;

function extensionProbe(): { handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(): void {},
    getThinkingLevel: () => "off",
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  piCachemire(pi);
  return { handlers };
}

async function fire(probe: ReturnType<typeof extensionProbe>, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of probe.handlers.get(event) ?? []) await handler(...args);
}

function billedAssistant(model: string, api: string, prompt: number, userChars: number) {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "q".repeat(userChars), timestamp: 1_000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T10:00:05.000Z", message: {
      role: "assistant", content: [{ type: "text", text: "answer" }], provider: "anthropic", api, model,
      stopReason: "stop", timestamp: Date.now(), usage: usage(2, prompt - 2, 0),
    } },
  ];
}

function probeContext(entries: unknown[], api: string, notifications: string[], widgets: string[]) {
  return {
    hasUI: true,
    ui: {
      theme: undefined,
      setWidget(_key: string, widget?: unknown): void {
        // Cachemire also registers a TUI-capture hook through setWidget; only record
        // real widget lines.
        if (typeof widget === "function") widget({ requestRender: () => {} });
        else widgets.push(Array.isArray(widget) ? widget.join("\n") : "");
      },
      notify(text: string): void {
        notifications.push(text);
      },
    },
    model: {
      id: "claude-opus-4-8", provider: "anthropic", api, reasoning: false, contextWindow: 200_000,
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    },
    sessionManager: {
      getEntries: () => entries,
      getLeafId: () => {
        const last = entries.at(-1);
        return typeof last === "object" && last !== null && "id" in last && typeof last.id === "string" ? last.id : null;
      },
    },
    getSystemPrompt: () => "",
  };
}

const ANTHROPIC_PAYLOAD = {
  model: "claude-opus-4-8",
  system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "next" }] }],
};

test("event flow: a healthy first send and an abort both stay silent", async () => {
  const notifications: string[] = [];
  const widgets: string[] = [];
  const probe = extensionProbe();
  const ctx = probeContext([], "anthropic-messages", notifications, widgets);

  await fire(probe, "session_start", {}, ctx);
  try {
    await fire(probe, "before_provider_request", { payload: ANTHROPIC_PAYLOAD }, ctx);
    assert.equal(widgets.at(-1), "", "a healthy cache must not show ambient status");
    await fire(probe, "agent_end");
    assert.equal(widgets.at(-1), "", "an abort without usage must not leave a fictitious warning");
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});

test("event flow: the same model over a different wire API is a switch", async () => {
  // Baseline billed over anthropic-messages; the session resumes on bedrock-anthropic.
  const entries = billedAssistant("claude-opus-4-8", "anthropic-messages", 80_000, 200);
  const notifications: string[] = [];
  const widgets: string[] = [];
  const probe = extensionProbe();
  const ctx = probeContext(entries, "bedrock-anthropic", notifications, widgets);

  await fire(probe, "session_start", {}, ctx);
  try {
    assert.match(widgets.at(-1)!, /model switched/, "an API-only switch must flip the clock at session_start");
    assert.match(widgets.at(-1)!, /\(est\)/, "the forecast must be marked as an estimate");

    // Send time: the tiny estimated re-write is below the materiality thresholds, so
    // no break notice is posted (the widget already explains the switch).
    await fire(probe, "before_provider_request", { payload: ANTHROPIC_PAYLOAD }, ctx);
    assert.equal(notifications.length, 0, "an immaterial estimated re-write must not post a notice");
    assert.match(widgets.at(-1)!, /model switched/);

    // Usage billed over the new API re-baselines: the switch state clears.
    await fire(probe, "message_end", { message: {
      role: "assistant", content: [], provider: "anthropic", api: "bedrock-anthropic", model: "claude-opus-4-8",
      stopReason: "stop", timestamp: Date.now(), usage: usage(80_000, 0, 0),
    } });
    assert.doesNotMatch(widgets.at(-1)!, /model switched/, "fresh usage must re-baseline the currency");
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});

test("event flow: send-time payload replaces a stale material history forecast", async () => {
  // Canonical history is large, but the observed transformed payload is tiny. Send-time
  // sizing must follow what is actually leaving pi and suppress the stale warning.
  const entries = billedAssistant("claude-opus-4-8", "anthropic-messages", 80_000, 200_000);
  const notifications: string[] = [];
  const widgets: string[] = [];
  const probe = extensionProbe();
  const ctx = probeContext(entries, "bedrock-anthropic", notifications, widgets);

  await fire(probe, "session_start", {}, ctx);
  try {
    assert.match(widgets.at(-1)!, /next send ~76\.9k/, "pre-send selection uses canonical history");
    await fire(probe, "before_provider_request", { payload: ANTHROPIC_PAYLOAD }, ctx);
    assert.equal(notifications.length, 0, "the tiny observed payload is below the notice threshold");
    assert.doesNotMatch(widgets.at(-1)!, /next send ~76\.9k/, "the clock is refreshed from provider fields");
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});

test("event flow: a material provider payload posts one est-marked notice", async () => {
  const entries = billedAssistant("claude-opus-4-8", "anthropic-messages", 80_000, 200_000);
  const notifications: string[] = [];
  const widgets: string[] = [];
  const probe = extensionProbe();
  const ctx = probeContext(entries, "bedrock-anthropic", notifications, widgets);

  await fire(probe, "session_start", {}, ctx);
  try {
    await fire(probe, "before_provider_request", { payload: {
      ...ANTHROPIC_PAYLOAD,
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(200_000) }] }],
    } }, ctx);
    assert.equal(notifications.length, 1, "a material observed payload must post a notice");
    assert.match(notifications[0]!, /sending ~77\.0k uncached to anthropic \(est/);
    assert.match(notifications[0]!, /model switched/);
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});

test("event flow: model_select flips the clock before any send, and back again", async () => {
  const entries = billedAssistant("claude-opus-4-8", "anthropic-messages", 3_000, 2_000);
  const notifications: string[] = [];
  const widgets: string[] = [];
  const probe = extensionProbe();
  const ctx = probeContext(entries, "anthropic-messages", notifications, widgets);

  await fire(probe, "session_start", {}, ctx);
  try {
    assert.doesNotMatch(widgets.at(-1)!, /model switched/, "same identity: no switch at session_start");
    await fire(probe, "model_select", { model: {
      id: "gpt-5.6-luna", provider: "openai-codex", api: "openai-codex-responses", reasoning: true,
      contextWindow: 272_000, cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    } }, ctx);
    const line = widgets.at(-1)!;
    assert.match(line, /model switched/, "the pre-send widget must flip on model_select");
    assert.match(line, /next send ~[\d.]+k uncached to openai-codex/, "sized in the target's own currency");
    // Switching back before any send revives the old entry: the switch state clears.
    await fire(probe, "model_select", { model: ctx.model }, ctx);
    assert.doesNotMatch(widgets.at(-1)!, /model switched/);
    assert.equal(notifications.length, 0, "selection alone must never post a notice");
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});

