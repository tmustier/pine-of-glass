// Cachemire forensics: fingerprinting, miss-cause naming, and classification.
// The load-bearing invariant: pi moves its cache_control breakpoint to the last user
// message on every request, so fingerprints must strip cache_control — otherwise every
// healthy call would be misdiagnosed as "history mutated".
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";
import { isJsonObject } from "../../extensions/_lib/boundary.ts";

const { stripCacheControl, fingerprintPayload, diffFingerprints, classifyCall, matchPriorEntry } = internals;

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
  const stripped = stripCacheControl(anthropicPayload());
  if (!isJsonObject(stripped)) assert.fail("stripCacheControl should preserve an object payload");
  assert.equal(JSON.stringify(stripped).includes("cache_control"), false);
  assert.ok(Array.isArray(stripped.system));
  assert.ok(isJsonObject(stripped.system[0]));
  assert.equal(stripped.system[0].text, "You are a fixture.");
  assert.ok(Array.isArray(stripped.tools));
  assert.ok(isJsonObject(stripped.tools[0]));
  assert.equal(stripped.tools[0].name, "bash");
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

test("matchPriorEntry names which prior call's entry a read hit", () => {
  // Live arithmetic from session 019e9758: call #38 (prompt 49,417) wrote the entry that
  // a burst of later calls read as exactly floor512(49,417) = 49,152 — while interleaved
  // calls read a newer 62k entry. Mapping reads back to prompt totals is the diagnosis.
  const now = 1_000_000_000;
  const MIN_MS = 60_000;
  const priors = [
    { index: 37, at: now - 30 * MIN_MS, promptTokens: 49_300 }, // same 512-bucket, older
    { index: 38, at: now - 13 * MIN_MS, promptTokens: 49_417 },
    { index: 39, at: now - 12 * MIN_MS, promptTokens: 62_932 },
  ];

  const match = matchPriorEntry(49_152, priors, now, 60 * MIN_MS)!;
  assert.equal(match.index, 38, "newest matching entry wins");
  assert.equal(match.ageMs, 13 * MIN_MS);

  // Entries older than the hard cap cannot be asserted — they are documented as removed.
  assert.equal(matchPriorEntry(49_152, priors, now, 10 * MIN_MS), undefined);
  // Reads that are not on a 512 checkpoint, or zero, never match.
  assert.equal(matchPriorEntry(49_200, priors, now, 60 * MIN_MS), undefined);
  assert.equal(matchPriorEntry(0, priors, now, 60 * MIN_MS), undefined);
  // A read with no bucket-mate stays unmatched (falls to the generic unknown hint).
  assert.equal(matchPriorEntry(51_200, priors, now, 60 * MIN_MS), undefined);
});

test("entry match upgrades unknown band misses and refines idle evictions", () => {
  const band: { kind: "band"; softMs: number; hardMs: number } = { kind: "band", softMs: 5 * MIN, hardMs: 60 * MIN };
  const base = {
    isFirst: false,
    expectedRead: 63_000,
    usage: { input: 13_987, output: 319, cacheRead: 49_152, cacheWrite: 0 },
  };

  // No idle gap, read matches an older call's entry: the replica story, named.
  const bounce = classifyCall({ ...base, gapMs: 5_000, window: band, entryMatch: { index: 38, ageMs: 13 * MIN } });
  assert.equal(bounce.kind, "partial");
  assert.equal(bounce.cause!.kind, "replica");
  assert.equal(
    bounce.cause!.detail,
    "read matches call #38's entry (13m old) \u00b7 likely a different replica from the last write",
  );

  // Idle past the soft window: eviction stays the headline, the entry refines it.
  const evicted = classifyCall({ ...base, gapMs: 11.8 * MIN, window: band, entryMatch: { index: 38, ageMs: 13 * MIN } });
  assert.equal(evicted.cause!.kind, "ttl");
  assert.equal(
    evicted.cause!.detail,
    "evicted after idle 11m48s (typical window 5m\u20131h) \u00b7 fell back to call #38's entry (13m old)",
  );

  // Named mutations outrank the entry match — the user's action is the root cause.
  const mutated = classifyCall({
    ...base,
    gapMs: 5_000,
    window: band,
    fingerprintCause: { kind: "system", detail: "system prompt changed" },
    entryMatch: { index: 38, ageMs: 13 * MIN },
  });
  assert.equal(mutated.cause!.kind, "system");

  // Contract windows (Anthropic) use explicit breakpoints, not floor512 checkpoints —
  // the arithmetic does not apply, so the match is ignored.
  const contract = classifyCall({
    ...base,
    gapMs: 5_000,
    window: { kind: "contract", ttlMs: 5 * MIN, source: "observed" },
    entryMatch: { index: 38, ageMs: 13 * MIN },
  });
  assert.equal(contract.cause!.kind, "unknown");
});

test("unknown-miss hint is window-aware", () => {
  // Live-observed on gpt-5.5 (session 019eb190): call 1 misses (thinking change) and
  // re-writes; call 2 fires seconds later with an identical prefix and reads exactly 0.
  // OpenAI's best-effort cache (prefix-hash replica routing, write propagation) is the
  // explanation — not eviction, and not a content change (cacheRead 0 with an unchanged
  // early prefix would still hit the first increments if the entry were reachable).
  const base = {
    isFirst: false,
    gapMs: 8_000,
    expectedRead: 17_397,
    usage: { input: 18_500, output: 51, cacheRead: 0, cacheWrite: 0 },
  };
  const band: { kind: "band"; softMs: number; hardMs: number } = { kind: "band", softMs: 5 * MIN, hardMs: 60 * MIN };

  const afterWrite = classifyCall({ ...base, window: band, prevWrote: true });
  assert.equal(afterWrite.kind, "miss");
  assert.equal(afterWrite.cause!.detail, "unknown (best-effort cache: fresh write not yet readable, or replica routing)");

  const afterHit = classifyCall({ ...base, window: band, prevWrote: false });
  assert.equal(afterHit.cause!.detail, "unknown (best-effort cache: replica routing or early eviction)");

  // Contract windows (Anthropic) keep the eviction hint — the cache there is a promise,
  // so an unexplained miss points at the provider side.
  const contract = classifyCall({
    ...base,
    window: { kind: "contract", ttlMs: 5 * MIN, source: "observed" },
    prevWrote: true,
  });
  assert.equal(contract.cause!.detail, "unknown (provider-side eviction?)");
});
