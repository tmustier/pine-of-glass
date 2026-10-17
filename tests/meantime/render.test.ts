import { test } from "node:test";
import assert from "node:assert/strict";

import { renderPace } from "../../extensions/pi-meantime/render.ts";
import { DEFAULT_CONFIG, sessionTotals, type CallTiming } from "../../extensions/pi-meantime/timing.ts";

function call(index: number, model: string): CallTiming {
  return {
    index,
    model,
    ttftMs: 1_000,
    thinkMs: 0,
    writeMs: 1_000,
    writeChars: 300,
    totalMs: 2_000,
    outputTokens: 100,
    silentReasoning: false,
    uncachedPromptTokens: 1_000,
    tokPerSec: 100,
  };
}

test("renderPace identifies provider-qualified model transitions", () => {
  const calls = [call(1, "anthropic/shared-id"), call(2, "openai/shared-id")];
  const lines = renderPace(
    calls,
    sessionTotals(calls, { startedAt: 0, now: 4_000, idleMs: 0 }),
    { config: DEFAULT_CONFIG, modelLabel: "openai/current-model" },
  );
  const rendered = lines.join("\n");
  assert.match(rendered, /process-local · 2 models/);
  assert.doesNotMatch(rendered, /openai\/current-model/);
  assert.match(rendered, /\b1\b.*model anthropic\/shared-id/);
  assert.match(rendered, /\b2\b.*model openai\/shared-id/);
});
