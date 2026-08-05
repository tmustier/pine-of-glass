import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tokenEstimatorCapture from "../../scripts/cachemire/token-estimator-capture.ts";

type Handler = (...args: unknown[]) => unknown;

function extensionProbe(outputPath: string): { handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI;

  const previous = process.env.PI_TOKEN_ESTIMATOR_CAPTURE;
  process.env.PI_TOKEN_ESTIMATOR_CAPTURE = outputPath;
  try {
    tokenEstimatorCapture(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_TOKEN_ESTIMATOR_CAPTURE;
    else process.env.PI_TOKEN_ESTIMATOR_CAPTURE = previous;
  }
  return { handlers };
}

async function fire(probe: ReturnType<typeof extensionProbe>, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of probe.handlers.get(event) ?? []) await handler(...args);
}

const payload = {
  model: "claude-fable-5",
  system: "fixture",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

const context = {
  model: {
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-fable-5",
    input: ["text"],
  },
  sessionManager: {
    getEntries: () => [],
    getLeafId: () => null,
  },
  getSystemPrompt: () => "fixture",
};

test("capture resumes normal requests after a cancelled or failed compaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-estimator-capture-"));
  const outputPath = join(directory, "capture.jsonl");
  const probe = extensionProbe(outputPath);

  await fire(probe, "session_before_compact");
  await fire(probe, "before_provider_request", { payload }, context);
  await fire(probe, "agent_start");
  await fire(probe, "before_provider_request", { payload }, context);

  const records = readFileSync(outputPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), ["compaction_skip", "request"]);
  assert.equal(records[1].compaction, false);

  await fire(probe, "session_before_compact");
  await fire(probe, "session_compact");
  await fire(probe, "before_provider_request", { payload }, context);

  const completedRecords = readFileSync(outputPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(completedRecords.at(-1).type, "request");
  assert.equal(completedRecords.at(-1).compaction, true);
});
