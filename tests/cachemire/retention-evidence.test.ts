// Provider retention evidence contract. Update this matrix, retention.ts and the dated
// table in docs/pi-cachemire.md together when provider documentation changes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pastWindow } from "../../extensions/pi-cachemire/classify.ts";
import {
  inferAnthropicTtlMs,
  OPENAI_EXTENDED_WINDOW,
  windowForModel,
  windowForRequest,
  windowLabel,
} from "../../extensions/pi-cachemire/retention.ts";

const MIN = 60_000;
const CONTRACT_5M = { kind: "contract", ttlMs: 5 * MIN, source: "observed" } as const;

test("retention resolution requires route, model family and observed request policy", (t) => {
  const configuredRetention = process.env.PI_CACHE_RETENTION;
  delete process.env.PI_CACHE_RETENTION;
  t.after(() => {
    if (configuredRetention === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = configuredRetention;
  });

  assert.deepEqual(windowForModel("anthropic"), { kind: "contract", ttlMs: 5 * MIN, source: "inferred" });
  assert.equal(windowForModel("openai-codex", "gpt-5.6-sol"), undefined);
  assert.equal(windowForModel("openai", "gpt-5.6"), undefined);
  assert.equal(windowForModel("mistral"), undefined);

  assert.equal(
    windowForRequest("openai", "gpt-5.4", { prompt_cache_retention: "24h" }),
    OPENAI_EXTENDED_WINDOW,
  );
  assert.equal(windowForRequest("openai", "gpt-5.4", {}), undefined, "an omitted policy is unknown");
  assert.equal(
    windowForRequest("openai", undefined, { prompt_cache_retention: "24h" }),
    undefined,
    "an unrecognized model cannot inherit a GPT-5 policy",
  );
  assert.equal(
    windowForRequest("openai", "gpt-5.4", { prompt_cache_retention: "1h" }),
    undefined,
    "unsupported policy values are unknown",
  );
  assert.equal(
    windowForRequest("openai", "gpt-5.6", { prompt_cache_retention: "24h" }),
    undefined,
    "GPT-5.6 does not use the legacy maximum policy",
  );
  assert.equal(
    windowForRequest("openai", "gpt-5-6-sol", { prompt_cache_retention: "24h" }),
    undefined,
    "an unrecognized alias fails closed",
  );
  assert.equal(
    windowForRequest("openai-codex", "gpt-5.6-sol", { prompt_cache_retention: "24h" }),
    undefined,
    "openai-codex is a separate route with no retention contract",
  );
});

test("retention labels and hard expiry match the evidence type", () => {
  assert.equal(windowLabel(CONTRACT_5M), "5m TTL");
  assert.equal(windowLabel({ kind: "contract", ttlMs: 60 * MIN, source: "inferred" }), "1h TTL (inferred)");
  assert.equal(windowLabel(OPENAI_EXTENDED_WINDOW), "24h maximum");
  assert.equal(windowLabel({ kind: "unknown" }), "retention unknown");

  assert.equal(pastWindow(CONTRACT_5M, 5 * MIN - 1), false);
  assert.equal(pastWindow(CONTRACT_5M, 5 * MIN), true, "the exact TTL boundary is expired");
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
