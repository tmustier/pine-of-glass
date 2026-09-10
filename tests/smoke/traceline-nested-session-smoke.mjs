#!/usr/bin/env node
// PR #105's reproduction in a real fullscreen Pi: a headless child session that loads
// Traceline starts and ends in the parent's process; the rails must survive it, and
// Ctrl+T twice must bring them back without Pi's "Thinking blocks" status line.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClickFixture } from "./click-fixture.mjs";

const { cwd, timestamp, assistant, append, keys, wait, launch, close } = createClickFixture("nested-session", {
  extension: join(dirname(fileURLToPath(import.meta.url)), "nested-session-extension.ts"),
});

try {
  append({ role: "user", content: [{ type: "text", text: "Nested session fixture" }], timestamp });
  append(assistant([{ type: "text", text: "Read three sibling files." }]));
  for (const [i, name] of ["alpha", "beta", "gamma"].entries()) {
    const id = `call-${i}`;
    append(assistant([{ type: "toolCall", id, name: "read", arguments: { path: join(cwd, "src", `${name}.txt`) } }], "toolUse"));
    append({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `OUTPUT_${name.toUpperCase()}` }], isError: false, timestamp });
  }
  append(assistant([{ type: "text", text: "NESTED_FIXTURE_READY" }]));
  launch(100, 40);
  wait((s) => s.includes("NESTED_FIXTURE_READY") && s.includes("3 calls"), "fixture did not become compact");

  keys("-l", "/child"); keys("Enter");
  wait((s) => s.includes("CHILD_DONE") && s.includes("3 calls"), "rails did not survive the child session");

  keys("C-t");
  wait((s) => s.includes("read ~/project/src/gamma.txt"), "Ctrl+T did not switch to the native view");
  keys("C-t");
  wait(
    (s) => s.includes("3 calls") && !s.includes("OUTPUT_") && !s.includes("Thinking blocks:"),
    "rails or the Ctrl+T status suppression did not come back after the child session",
  );
  console.log("real-Pi nested session smoke passed");
} finally {
  close();
}
