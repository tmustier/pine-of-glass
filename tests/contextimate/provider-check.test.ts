// Issue #8 checker: request-building is pure and tested here; network execution is
// manual-only (--live) and never happens in tests. The core honesty invariant: the
// checker counts byte-identical payload sections — the same payloads contextimate's
// displayed estimates are computed over — never a re-shaped approximation.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePayloadFile,
  detectPayloadKind,
  buildAnthropicCountRequests,
  buildOpenAIResponsesProbes,
  computeToolOverhead,
  summarizeCounts,
  suggestDenominators,
  PROVIDERS,
} from "../../scripts/contextimate/check-provider-tokens.mjs";
import { internals } from "../../extensions/pi-contextimate/index.ts";
import { fakePi, fixtureSystemPrompt, anthropicModel } from "../helpers.ts";

const { buildSnapshot, toolPayloadForShape } = internals;

// Captured-payload fixture whose tools are exactly the payloads contextimate displays
// estimates for (anthropic shape) — provenance shared with the estimator, not invented.
function capturedAnthropicPayload() {
  const snapshot = buildSnapshot(fakePi(), () => fixtureSystemPrompt(), undefined, () => undefined, () => anthropicModel, {});
  const activeTools = snapshot.tools.filter((tool) => tool.source !== "inactive");
  return {
    model: "claude-opus-4-8",
    max_tokens: 8192,
    system: [{ type: "text", text: fixtureSystemPrompt() }],
    messages: [{ role: "user", content: [{ type: "text", text: "real conversation" }] }],
    tools: snapshot.tools.slice(0, 3).map((tool) => toolPayloadForShape(tool, "anthropic", "anthropic")),
    displayedToolCount: activeTools.length, // not part of the provider body; ignored by builders
  };
}

test("anthropic count requests pass payload sections through byte-identical", () => {
  const payload = capturedAnthropicPayload();
  const requests = buildAnthropicCountRequests(payload, {});
  const byId = Object.fromEntries(requests.map((request) => [request.id, request]));

  assert.deepEqual(
    Object.keys(byId).sort(),
    ["baseline", "full", "system", "tool:bash", "tool:read", "tool:search", "tools"].sort(),
  );
  // The #8 invariant: counted tools === displayed tools, byte for byte.
  assert.equal(JSON.stringify(byId.tools!.body.tools), JSON.stringify(payload.tools));
  assert.equal(JSON.stringify(byId.full!.body.tools), JSON.stringify(payload.tools));
  assert.equal(JSON.stringify(byId["tool:read"]!.body.tools), JSON.stringify([payload.tools[0]]));
  assert.equal(JSON.stringify(byId.system!.body.system), JSON.stringify(payload.system));
  // Isolation: every request swaps the real conversation for one minimal user message.
  for (const request of requests) {
    assert.deepEqual(request.body.messages, [{ role: "user", content: "hi" }], request.id);
    assert.equal(request.body.max_tokens, undefined, "count_tokens takes no max_tokens");
  }
  assert.equal(byId.baseline!.body.tools, undefined);
  assert.equal(byId.baseline!.body.system, undefined);
});

test("tool limiting and model override", () => {
  const payload = capturedAnthropicPayload();
  const requests = buildAnthropicCountRequests(payload, { tools: ["bash"], model: "claude-haiku-4-5" });
  const ids = requests.map((request) => request.id);
  assert.ok(ids.includes("tool:bash") && !ids.includes("tool:read"));
  for (const request of requests) assert.equal(request.body.model, "claude-haiku-4-5");
  const tools = requests.find((request) => request.id === "tools")!;
  assert.equal(tools.body.tools!.length, 1);
});

test("openai responses probes: passthrough, bounded output, no storage", () => {
  const payload = {
    model: "gpt-5.5",
    instructions: "You are a fixture.",
    input: [{ role: "user", content: [{ type: "input_text", text: "real" }] }],
    tools: [{ type: "function", name: "ping", description: "Send a ping.", parameters: { type: "object" }, strict: null }],
  };
  const requests = buildOpenAIResponsesProbes(payload, {});
  const byId = Object.fromEntries(requests.map((request) => [request.id, request]));
  assert.equal(JSON.stringify(byId["tool:ping"]!.body.tools), JSON.stringify(payload.tools));
  assert.equal(byId.system!.body.instructions, payload.instructions);
  for (const request of requests) {
    assert.equal(request.body.max_output_tokens, 16, "probe output must stay tiny — these cost real money");
    assert.equal(request.body.store, false, "probes must not persist on the provider");
    assert.deepEqual(request.body.input, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  }
});

test("payload file parsing: JSONL takes the first recognizable payload; kinds detected", () => {
  const anthropic = { model: "claude-opus-4-8", system: "s", messages: [], tools: [] };
  const later = { model: "claude-opus-4-8", messages: [{ role: "user", content: "longer session" }] };
  const parsed = parsePayloadFile(`${JSON.stringify(anthropic)}\n${JSON.stringify(later)}\n`);
  assert.equal(parsed.kind, "anthropic");
  assert.equal(parsed.payload.system, "s");

  const responses = parsePayloadFile(JSON.stringify({ model: "gpt-5.5", instructions: "x", input: [] }));
  assert.equal(responses.kind, "openai-responses");

  assert.equal(detectPayloadKind({ random: true }), undefined);
  assert.throws(() => parsePayloadFile(JSON.stringify({ random: true })), /no recognizable provider payload/);
});

test("anthropic executor: correct endpoint, headers, and body round-trip (stubbed fetch)", async () => {
  const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
  const fetchImpl = async (url: string, init: unknown) => {
    calls.push({ url, init: init as (typeof calls)[number]["init"] });
    return { ok: true, json: async () => ({ input_tokens: 1234 }) };
  };
  const body = { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] };
  const tokens = await PROVIDERS.anthropic.execute(body, { apiKey: "test-key", fetchImpl });
  assert.equal(tokens, 1234);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages/count_tokens");
  assert.equal(calls[0]!.init.headers["x-api-key"], "test-key");
  assert.equal(calls[0]!.init.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(calls[0]!.init.body), body);
});

test("summary math: marginals, solved tool-block overhead, and denominator suggestions", () => {
  const payload = capturedAnthropicPayload();
  const requests = buildAnthropicCountRequests(payload, {});
  // Synthetic provider counts with a fixed 115-token tool-block overhead baked in:
  //   count(tool_i) = baseline + 115 + t_i with t_read=85, t_bash=95, t_search=105
  //   count(tools)  = baseline + 115 + (85+95+105) = 10 + 115 + 285 = 410
  const counts: Record<string, number> = {
    baseline: 10,
    system: 110,
    tools: 410,
    "tool:read": 10 + 115 + 85,
    "tool:bash": 10 + 115 + 95,
    "tool:search": 10 + 115 + 105,
    full: 510,
  };
  // F = (Σ(count_i − baseline) − (count_all − baseline)) / (N − 1) = (630 − 400) / 2 = 115
  assert.equal(computeToolOverhead(requests, counts), 115);

  const summary = summarizeCounts(requests, counts);
  assert.equal(summary.toolOverhead, 115);
  const byId = Object.fromEntries(summary.rows.map((row) => [row.id, row]));
  assert.equal(byId.baseline!.marginal, undefined);
  assert.equal(byId.system!.marginal, 100);
  assert.equal(byId.system!.netTokens, 100, "overhead correction must not touch text rows");
  // Net per-tool costs recover the baked-in t_i exactly.
  assert.equal(byId["tool:read"]!.marginal, 200);
  assert.equal(byId["tool:read"]!.netTokens, 85);
  assert.equal(byId["tool:bash"]!.netTokens, 95);
  assert.equal(byId["tool:search"]!.netTokens, 105);
  assert.equal(byId.tools!.netTokens, 285, "all-tools net = Σ true tool costs");
  assert.equal(byId.full!.marginal, 500);

  // chars/token uses net, so small probes cannot overstate per-tool cost.
  const toolsChars = JSON.stringify(payload.tools).length;
  assert.equal(byId.tools!.charsPerToken, toolsChars / 285);
  const systemChars = JSON.stringify(payload.system).length - 2;
  assert.equal(byId.system!.charsPerToken, systemChars / 100);

  const suggestion = suggestDenominators(summary);
  assert.equal(suggestion.textDenominator, Number((systemChars / 100).toFixed(2)));
  assert.equal(suggestion.toolDenominator, Number((toolsChars / 285).toFixed(2)));

  // With fewer than two per-tool counts the overhead is unsolvable — no correction.
  const sparse = summarizeCounts(requests, { baseline: 10, tools: 410, "tool:read": 210, full: 510 });
  assert.equal(sparse.toolOverhead, undefined);
  const sparseRead = sparse.rows.find((row) => row.id === "tool:read")!;
  assert.equal(sparseRead.netTokens, 200, "uncorrected marginal when overhead is unknown");
});
