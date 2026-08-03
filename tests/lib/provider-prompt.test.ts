import { test } from "node:test";
import assert from "node:assert/strict";

import { forecastProviderPrompt } from "../../extensions/_lib/provider-prompt.ts";

const FALLBACK = { provider: "custom", id: "model", api: "custom-api" };

test("provider prompt: sizes only prompt-bearing wire fields", () => {
  const forecast = forecastProviderPrompt({
    model: "x".repeat(100_000),
    instructions: "rule",
    input: "m".repeat(400),
    temperature: "x".repeat(100_000),
  }, FALLBACK);
  assert.equal(forecast?.tokens, 101, "4 system chars + 400 input chars at the fallback 4 chars/token");
});

test("provider prompt: reads pi-messages context after local payload transforms", () => {
  const forecast = forecastProviderPrompt({
    model: "auto",
    context: {
      systemPrompt: "s".repeat(40),
      messages: "m".repeat(400),
      tools: undefined,
    },
    options: { sessionId: "x".repeat(100_000) },
  }, FALLBACK);
  assert.equal(forecast?.tokens, 110);
});

test("provider prompt: image bytes use a flat convention, not base64 length", () => {
  const payload = (data: string) => ({
    input: [{ role: "user", content: [{ type: "input_image", image_url: data }] }],
  });
  const short = forecastProviderPrompt(payload("data:image/png;base64,a"), FALLBACK);
  const long = forecastProviderPrompt(payload(`data:image/png;base64,${"a".repeat(100_000)}`), FALLBACK);
  assert.deepEqual(long, short);
  assert.ok((long?.tokens ?? 0) > 1_000, "one image retains pi's 4.8k-char size convention");
});

test("provider prompt: unknown shapes are not sized", () => {
  assert.equal(forecastProviderPrompt({ metadata: "not a prompt" }, FALLBACK), undefined);
});
