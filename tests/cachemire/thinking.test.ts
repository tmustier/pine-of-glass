import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";

import { diffFingerprints, fingerprintPayload, withheldThinkingCause, withinWarmPromise } from "../../extensions/pi-cachemire/classify.ts";
import { OPENAI_EXTENDED_WINDOW } from "../../extensions/pi-cachemire/retention.ts";
import {
	type BilledThinkingChange,
	EFFORT_MEMORY_MS,
	recordBilledThinking,
	restoreBilledThinking,
	thinkingChangeInvalidatesCache,
	thinkingChangesPreserveCache,
	type ThinkingEvidenceLedger,
	type ThinkingRoute,
	wireThinkingEffort,
} from "../../extensions/pi-cachemire/thinking.ts";

const directAnthropic = (
	model: string,
	supportsMidConvoEffort = false,
): ThinkingRoute => ({
	provider: "anthropic",
	model,
	api: "anthropic-messages",
	supportsMidConvoEffort,
});

const anthropicRequest = (effort: string, messages: unknown[] = [
	{ role: "user", content: [{ type: "text", text: "first" }] },
]) => ({
	model: "claude-fable-5-1",
	system: "fixture",
	messages,
	thinking: { type: "adaptive" },
	output_config: { effort },
});

test("thinking levels use Pi's adaptive effort mapping", () => {
	assert.equal(wireThinkingEffort(undefined, "minimal"), "low");
	assert.equal(wireThinkingEffort(undefined, "xhigh"), "high");
	assert.equal(wireThinkingEffort({ xhigh: "xhigh" }, "xhigh"), "xhigh");
	assert.equal(wireThinkingEffort(undefined, "off"), "off");

	assert.equal(thinkingChangeInvalidatesCache(undefined, undefined, "low", "high"), true);
	assert.equal(thinkingChangeInvalidatesCache(undefined, undefined, undefined, "high"), false);
	const fableMap = { xhigh: "xhigh" };
	assert.equal(thinkingChangeInvalidatesCache(undefined, fableMap, "minimal", "low"), false);
	assert.equal(thinkingChangeInvalidatesCache(undefined, fableMap, "low", "medium"), true);
});

test("only verified Anthropic routes make effort changes cache-neutral", () => {
	const fable = directAnthropic("claude-fable-5-1");
	assert.equal(thinkingChangesPreserveCache(fable), true);
	assert.equal(thinkingChangeInvalidatesCache(fable, undefined, "low", "high"), false);
	assert.equal(
		thinkingChangeInvalidatesCache(fable, undefined, "off", "high"),
		true,
		"the live evidence covers effort changes, not enabling thinking",
	);

	assert.equal(thinkingChangesPreserveCache(directAnthropic("future-claude", true)), true);
	assert.equal(thinkingChangesPreserveCache(directAnthropic("claude-fable-5")), false);
	assert.equal(thinkingChangesPreserveCache({
		...fable,
		provider: "radius",
		api: "pi-messages",
	}), false, "a matching gateway model name is not direct Anthropic evidence");
	assert.equal(thinkingChangesPreserveCache({
		provider: "openai-codex",
		model: "gpt-6-astra",
		api: "openai-codex-responses",
		supportsMidConvoEffort: true,
	}), false, "Pi's Anthropic compatibility flag cannot bless another wire protocol");
});

test("direct Claude Fable 5.1 fingerprints ignore effort-only changes", () => {
	const route = directAnthropic("claude-fable-5-1");
	const before = fingerprintPayload(anthropicRequest("low"), route);
	const after = fingerprintPayload(anthropicRequest("high"), route);
	assert.equal(diffFingerprints(before, after), undefined);
	assert.equal(
		diffFingerprints(
			fingerprintPayload(anthropicRequest("low")),
			fingerprintPayload(anthropicRequest("high")),
		)?.kind,
		"thinking",
		"the same wire change remains material without route evidence",
	);
	assert.equal(diffFingerprints(
		fingerprintPayload({ ...anthropicRequest("low"), thinking: undefined }, route),
		fingerprintPayload(anthropicRequest("high"), route),
	)?.kind, "thinking", "enabling thinking is not an effort-only change");
});

test("Pi's managed Fable effort markers preserve a strict message prefix", () => {
	const marker = (effort: string) => ({ role: "system", content: [], output_config: { effort } });
	const firstUser = { role: "user", content: [{ type: "text", text: "first" }] };
	const assistant = { role: "assistant", content: [{ type: "text", text: "answer" }] };
	const secondUser = { role: "user", content: [{ type: "text", text: "second" }] };
	const managed = (messages: unknown[]) => ({
		...anthropicRequest("high", messages),
		thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
	});
	const first = fingerprintPayload(managed([firstUser, marker("high")]));
	const next = fingerprintPayload(managed([
		firstUser,
		marker("high"),
		assistant,
		secondUser,
		marker("low"),
	]));
	assert.equal(diffFingerprints(first, next), undefined);
	assert.equal(diffFingerprints(first, fingerprintPayload(managed([
		firstUser,
		assistant,
		secondUser,
		marker("low"),
	])))?.kind, "history", "dropping the historical marker would rewrite the prefix");
});

test("GPT-6 Astra stays material until Pi appends configuration_update", () => {
	const user = { role: "user", content: [{ type: "input_text", text: "first" }] };
	const request = (effort: string, input: unknown[]) => ({
		model: "gpt-6-astra",
		instructions: "fixture",
		reasoning: { effort },
		input,
	});
	const first = fingerprintPayload(request("low", [user]));
	assert.equal(
		diffFingerprints(first, fingerprintPayload(request("high", [user])))?.kind,
		"thinking",
		"Pi 0.85.1 changes request-level effort",
	);
	assert.equal(diffFingerprints(first, fingerprintPayload(request("low", [
		user,
		{ type: "configuration_update", reasoning: { effort: "high" } },
		{ role: "user", content: [{ type: "input_text", text: "second" }] },
	]))), undefined, "the documented append-only protocol preserves the old prefix");
});

// --- billed evidence -----------------------------------------------------------------

const astraRoute: ThinkingRoute = {
	provider: "openai-codex",
	model: "gpt-6-astra",
	api: "openai-codex-responses",
	supportsMidConvoEffort: false,
};
const astraMap = { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
const bill = (cacheRead: number, expectedRead = 30_000) => ({
	usage: { input: expectedRead - cacheRead, output: 10, cacheRead, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	expectedRead,
});
const change = (overrides: Partial<BilledThinkingChange>): BilledThinkingChange => ({
	map: astraMap,
	lastCallLevel: "low",
	currentLevel: "high",
	incomparable: false,
	classification: { kind: "hit" },
	thinkingNamedAtSend: true,
	warmPromised: true,
	...bill(29_800),
	...overrides,
});

test("a billed hit on a fresh effort, or an attributable miss, is evidence; nothing else is", () => {
	// Each verdict is booked on a fresh ledger so the cases stay independent.
	const observe = (overrides: Partial<BilledThinkingChange>, billedBefore: string[] = ["low"]) => {
		const ledger: ThinkingEvidenceLedger = new Map();
		for (const level of billedBefore) recordBilledThinking(ledger, astraRoute, change({ lastCallLevel: undefined, currentLevel: level }));
		return recordBilledThinking(ledger, astraRoute, change(overrides));
	};
	assert.deepEqual(observe({}), {
		from: "low", to: "high", held: true, cacheRead: 29_800, expectedRead: 30_000,
	});
	const miss = { kind: "miss", cause: { kind: "thinking", detail: "thinking changed (effort low \u2192 effort high)" } } as const;
	assert.equal(observe({ classification: miss, ...bill(0) })?.held, false);
	assert.equal(observe({ classification: { kind: "partial" }, ...bill(1_000) })?.held, false);

	// A hit on an effort the route already billed reads that effort's own cache entry
	// back (stock Pi on Astra: low → high missed, then medium → high hit): no evidence.
	assert.equal(observe({}, ["low", "high", "medium"]), undefined);
	assert.equal(observe({ classification: miss, ...bill(0) }, ["low", "high"])?.held, false, "a miss counts regardless");

	// A miss the payload did not attribute to thinking, or that arrived after the window
	// stopped vouching for warmth (ordinary expiry explains it), says nothing about the route.
	assert.equal(observe({ classification: miss, thinkingNamedAtSend: false, ...bill(0) }), undefined);
	assert.equal(observe({ classification: miss, warmPromised: false, ...bill(0) }), undefined);
	// A hit reads the prefix back even when the payload diff saw nothing: still evidence.
	assert.equal(observe({ thinkingNamedAtSend: false })?.held, true);

	// Not an effort-to-effort change on a comparable prefix.
	assert.equal(observe({ classification: { kind: "cold" }, ...bill(0) }), undefined);
	assert.equal(observe({ incomparable: true }), undefined);
	assert.equal(observe({ lastCallLevel: undefined }), undefined);
	assert.equal(observe({ lastCallLevel: "minimal", currentLevel: "low" }), undefined, "same wire effort");
	assert.equal(observe({ lastCallLevel: "off" }), undefined, "turning thinking on is a different mutation");
	assert.equal(observe({ currentLevel: "off" }), undefined, "turning thinking off is a different mutation");
});

test("the most recent billed verdict on the exact route outranks the contract either way", () => {
	const ledger: ThinkingEvidenceLedger = new Map();
	const hit = change({});
	const miss = change({
		classification: { kind: "miss", cause: { kind: "thinking", detail: "thinking changed (effort low \u2192 effort high)" } },
		...bill(0),
	});
	const invalidates = (route: ThinkingRoute, previous: string, next: string) =>
		thinkingChangeInvalidatesCache(route, astraMap, previous, next, ledger);

	assert.equal(invalidates(astraRoute, "low", "high"), true, "no evidence: the contract decides");
	assert.equal(recordBilledThinking(ledger, astraRoute, hit)?.held, true);
	assert.equal(thinkingChangesPreserveCache(astraRoute, ledger), true);
	assert.equal(invalidates(astraRoute, "low", "high"), false);
	assert.equal(invalidates(astraRoute, "high", "off"), true, "off toggles stay material with held evidence");
	assert.equal(invalidates({ ...astraRoute, provider: "openai" }, "low", "high"), true, "evidence is per exact route");
	assert.equal(invalidates({ ...astraRoute, api: "openai-responses" }, "low", "high"), true);
	assert.equal(invalidates({ ...astraRoute, model: "gpt-6" }, "low", "high"), true);

	assert.equal(recordBilledThinking(ledger, astraRoute, miss)?.held, false);
	assert.equal(invalidates(astraRoute, "low", "high"), true, "a later miss reinstates the expectation");
	assert.equal(recordBilledThinking(ledger, astraRoute, hit), undefined, "high was billed before: no new verdict");
	assert.equal(invalidates(astraRoute, "low", "high"), true);

	// The contract's own neutrality is evidence-overridable too: a billed miss on a route
	// the catalogue calls safe wins until a fresh-effort hit says otherwise.
	const flagged = directAnthropic("claude-fable-5-1", true);
	assert.equal(thinkingChangesPreserveCache(flagged, ledger), true);
	recordBilledThinking(ledger, flagged, miss);
	assert.equal(thinkingChangesPreserveCache(flagged, ledger), false);
	recordBilledThinking(ledger, flagged, change({ lastCallLevel: "high", currentLevel: "medium" }));
	assert.equal(thinkingChangesPreserveCache(flagged, ledger), true);
});

test("only a window still vouching for warmth lets a miss count against a route", () => {
	const minute = 60_000;
	assert.equal(withinWarmPromise({ kind: "contract", ttlMs: 5 * minute, source: "observed" }, 4 * minute), true);
	assert.equal(withinWarmPromise({ kind: "contract", ttlMs: 5 * minute, source: "observed" }, 5 * minute), false);
	assert.equal(withinWarmPromise({ kind: "minimum", minMs: 30 * minute }, 29 * minute), true, "inside the floor the provider promises the entry");
	assert.equal(withinWarmPromise({ kind: "minimum", minMs: 30 * minute }, 3 * 60 * minute), false, "past the floor a miss may be plain eviction");
	assert.equal(withinWarmPromise({ kind: "bounded", minMs: 5 * minute, maxMs: 60 * minute }, 4 * minute), true);
	assert.equal(withinWarmPromise({ kind: "bounded", minMs: 5 * minute, maxMs: 60 * minute }, 10 * minute), false);
	assert.equal(withinWarmPromise({ kind: "maximum", maxMs: 60 * minute }, 1), false, "a maximum never promises warmth");
	assert.equal(withinWarmPromise({ kind: "unknown" }, 1), false);
	assert.equal(withinWarmPromise(undefined, 1), false);
	assert.equal(withinWarmPromise({ kind: "contract", ttlMs: 5 * minute, source: "observed" }, undefined), false);
});

test("a contract-neutral effort change is withheld from the cache-key diff but not from the bill", () => {
	const flagged = directAnthropic("claude-fable-5-1", true);
	const low = fingerprintPayload(anthropicRequest("low"), flagged);
	const high = fingerprintPayload(anthropicRequest("high"), flagged);
	assert.equal(diffFingerprints(low, high), undefined, "lineage treats the two requests as one prefix");
	assert.deepEqual(withheldThinkingCause(low, high), {
		kind: "thinking",
		detail: "thinking changed (thinking effort low \u2192 thinking effort high)",
	});
	assert.equal(withheldThinkingCause(low, low), undefined, "no wire change to withhold");
	assert.equal(withheldThinkingCause(undefined, high), undefined);
	const plain = directAnthropic("claude-fable-5");
	assert.equal(
		withheldThinkingCause(fingerprintPayload(anthropicRequest("low"), plain), fingerprintPayload(anthropicRequest("high"), plain)),
		undefined,
		"a route the contract expects to break names the change in the diff itself",
	);
	const off = fingerprintPayload({ ...anthropicRequest("low"), thinking: { type: "disabled" }, output_config: undefined }, flagged);
	assert.equal(withheldThinkingCause(low, off), undefined, "on/off is never withheld, so never re-named");
});

test("a resumed session remembers which efforts its history billed within retention", () => {
	assert.equal(EFFORT_MEMORY_MS, OPENAI_EXTENDED_WINDOW.maxMs, "the memory bound is the longest known retention");
	const now = 1_800_000_000_000;
	const model: Model<"openai-codex-responses"> = {
		provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra", api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api", reasoning: true, thinkingLevelMap: astraMap, input: ["text"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, contextWindow: 272_000, maxTokens: 128_000,
	};
	const assistant = (id: string, parentId: string, at: number, modelId = model.id) => ({
		type: "message", id, parentId, timestamp: new Date(at).toISOString(),
		message: { role: "assistant", provider: model.provider, api: model.api, model: modelId, timestamp: at, content: [] },
	});
	const level = (id: string, parentId: string, thinkingLevel: string) => ({ type: "thinking_level_change", id, parentId, thinkingLevel });
	const entries = [
		level("t0", null as unknown as string, "medium"),
		assistant("a1", "t0", now - EFFORT_MEMORY_MS - 60_000), // medium, but too old to be warm
		level("t1", "a1", "high"),
		assistant("a2", "t1", now - 600_000), // high, ten minutes ago
		level("t2", "a2", "minimal"),
		assistant("a3", "t2", now - 300_000), // minimal maps to the low wire effort
		assistant("a4", "a3", now - 200_000, "gpt-5.6-sol"), // another route
		level("t3", "a3", "xhigh"), // abandoned branch: not on the path to the leaf
		assistant("a5", "t3", now - 100_000),
	];

	const ledger: ThinkingEvidenceLedger = new Map();
	assert.equal(restoreBilledThinking(ledger, entries, "a4", model, now), "minimal", "the path's last call was billed at the level in force then, whatever its route");
	const hitOn = (to: string) =>
		recordBilledThinking(ledger, astraRoute, change({ lastCallLevel: "medium", currentLevel: to }));
	assert.equal(hitOn("high"), undefined, "high was billed ten minutes ago: its entry may still be warm");
	assert.equal(hitOn("low"), undefined, "minimal billed the low wire effort");
	assert.equal(hitOn("xhigh")?.held, true, "the abandoned branch is not on the resumed path");
	assert.equal(recordBilledThinking(ledger, astraRoute, change({ lastCallLevel: "high", currentLevel: "medium" }))?.held, true,
		"medium was last billed beyond the longest retention");

	assert.equal(restoreBilledThinking(new Map(), entries, "a5", model, now), "xhigh", "another leaf, another last level");
	assert.equal(restoreBilledThinking(new Map(), entries, "t0", model, now), undefined, "nothing billed yet on this path");
	assert.equal(restoreBilledThinking(new Map(), entries, null, model, now), undefined);
	assert.equal(restoreBilledThinking(new Map(), entries, "a4", undefined, now), undefined);
});
