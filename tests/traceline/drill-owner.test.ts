// Drill mode belongs to the session that owns Traceline's terminal patches.
import { test } from "node:test";
import assert from "node:assert/strict";

import piTraceline from "../../extensions/pi-traceline/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

test("/drill in an RPC session beside the terminal session does nothing", async () => {
  const project = new IsolatedProject();
  const terminal = await hostExtension(piTraceline, { project });
  const rpc = await hostExtension(piTraceline, { project, mode: "rpc" });
  try {
    await rpc.session.prompt("/drill");
    assert.deepEqual(rpc.ui.notifications, [], "the RPC session entered drill mode over the terminal's chat");
    await terminal.session.prompt("/drill");
    assert.deepEqual(terminal.ui.notifications, ["traceline: no tool rows to drill into"]);
  } finally {
    await rpc.dispose();
    await terminal.dispose();
    project.dispose();
  }
});
