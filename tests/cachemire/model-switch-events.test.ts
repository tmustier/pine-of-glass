// SDK event flow: observe the widget and notices, not a hand-wired ExtensionAPI.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC, OPENAI, billed, finish, hostCachemire, payload, request } from "./event-fixtures.ts";

const CODEX: Model<"openai-codex-responses"> = {
  ...OPENAI, id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex", api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
};

function restoredSession(model: Pick<Model<string>, "provider" | "id" | "api"> = ANTHROPIC, prompt = 80_000, userChars = 200): SessionManager {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "q".repeat(userChars), timestamp: Date.now() });
  manager.appendMessage(billed(model, 2, prompt - 2));
  return manager;
}

test("a healthy first send and an abort both stay silent", async () => {
  const host = await hostCachemire();
  try {
    await request(host, payload(["next"]));
    assert.deepEqual(host.ui.widgetLines("pi-cachemire"), []);
    await host.session.extensionRunner.emit({ type: "agent_end", messages: [] });
    assert.deepEqual(host.ui.widgetLines("pi-cachemire"), []);
    assert.deepEqual(host.ui.notifications, []);
  } finally {
    await host.dispose();
  }
});

test("restored GPT-6 Astra Codex reaches unknown at its 30m minimum", async (t) => {
  let now = Date.UTC(2026, 8, 8, 12);
  t.mock.method(Date, "now", () => now);
  const manager = restoredSession(CODEX, 100_000);
  now += 30 * 60_000;
  const host = await hostCachemire({ model: CODEX, sessionManager: manager });
  try {
    assert.match(host.ui.widgetLines("pi-cachemire")!.join("\n"), /cache state unknown .* 30m retention minimum reached/);
  } finally {
    await host.dispose();
  }
});

test("an Anthropic-shaped gateway payload keeps retention unknown", async (t) => {
  let now = Date.UTC(2026, 7, 4, 12);
  t.mock.method(Date, "now", () => now);
  const gateway = { ...ANTHROPIC, id: "claude-fable-5", provider: "radius", api: "pi-messages" };
  const host = await hostCachemire({ model: gateway });
  try {
    host.session.sessionManager.appendMessage({ role: "user", content: "first", timestamp: now });
    const body = { ...payload(["first"]), model: gateway.id };
    await request(host, body);
    await finish(host, billed(gateway, 0, 0, 100_000));
    now += 5 * 60_000;
    await request(host, body);
    assert.deepEqual(host.ui.notifications, [], "gateway shape must not create an Anthropic TTL");
    assert.deepEqual(host.ui.widgetLines("pi-cachemire"), []);
  } finally {
    await host.dispose();
  }
});

test("the same model over a different wire API is a switch", async () => {
  const target = { ...ANTHROPIC, api: "bedrock-anthropic" };
  const host = await hostCachemire({ model: target, sessionManager: restoredSession() });
  const clock = () => host.ui.widgetLines("pi-cachemire", 200)!.join("\n");
  try {
    assert.match(clock(), /model switched/);
    assert.match(clock(), /\(est\)/);
    await request(host, payload(["next"]));
    assert.deepEqual(host.ui.notifications, [], "an immaterial estimate must not post a notice");
    assert.match(clock(), /model switched/);
    await finish(host, billed(target, 80_000, 0));
    assert.doesNotMatch(clock(), /model switched/, "fresh usage re-baselines the currency");
  } finally {
    await host.dispose();
  }
});

test("the model-switch forecast remains stable through send", async () => {
  const manager = restoredSession(ANTHROPIC, 80_000, 200_000);
  const target = { ...ANTHROPIC, api: "bedrock-anthropic" };
  const host = await hostCachemire({ model: target, sessionManager: manager });
  try {
    const clock = host.ui.widgetLines("pi-cachemire", 240)!.join("\n");
    const estimate = /next prompt (~[\d.]+k) tokens/.exec(clock)?.[1];
    assert.ok(estimate, clock);
    assert.doesNotMatch(clock, /cache cold|uncached/);
    manager.appendMessage({ role: "user", content: "n".repeat(26_000), timestamp: Date.now() });
    await request(host, payload(["q".repeat(200_000), "answer", "n".repeat(26_000)]));
    assert.equal(host.ui.notifications.length, 1);
    assert.ok(host.ui.notifications[0]!.includes(`sending ${estimate} prompt tokens to anthropic (est) · cache read unknown`));
    assert.doesNotMatch(host.ui.notifications[0]!, /cache breaking|uncached/);
  } finally {
    await host.dispose();
  }
});

test("classification uses the previous policy and abort restores it", async (t) => {
  let now = Date.UTC(2026, 7, 4, 12);
  t.mock.method(Date, "now", () => now);
  const host = await hostCachemire({ model: OPENAI });
  try {
    host.session.sessionManager.appendMessage({ role: "user", content: "first", timestamp: now });
    await request(host, { model: OPENAI.id, input: [{ role: "user", content: "first" }], prompt_cache_retention: "24h" });
    await finish(host, billed(OPENAI, 0, 100_000));
    now += 24 * 60 * 60_000;
    await request(host, { model: OPENAI.id, input: [{ role: "user", content: "first" }] });
    assert.equal(host.ui.notifications.length, 1);
    assert.match(host.ui.notifications[0]!, /24h retention maximum reached after 24h idle/);
    assert.deepEqual(host.ui.widgetLines("pi-cachemire"), [], "the outgoing omitted policy stays unknown");
    await host.session.extensionRunner.emit({ type: "agent_end", messages: [] });
    assert.match(host.ui.widgetLines("pi-cachemire", 200)!.join("\n"), /24h retention maximum reached/);
  } finally {
    await host.dispose();
  }
});

test("switching back before an OpenAI maximum stays unknown", async (t) => {
  let now = Date.UTC(2026, 7, 4, 12);
  t.mock.method(Date, "now", () => now);
  const host = await hostCachemire({ model: OPENAI });
  const manager = host.session.sessionManager;
  try {
    manager.appendMessage({ role: "user", content: "first", timestamp: now });
    await request(host, { model: OPENAI.id, input: [{ role: "user", content: "first" }], prompt_cache_retention: "24h" });
    await finish(host, billed(OPENAI, 0, 100_000));
    manager.appendMessage({ role: "user", content: "second", timestamp: now + 2_000 });
    await host.session.setModel(ANTHROPIC);
    await request(host, payload(["first", "second"]));
    await finish(host, billed(ANTHROPIC, 0, 0, 100_000));

    now += 60 * 60_000;
    host.ui.notifications.length = 0;
    await host.session.setModel(OPENAI);
    assert.match(host.ui.widgetLines("pi-cachemire", 200)!.join("\n"), /cache state unknown · model switched/);
    await request(host, { model: OPENAI.id, input: [{ role: "user", content: "third" }], prompt_cache_retention: "24h" });
    assert.deepEqual(host.ui.notifications, [], "a maximum cannot make a pre-maximum switch-back cold");
    assert.match(host.ui.widgetLines("pi-cachemire", 200)!.join("\n"), /cache state unknown · model switched/);
  } finally {
    await host.dispose();
  }
});

test("model selection flips the clock before any send, and back again", async () => {
  const host = await hostCachemire({ sessionManager: restoredSession(ANTHROPIC, 3_000, 2_000) });
  const clock = () => host.ui.widgetLines("pi-cachemire", 200)!.join("\n");
  try {
    assert.doesNotMatch(clock(), /model switched/);
    await host.session.setModel(OPENAI);
    assert.match(clock(), /model switched/);
    assert.match(clock(), /next prompt ~[\d.]+k tokens to openai/);
    await host.session.setModel(ANTHROPIC);
    assert.doesNotMatch(clock(), /model switched/);
    assert.deepEqual(host.ui.notifications, [], "selection alone must never post a notice");
  } finally {
    await host.dispose();
  }
});
