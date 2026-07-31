// Model-switch forecasting (issue #57): the clock's target-currency states, the sized
// break prediction, computeSwitchForecast wiring over real pi session machinery, and
// the event flow from model_select through message_end.
import { test } from "node:test";
import assert from "node:assert/strict";

import piCachemire, { internals } from "../../extensions/pi-cachemire/index.ts";
import { computeSwitchForecast, type SwitchTarget } from "../../extensions/pi-cachemire/forecast.ts";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const { cacheClock, predictBreak, renderBreakingLine, restoreLineageSnapshots, withinWarmHorizon } = internals;

const CONTRACT_5M = { kind: "contract", ttlMs: 5 * 60_000, source: "observed" } as const;
const RATES = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const MIN = 60_000;

const FORECAST = {
  targetId: "gpt-5.6-luna", targetProvider: "openai-codex",
  windowTokens: 272_000, estTokens: 96_400, basis: "direct" as const,
};

test("clock: model switch forecasts in the target currency, always marked est", () => {
  // Per-model caches everywhere: the last call's entry is dead for the new model, and
  // the stored count is in the old tokenizer's currency, so it is never shown.
  const switched = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 142_300, rewriteUsd: 2.67, modelSwitched: true, switchForecast: FORECAST });
  assert.equal(switched.phase, "cold");
  assert.equal(switched.text, "cache cold expected \u00b7 model switched \u00b7 prompt ~96.4k of 272.0k ctx (est)");
  // Gateway routes may transform the request upstream: the claim is demoted.
  const gateway = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: { ...FORECAST, basis: "gateway" } });
  assert.equal(gateway.text, "cache cold expected \u00b7 model switched \u00b7 prompt ~96.4k of 272.0k ctx (rough est \u00b7 gateway route)");
  // Unknown target window: tokens without a share claim.
  const windowless = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: { ...FORECAST, windowTokens: undefined } });
  assert.equal(windowless.text, "cache cold expected \u00b7 model switched \u00b7 prompt ~96.4k tokens (est)");
  // Without an estimate the number is withheld outright (and stays out of the old currency).
  const untagged = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, cachedTokens: 142_300, modelSwitched: true });
  assert.equal(untagged.text, "cache cold expected \u00b7 model switched \u00b7 prompt size known at next send");
});

test("clock: A\u2192B\u2192A switch-back defers to the target's own prior entry", () => {
  // The target model's own last billed call is inside its window: "cold" would overclaim.
  const back = cacheClock({ now: MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: { ...FORECAST, prior: { requestAt: 0, window: CONTRACT_5M } } });
  assert.equal(back.phase, "warm-unknown");
  assert.equal(back.text, "cache may still be warm \u00b7 last gpt-5.6-luna call 1m ago \u00b7 next send confirms");
  // Past the prior's window the switch-back is cold expected like any other switch.
  const backCold = cacheClock({ now: 10 * MIN, lastRequestAt: 0, window: CONTRACT_5M, modelSwitched: true, switchForecast: { ...FORECAST, prior: { requestAt: 0, window: CONTRACT_5M } } });
  assert.equal(backCold.phase, "cold");
});

test("warm horizon: contract TTL, band soft edge, implicit-cache horizon", () => {
  assert.equal(withinWarmHorizon(CONTRACT_5M, 4 * MIN), true);
  assert.equal(withinWarmHorizon(CONTRACT_5M, 6 * MIN), false);
  const band = { kind: "band", softMs: 5 * MIN, hardMs: 60 * MIN } as const;
  assert.equal(withinWarmHorizon(band, 4 * MIN), true);
  assert.equal(withinWarmHorizon(band, 30 * MIN), false, "the band maybe-zone must not claim warm");
  assert.equal(withinWarmHorizon(undefined, 9 * MIN), true);
  assert.equal(withinWarmHorizon(undefined, 11 * MIN), false);
});

test("break prediction: model switch sized in the target currency, or silent when warm", () => {
  const base = { isFirst: false, inCompaction: false, compacted: false, expectedRead: 138_200, rates: RATES };
  const modelCause = { kind: "model", detail: "model switched a \u2192 b" } as const;

  // Without a forecast: certain break, but the size is in the old tokenizer \u2014 withheld.
  const model = predictBreak({ ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause })!;
  assert.equal(model.expectedRewriteTokens, undefined);
  assert.equal(renderBreakingLine(model), "cache breaking \u00b7 re-writing the full prompt \u00b7 cause: model switched a \u2192 b");

  // With a target-currency forecast: sized, est-marked, est-priced.
  const sized = predictBreak({
    ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
    switchForecast: { estTokens: 96_400, windowTokens: 272_000, basis: "direct", priorMayBeWarm: false },
  })!;
  assert.equal(sized.estimatedRewriteTokens, 96_400);
  assert.equal(sized.expectedRewriteTokens, undefined, "the old-currency size stays withheld");
  assert.equal(sized.estimatedUsd, 1.807_5); // 96.4k at $18.75/M write, still an estimate
  assert.equal(
    renderBreakingLine(sized),
    "cache breaking \u00b7 re-writing ~96.4k of 272.0k ctx (est \u00b7 ~$1.81) \u00b7 cause: model switched a \u2192 b",
  );
  assert.equal(
    renderBreakingLine(predictBreak({
      ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
      switchForecast: { estTokens: 96_400, basis: "gateway", priorMayBeWarm: false },
    })!),
    "cache breaking \u00b7 re-writing ~96.4k (rough est \u00b7 gateway route \u00b7 ~$1.81) \u00b7 cause: model switched a \u2192 b",
  );

  // A\u2192B\u2192A switch-back with the target's own entry possibly warm: no in-flight claim \u2014
  // the resolved line reports the truth when usage arrives (band maybe-zone precedent).
  assert.equal(
    predictBreak({
      ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
      switchForecast: { estTokens: 96_400, basis: "direct", priorMayBeWarm: true },
    }),
    undefined,
  );

  // Pricing tiers are request-wide: a switch estimate above the threshold prices the
  // whole request at the tier's write rate.
  const tiered = predictBreak({
    ...base, gapMs: 1_000, window: CONTRACT_5M, fingerprintCause: modelCause,
    rates: { ...RATES, tiers: [{ inputTokensAbove: 90_000, input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 }] },
    switchForecast: { estTokens: 96_400, basis: "direct", priorMayBeWarm: false },
  })!;
  assert.equal(tiered.estimatedUsd, 3.615); // 96.4k at the $37.50/M tier write rate
});

// --- computeSwitchForecast over real pi session machinery --------------------------------

function usage(input: number, cacheRead: number, cacheWrite: number) {
  return { input, output: 10, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function solAssistant(timestamp: number, prompt: number) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "r".repeat(2600), thinkingSignature: "S".repeat(2600) },
      { type: "text", text: "a".repeat(2600) },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason: "stop",
    timestamp,
    usage: usage(2, prompt - 2, 0),
  };
}

function entriesFixture(): SessionEntry[] {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "b".repeat(2600), timestamp: 1_000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T10:00:05.000Z", message: solAssistant(5_000, 80_000) },
  ] as unknown as SessionEntry[];
}

const OPUS: SwitchTarget = { provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages", contextWindow: 200_000, input: ["text", "image"] };

test("computeSwitchForecast: estimates from canonical history in the target currency", () => {
  const forecast = computeSwitchForecast({
    target: OPUS,
    entries: entriesFixture(),
    activeLeafId: "a1",
    systemPromptChars: 2_600,
    tools: [],
    snapshots: [],
  });
  assert.equal(forecast.targetId, "claude-opus-4-8");
  assert.equal(forecast.basis, "direct");
  assert.equal(forecast.windowTokens, 200_000);
  // Claude 4.7+ heuristic (chars/2.6): 2.6k system + 2.6k user + 2.6k readable thinking
  // (converted to text cross-model) + 2.6k assistant text = 4000 tokens; the 2.6k-char
  // encrypted payload never reaches the anthropic target.
  assert.equal(forecast.estTokens, 4_000);
  assert.equal(forecast.prior, undefined);
});

test("computeSwitchForecast: gateway targets are labelled, not refused a number", () => {
  const forecast = computeSwitchForecast({
    target: { provider: "radius", id: "auto", api: "pi-messages", contextWindow: 200_000 },
    entries: entriesFixture(),
    activeLeafId: "a1",
    systemPromptChars: 0,
    tools: [],
    snapshots: [],
  });
  assert.equal(forecast.basis, "gateway");
  assert.ok(forecast.estTokens !== undefined && forecast.estTokens > 0);
});

// --- event flow ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => unknown;

function extensionProbe(): { handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(): void {},
    getThinkingLevel: () => "off",
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  piCachemire(pi);
  return { handlers };
}

async function fire(probe: ReturnType<typeof extensionProbe>, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of probe.handlers.get(event) ?? []) await handler(...args);
}

function billedAssistant(model: string, api: string, prompt: number, userChars: number) {
  return [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "q".repeat(userChars), timestamp: 1_000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T10:00:05.000Z", message: {
      role: "assistant", content: [{ type: "text", text: "answer" }], provider: "anthropic", api, model,
      stopReason: "stop", timestamp: Date.now(), usage: usage(2, prompt - 2, 0),
    } },
  ];
}

function probeContext(entries: unknown[], api: string, notifications: string[], widgets: string[]) {
  return {
    hasUI: true,
    ui: {
      theme: undefined,
      setWidget(_key: string, widget?: unknown): void {
        // Cachemire also registers a TUI-capture hook through setWidget; only record
        // real widget lines.
        if (typeof widget === "function") widget({ requestRender: () => {} });
        else widgets.push(Array.isArray(widget) ? widget.join("\n") : "");
      },
      notify(text: string): void {
        notifications.push(text);
      },
    },
    model: {
      id: "claude-opus-4-8", provider: "anthropic", api, reasoning: false, contextWindow: 200_000,
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    },
    sessionManager: { getEntries: () => entries, getLeafId: () => "a1" },
    getSystemPrompt: () => "",
  };
}

const ANTHROPIC_PAYLOAD = {
  model: "claude-opus-4-8",
  system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "next" }] }],
};

test("event flow: the same model over a different wire API is a switch", async () => {
  // Baseline billed over anthropic-messages; the session resumes on bedrock-anthropic.
  const entries = billedAssistant("claude-opus-4-8", "anthropic-messages", 80_000, 200);
  const notifications: string[] = [];
  const widgets: string[] = [];
  const probe = extensionProbe();
  const ctx = probeContext(entries, "bedrock-anthropic", notifications, widgets);

  await fire(probe, "session_start", {}, ctx);
  try {
    assert.match(widgets.at(-1)!, /model switched/, "an API-only switch must flip the clock at session_start");
    assert.match(widgets.at(-1)!, /\(est\)/, "the forecast must be marked as an estimate");

    // Send time: the tiny estimated re-write is below the materiality thresholds, so
    // no break notice is posted (the widget already explains the switch).
    await fire(probe, "before_provider_request", { payload: ANTHROPIC_PAYLOAD }, ctx);
    assert.equal(notifications.length, 0, "an immaterial estimated re-write must not post a notice");
    assert.match(widgets.at(-1)!, /model switched/);

    // Usage billed over the new API re-baselines: the switch state clears.
    await fire(probe, "message_end", { message: {
      role: "assistant", content: [], provider: "anthropic", api: "bedrock-anthropic", model: "claude-opus-4-8",
      stopReason: "stop", timestamp: Date.now(), usage: usage(80_000, 0, 0),
    } });
    assert.doesNotMatch(widgets.at(-1)!, /model switched/, "fresh usage must re-baseline the currency");
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});

test("event flow: a material estimated re-write posts one est-marked notice", async () => {
  // 200k chars of history → ~77k estimated tokens, far above the 20k threshold.
  const entries = billedAssistant("claude-opus-4-8", "anthropic-messages", 80_000, 200_000);
  const notifications: string[] = [];
  const widgets: string[] = [];
  const probe = extensionProbe();
  const ctx = probeContext(entries, "bedrock-anthropic", notifications, widgets);

  await fire(probe, "session_start", {}, ctx);
  try {
    await fire(probe, "before_provider_request", { payload: ANTHROPIC_PAYLOAD }, ctx);
    assert.equal(notifications.length, 1, "a material estimated re-write must post a notice");
    assert.match(notifications[0]!, /re-writing ~7[0-9]\.\dk of 200\.0k ctx \(est/);
    assert.match(notifications[0]!, /model switched/);
  } finally {
    await fire(probe, "session_shutdown", {});
  }
});

test("computeSwitchForecast: finds the target's own prior call on the active path only", () => {
  const entries = entriesFixture();
  const snapshots = restoreLineageSnapshots(entries, () => CONTRACT_5M);
  // Switching back to sol itself: its billed call at a1 is on the path.
  const backToSol = computeSwitchForecast({
    target: { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" },
    entries, activeLeafId: "a1", systemPromptChars: 0, tools: [], snapshots,
  });
  assert.ok(backToSol.prior, "the target's own billed call must be found");
  assert.equal(backToSol.prior!.window!.kind, "contract");
  // Switching to a model that never billed on this path: no prior.
  const toOpus = computeSwitchForecast({
    target: OPUS, entries, activeLeafId: "a1", systemPromptChars: 0, tools: [], snapshots,
  });
  assert.equal(toOpus.prior, undefined);
});
