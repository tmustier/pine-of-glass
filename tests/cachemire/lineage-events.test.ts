import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC, billed, finish, hostCachemire, payload, request } from "./event-fixtures.ts";

test("first request after hot reload diagnoses a changed tool schema", async () => {
  const host = await hostCachemire();
  const manager = host.session.sessionManager;
  const oldTool = { name: "computer_use", description: "Control apps", input_schema: { type: "object" } };
  try {
    manager.appendMessage({ role: "user", content: "before reload", timestamp: Date.now() });
    await request(host, payload(["before reload"], [oldTool]));
    await finish(host, billed(ANTHROPIC, 2, 99_998));
    await host.session.extensionRunner.emit({ type: "agent_end", messages: [] });
    await host.session.reload();

    manager.appendMessage({ role: "user", content: "after reload", timestamp: Date.now() });
    const changedTool = {
      ...oldTool,
      input_schema: { type: "object", properties: { code: { type: "string" } } },
    };
    await request(host, payload(["before reload", "after reload"], [changedTool]));
    assert.match(host.ui.notifications.at(-1)!, /cause: tools changed \(1 modified\)/);
  } finally {
    await host.dispose();
  }
});

test("tree navigation rebases classification to the selected provider-known prompt", async () => {
  const host = await hostCachemire();
  const manager = host.session.sessionManager;
  try {
    manager.appendMessage({ role: "user", content: "base", timestamp: Date.now() });
    await request(host, payload(["base"]));
    const baseline = await finish(host, billed(ANTHROPIC, 2, 99_998));
    manager.appendMessage({ role: "user", content: "old branch", timestamp: Date.now() });
    await request(host, payload(["base", "old branch"]));
    await finish(host, billed(ANTHROPIC, 2, 199_998));

    await host.session.navigateTree(baseline);
    manager.appendMessage({ role: "user", content: "new branch", timestamp: Date.now() });
    await request(host, payload(["base", "new branch"]));
    assert.deepEqual(host.ui.notifications, [], "branching must not price the abandoned 200k leaf");
    await finish(host, billed(ANTHROPIC, 0, 90_000, 10_000));

    manager.appendMessage({ role: "user", content: "aborted suffix", timestamp: Date.now() });
    await request(host, payload(["base", "new branch", "aborted suffix"]));
    await host.session.extensionRunner.emit({ type: "agent_end", messages: [] });
    await host.session.prompt("/cache");
    assert.equal(host.ui.notifications.length, 1);
    assert.match(host.ui.notifications[0]!, /\s3\s+.*● hit/);
  } finally {
    await host.dispose();
  }
});
