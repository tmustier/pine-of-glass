// Cachemire forensics: fingerprinting, miss-cause naming, and classification.
// The load-bearing invariant: pi moves its cache_control breakpoint to the last user
// message on every request, so fingerprints must strip cache_control — otherwise every
// healthy call would be misdiagnosed as "history mutated".
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";

const { stripCacheControl, fingerprintPayload, diffFingerprints, classifyCall } = internals;

const MIN = 60_000;

function anthropicPayload(options: {
  model?: string;
  system?: string;
  tools?: Array<{ name: string; description: string }>;
  userTexts?: string[];
  breakpointIndex?: number; // which user message carries cache_control
  ttl?: "1h";
} = {}) {
  const userTexts = options.userTexts ?? ["first message"];
  const breakpointIndex = options.breakpointIndex ?? userTexts.length - 1;
  return {
    model: options.model ?? "claude-opus-4-8",
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: options.system ?? "You are a fixture.",
        cache_control: { type: "ephemeral", ...(options.ttl ? { ttl: options.ttl } : {}) },
      },
    ],
    tools: (options.tools ?? [{ name: "bash", description: "Run a command." }]).map((tool, index, all) => ({
      ...tool,
      input_schema: { type: "object", properties: {} },
      ...(index === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    })),
    messages: userTexts.map((text, index) => ({
      role: "user",
      content: [
        {
          type: "text",
          text,
          ...(index === breakpointIndex ? { cache_control: { type: "ephemeral" } } : {}),
        },
      ],
    })),
  };
}

test("stripCacheControl removes breakpoints recursively, preserving everything else", () => {
  const stripped = stripCacheControl(anthropicPayload()) as Record<string, unknown>;
  assert.equal(JSON.stringify(stripped).includes("cache_control"), false);
  assert.equal((stripped.system as Array<{ text: string }>)[0]!.text, "You are a fixture.");
  assert.equal((stripped.tools as Array<{ name: string }>)[0]!.name, "bash");
});

test("moving the breakpoint between calls is NOT a mutation", () => {
  const call1 = fingerprintPayload(anthropicPayload({ userTexts: ["a"], breakpointIndex: 0 }));
  const call2 = fingerprintPayload(anthropicPayload({ userTexts: ["a", "b"], breakpointIndex: 1 }));
  assert.equal(diffFingerprints(call1, call2), undefined, "appended message + moved breakpoint must not diff");
});

test("fingerprint detects provider kind and TTL from observed cache_control", () => {
  const anthropic = fingerprintPayload(anthropicPayload());
  assert.equal(anthropic.kind, "anthropic");
  assert.equal(anthropic.ttlMs, 5 * MIN);
  assert.equal(fingerprintPayload(anthropicPayload({ ttl: "1h" })).ttlMs, 60 * MIN);

  const openai = fingerprintPayload({
    model: "gpt-5.5",
    instructions: "fixture",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [{ type: "function", name: "ping", parameters: {} }],
  });
  assert.equal(openai.kind, "openai-responses");
  assert.equal(openai.ttlMs, undefined, "implicit caches have no TTL contract");
  assert.equal(openai.toolHashes[0]!.name, "ping");
  assert.equal(fingerprintPayload({ random: true }).kind, "unknown");
});

test("fingerprint canonicalizes thinking/reasoning params", () => {
  assert.equal(fingerprintPayload(anthropicPayload()).thinking, "thinking off");
  assert.equal(
    fingerprintPayload({ ...anthropicPayload(), thinking: { type: "disabled" } }).thinking,
    "thinking off",
  );
  assert.equal(
    fingerprintPayload({ ...anthropicPayload(), thinking: { type: "enabled", budget_tokens: 8192 } }).thinking,
    "thinking budget 8192",
  );
  // Adaptive models (claude-fable-5 et al.) carry the level in output_config.effort.
  assert.equal(
    fingerprintPayload({
      ...anthropicPayload(),
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    }).thinking,
    "thinking effort xhigh",
  );
  const openaiBody = {
    model: "gpt-5.5",
    instructions: "fixture",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };
  assert.equal(fingerprintPayload(openaiBody).thinking, "effort default");
  assert.equal(fingerprintPayload({ ...openaiBody, reasoning: { effort: "high" } }).thinking, "effort high");

  // The diff names the thinking change as the root cause — even though disabling thinking
  // can also churn rendered history, the param change is what the user did.
  const before = fingerprintPayload({ ...anthropicPayload(), thinking: { type: "enabled", budget_tokens: 4096 } });
  const after = fingerprintPayload({ ...anthropicPayload(), thinking: { type: "enabled", budget_tokens: 16384 } });
  const cause = diffFingerprints(before, after)!;
  assert.equal(cause.kind, "thinking");
  assert.equal(cause.detail, "thinking changed (thinking budget 4096 \u2192 thinking budget 16384)");
});

test("diff names the first divergent segment", () => {
  const base = anthropicPayload({
    tools: [
      { name: "bash", description: "Run a command." },
      { name: "read", description: "Read a file." },
    ],
  });
  const fp = (payload: unknown) => fingerprintPayload(payload);

  assert.equal(diffFingerprints(fp(base), fp({ ...base, model: "claude-haiku-4-5" }))!.kind, "model");
  assert.match(
    diffFingerprints(fp(base), fp(anthropicPayload({ system: "Changed.", tools: base.tools.map(({ name, description }) => ({ name, description })) })))!.detail,
    /system prompt changed/,
  );

  const toolsChanged = anthropicPayload({
    tools: [
      { name: "bash", description: "Run a command, now different." }, // modified
      { name: "search", description: "New tool." }, // added (read removed)
    ],
  });
  const toolCause = diffFingerprints(fp(base), fp(toolsChanged))!;
  assert.equal(toolCause.kind, "tools");
  assert.equal(toolCause.detail, "tools changed (+1 added, 1 removed, 1 modified)");

  const mutated = anthropicPayload({
    tools: base.tools.map(({ name, description }) => ({ name, description })),
    userTexts: ["EDITED first message"],
  });
  const historyCause = diffFingerprints(fp(base), fp(mutated))!;
  assert.equal(historyCause.kind, "history");
  assert.match(historyCause.detail, /history rewritten at message 1/);

  const truncated = fingerprintPayload(anthropicPayload({ userTexts: ["a"] }));
  const longer = fingerprintPayload(anthropicPayload({ userTexts: ["a", "b"] }));
  assert.match(diffFingerprints(longer, truncated)!.detail, /history truncated \(2 \u2192 1 messages\)/);
});

test("classification ladder", () => {
  const usage = (cacheRead: number, rest: Partial<{ input: number; output: number; cacheWrite: number }> = {}) => ({
    input: rest.input ?? 1000,
    output: rest.output ?? 500,
    cacheRead,
    cacheWrite: rest.cacheWrite ?? 2000,
  });

  assert.equal(classifyCall({ isFirst: true, usage: usage(0), expectedRead: 0 }).kind, "cold");
  assert.equal(classifyCall({ isFirst: false, usage: usage(95_000), expectedRead: 100_000 }).kind, "hit");

  const ttlMiss = classifyCall({
    isFirst: false,
    gapMs: 6.7 * MIN,
    window: { kind: "contract", ttlMs: 5 * MIN, source: "observed" },
    usage: usage(0),
    expectedRead: 100_000,
  });
  assert.equal(ttlMiss.kind, "miss");
  assert.equal(ttlMiss.cause!.kind, "ttl");
  assert.equal(ttlMiss.cause!.detail, "idle 6m42s > 5m TTL");

  // OpenAI-style band: a miss in the maybe-zone is attributed to typical eviction; past
  // the documented hard cap the wording is definite.
  const bandMaybe = classifyCall({
    isFirst: false,
    gapMs: 12 * MIN,
    window: { kind: "band", softMs: 5 * MIN, hardMs: 60 * MIN },
    usage: usage(0),
    expectedRead: 100_000,
  });
  assert.equal(bandMaybe.cause!.kind, "ttl");
  assert.equal(bandMaybe.cause!.detail, "evicted after idle 12m (typical window 5m\u20131h)");
  const bandPast = classifyCall({
    isFirst: false,
    gapMs: 90 * MIN,
    window: { kind: "band", softMs: 5 * MIN, hardMs: 60 * MIN },
    usage: usage(0),
    expectedRead: 100_000,
  });
  assert.equal(bandPast.cause!.detail, "idle 1h30m > 1h cache cap");

  // Compaction outranks the fingerprint diff (the diff would only say "history").
  const compaction = classifyCall({
    isFirst: false,
    usage: usage(0),
    expectedRead: 100_000,
    compacted: true,
    fingerprintCause: { kind: "history", detail: "history rewritten at message 3 of 40" },
  });
  assert.equal(compaction.cause!.kind, "compaction");

  // A named mutation wins over TTL, but the TTL overlap is disclosed.
  const both = classifyCall({
    isFirst: false,
    gapMs: 9 * MIN,
    window: { kind: "contract", ttlMs: 5 * MIN, source: "observed" },
    usage: usage(0),
    expectedRead: 100_000,
    fingerprintCause: { kind: "tools", detail: "tools changed (+12 added)" },
  });
  assert.equal(both.cause!.kind, "tools");
  assert.match(both.cause!.detail, /\(also idle past TTL\)/);

  const partial = classifyCall({ isFirst: false, usage: usage(50_000), expectedRead: 100_000 });
  assert.equal(partial.kind, "partial");
  assert.equal(partial.cause!.kind, "unknown");

  const summarizer = classifyCall({ isFirst: false, usage: usage(0), expectedRead: 100_000, inCompaction: true });
  assert.equal(summarizer.cause!.kind, "compaction-work");
});
