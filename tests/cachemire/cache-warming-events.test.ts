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
