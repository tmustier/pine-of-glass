import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC, billed, finish, hostCachemire, payload, request } from "./event-fixtures.ts";

test("a cache-warming payload hook without context cannot replace real-call evidence", async () => {
  const host = await hostCachemire();
  const manager = host.session.sessionManager;
  const body = payload(["first"]);
  try {
    manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    await request(host, body);
    await finish(host, billed(ANTHROPIC, 0, 0, 100_000));

    await host.session.extensionRunner.emitBeforeProviderRequest({
      ...body,
      system: [{ type: "text", text: "warm replay must not become user-call evidence", cache_control: { type: "ephemeral" } }],
    });
    assert.deepEqual(host.ui.notifications, [], "background traffic must not post a break notice");

    manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
    await request(host, payload(["first", "next"]));
    assert.deepEqual(host.ui.notifications, [], "the real request still shares the first call's system prefix");
    await finish(host, billed(ANTHROPIC, 0, 100_000));

    manager.appendMessage({ role: "user", content: "changed", timestamp: Date.now() });
    await request(host, {
      ...payload(["first", "next", "changed"]),
      system: [{ type: "text", text: "a real changed request", cache_control: { type: "ephemeral" } }],
    });
    assert.equal(host.ui.notifications.length, 1);
    assert.match(host.ui.notifications[0]!, /cause: system prompt changed/);
  } finally {
    await host.dispose();
  }
});

test("a provider's second attempt of the same request is the payload Cachemire compares next time", async () => {
  const host = await hostCachemire({ reason: "new" });
  const manager = host.session.sessionManager;
  const strict = [{ name: "edit", input_schema: { type: "object" }, strict: true }];
  const relaxed = [{ name: "edit", input_schema: { type: "object" } }];
  const changed = [{ name: "edit", input_schema: { type: "object", properties: { path: { type: "string" } } } }];
  try {
    manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    await request(host, payload(["first"], strict));
    // Anthropic rejected the strict schema; the billed request is the fallback.
    await host.session.extensionRunner.emitBeforeProviderRequest(payload(["first"], relaxed));
    await finish(host, billed(ANTHROPIC, 0, 0, 100_000));

    manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
    await request(host, payload(["first", "next"], relaxed));
    assert.deepEqual(host.ui.notifications, [], "the billed tools did not change");
    await finish(host, billed(ANTHROPIC, 0, 100_000));

    manager.appendMessage({ role: "user", content: "changed", timestamp: Date.now() });
    await request(host, payload(["first", "next", "changed"], changed));
    assert.match(host.ui.notifications.at(-1) ?? "", /cause: tools changed/);
  } finally {
    await host.dispose();
  }
});
