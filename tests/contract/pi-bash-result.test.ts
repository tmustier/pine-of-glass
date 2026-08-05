import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import { createBashTool } from "@earendil-works/pi-coding-agent";

test("pi bash final results preserve traceline's silent-merge evidence seam", async () => {
  const bash = createBashTool(tmpdir(), {
    exposeSessionEnvironment: false,
    operations: { exec: async () => ({ exitCode: 0 }) },
  });
  const result = await bash.execute("silent-bash", { command: "true" }, undefined, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "(no output)" }]);
});
