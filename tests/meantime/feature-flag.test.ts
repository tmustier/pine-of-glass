// Meantime is shipped in the package before its experimental UX is ready for every
// user. This test pins the registration boundary: disabled means no runtime surface,
// while the explicit opt-in wires the complete extension.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerMeantime } from "../../extensions/pi-meantime/index.ts";
import { DEFAULT_CONFIG } from "../../extensions/pi-meantime/timing.ts";

function registrationProbe(): { pi: ExtensionAPI; events: string[]; commands: string[] } {
  const events: string[] = [];
  const commands: string[] = [];
  const pi = {
    on(event: string, _handler: unknown): void {
      events.push(event);
    },
    registerCommand(name: string, _options: unknown): void {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, commands };
}

test("feature flag: disabled registers no hooks, timer path, UI, or command", () => {
  const probe = registrationProbe();
  registerMeantime(probe.pi, DEFAULT_CONFIG);
  assert.deepEqual(probe.events, []);
  assert.deepEqual(probe.commands, []);
});

test("feature flag: explicit opt-in registers the runtime and /pace", () => {
  const probe = registrationProbe();
  registerMeantime(probe.pi, { ...DEFAULT_CONFIG, enabled: true });
  assert.deepEqual(probe.events, [
    "session_start",
    "session_shutdown",
    "model_select",
    "agent_start",
    "before_provider_request",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "agent_end",
    "agent_settled",
  ]);
  assert.deepEqual(probe.commands, ["pace"]);
});
