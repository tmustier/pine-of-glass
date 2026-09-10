import { test } from "node:test";
import assert from "node:assert/strict";

import { diffFingerprints, fingerprintPayload } from "../../extensions/pi-cachemire/classify.ts";
import {
	thinkingChangeInvalidatesCache,
	thinkingChangesPreserveCache,
	wireThinkingEffort,
	type ThinkingRoute,
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
