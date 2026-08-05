import { test } from "node:test";
import assert from "node:assert/strict";

import { pastWindow } from "../../extensions/pi-cachemire/classify.ts";
import {
  inferAnthropicTtlMs,
  OPENAI_EXTENDED_WINDOW,
  OPENAI_MINIMUM_WINDOW,
  windowForModel,
  windowForRequest,
  windowLabel,
} from "../../extensions/pi-cachemire/retention.ts";

const MIN = 60_000;
const CONTRACT_5M = { kind: "contract", ttlMs: 5 * MIN, source: "observed" } as const;

function requestWindow(
  provider: string,
  model: string | undefined,
  payload: unknown,
  fingerprint: { kind: "anthropic" | "openai-responses" | "unknown"; ttlMs?: number } = {
    kind: "openai-responses",
  },
) {
  return windowForRequest({ provider, model, payload, fingerprint });
}

test("retention resolution requires route, model family and observed request policy", () => {
  assert.deepEqual(
    windowForModel("anthropic", undefined, {}),
    { kind: "contract", ttlMs: 5 * MIN, source: "inferred" },
  );
  assert.equal(windowForModel("openai-codex", "gpt-5.6-sol"), OPENAI_MINIMUM_WINDOW);
  assert.equal(windowForModel("openai", "gpt-5.6"), OPENAI_MINIMUM_WINDOW);
  assert.equal(windowForModel("openai", "gpt-5.10"), OPENAI_MINIMUM_WINDOW);
  assert.equal(windowForModel("openai", "gpt-5.5"), undefined);
  assert.equal(windowForModel("mistral", "gpt-5.6"), undefined);

  assert.deepEqual(
    requestWindow("anthropic", "claude-opus-4-8", {}, { kind: "anthropic", ttlMs: 5 * MIN }),
    CONTRACT_5M,
    "live Anthropic evidence resolves through the same registry",
  );
  assert.equal(
    requestWindow("radius", "claude-opus-4-8", {}, { kind: "anthropic", ttlMs: 5 * MIN }),
    undefined,
    "an Anthropic-shaped gateway payload does not inherit the direct route contract",
  );
  assert.equal(
    requestWindow("openai", "gpt-5.4", { prompt_cache_retention: "24h" }),
    OPENAI_EXTENDED_WINDOW,
  );
  assert.equal(requestWindow("openai", "gpt-5.4", {}), undefined, "an omitted policy is unknown");
  assert.equal(
    requestWindow("openai", undefined, { prompt_cache_retention: "24h" }),
    undefined,
    "an unrecognized model cannot inherit a GPT-5 policy",
  );
  assert.equal(
    requestWindow("openai", "gpt-5.6", { prompt_cache_retention: "24h" }),
    OPENAI_MINIMUM_WINDOW,
    "GPT-5.6 uses the default minimum, not the deprecated maximum policy",
  );
  assert.equal(
    requestWindow("openai-codex", "gpt-5.6-sol", {}),
    OPENAI_MINIMUM_WINDOW,
    "the documented GPT-5.6 default also applies through Codex",
  );
  assert.equal(
    requestWindow("openai-codex", "gpt-5.6-sol", {}, { kind: "unknown" }),
    undefined,
    "the documented route still requires the matching request shape on a live send",
  );
});

test("retention labels and hard expiry match the evidence type", () => {
  assert.equal(windowLabel(CONTRACT_5M), "5m TTL");
  assert.equal(windowLabel({ kind: "contract", ttlMs: 60 * MIN, source: "inferred" }), "1h TTL (inferred)");
  assert.equal(windowLabel(OPENAI_MINIMUM_WINDOW), "30m minimum");
  assert.equal(windowLabel(OPENAI_EXTENDED_WINDOW), "24h maximum");
  assert.equal(windowLabel({ kind: "unknown" }), "retention unknown");

  assert.equal(pastWindow(CONTRACT_5M, 5 * MIN - 1), false);
  assert.equal(pastWindow(CONTRACT_5M, 5 * MIN), true, "the exact TTL boundary is expired");
  assert.equal(pastWindow(OPENAI_MINIMUM_WINDOW, 30 * MIN - 1), false);
  assert.equal(pastWindow(OPENAI_MINIMUM_WINDOW, 30 * MIN), false, "a minimum is not an expiry");
  assert.equal(pastWindow(OPENAI_EXTENDED_WINDOW, 24 * 60 * MIN - 1), false);
  assert.equal(
    pastWindow(OPENAI_EXTENDED_WINDOW, 24 * 60 * MIN),
    true,
    "the exact maximum boundary is expired",
  );
  assert.equal(pastWindow({ kind: "unknown" }, 90 * MIN), false);
  assert.equal(pastWindow(undefined, 90 * MIN), false);
});

test("Anthropic restored-session inference mirrors pi-ai's environment rule", () => {
  assert.equal(inferAnthropicTtlMs({}), 5 * MIN);
  assert.equal(inferAnthropicTtlMs({ PI_CACHE_RETENTION: "long" }), 60 * MIN);
  assert.equal(inferAnthropicTtlMs({ PI_CACHE_RETENTION: "short" }), 5 * MIN);
});
