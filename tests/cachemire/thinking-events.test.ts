import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const fable: Model<"anthropic-messages"> = {
	id: "claude-fable-5-1",
	name: "Claude Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" },
	input: ["text", "image"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

// Same wire contract, no catalogue flag and no verified exception: the static rule
// expects every effort change to break the cache.
const fableFive: Model<"anthropic-messages"> = { ...fable, id: "claude-fable-5", name: "Claude Fable 5" };

// Pi's own catalogue record for the Codex route.
const astra: Model<"openai-codex-responses"> = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
	input: ["text", "image"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 272_000,
	maxTokens: 128_000,
};

function anthropicPayload(model: Model<"anthropic-messages">, effort: string, turns: string[]) {
	return {
		model: model.id,
		system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
		messages: turns.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
		thinking: { type: "adaptive" },
		output_config: { effort },
	};
}

// What Cachemire sees at its own hook: Pi's request-level effort. A later-loaded
// extension may rewrite this into OpenAI's configuration_update protocol afterwards;
// the billed usage, not this payload, says whether the prefix survived.
function astraPayload(effort: string, turns: string[]) {
	return {
		model: astra.id,
		instructions: "fixture",
		input: turns.map((text) => ({ role: "user", content: [{ type: "input_text", text }] })),
		reasoning: { effort },
	};
}

function billed(model: Model<string>, usage: { input: number; cacheRead: number; cacheWrite: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		provider: model.provider,
		api: model.api,
		model: model.id,
		usage: {
			...usage,
			output: 10,
			totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const assistant = billed(fable, { input: 2, cacheRead: 0, cacheWrite: 100_000 });

// One billed turn as Pi runs it: the user entry advances the leaf before the request,
// the assistant entry after the bill, so each call anchors its own lineage snapshot.
async function call(host: Awaited<ReturnType<typeof hostExtension>>, payload: unknown, message: AssistantMessage) {
	const runner = host.session.extensionRunner;
	host.session.sessionManager.appendMessage({ role: "user", content: String(host.session.sessionManager.getEntries().length), timestamp: Date.now() });
	await runner.emitBeforeProviderRequest(payload);
	await runner.emitMessageEnd({ type: "message_end", message });
	host.session.sessionManager.appendMessage(message);
}

test("thinking_level_select keeps direct Claude Fable 5.1 cache UI silent", async () => {
	const project = new IsolatedProject();
	const host = await hostExtension(piCachemire, { project, model: fable, thinkingLevel: "low" });
	try {
		await host.session.extensionRunner.emitBeforeProviderRequest(anthropicPayload(fable, "low", ["first"]));
		await host.session.extensionRunner.emitMessageEnd({ type: "message_end", message: assistant });
		assert.equal(host.ui.widgetLines("pi-cachemire"), undefined, "a healthy cache is silent");

		await host.session.extensionRunner.emit({
			type: "thinking_level_select",
			previousLevel: "low",
			level: "high",
		});
		assert.equal(
			host.ui.widgetLines("pi-cachemire"),
			undefined,
			"the cache-safe effort change must not show a false stale clock",
		);
	} finally {
		await host.dispose();
		project.dispose();
	}
});

test("a billed hit after an effort change silences a route the contract expects to break", async () => {
	const project = new IsolatedProject();
	const host = await hostExtension(piCachemire, { project, model: fableFive, thinkingLevel: "low" });
	const runner = host.session.extensionRunner;
	const notices = host.ui.notifications;
	try {
		await call(host, anthropicPayload(fableFive, "low", ["first"]), billed(fableFive, { input: 2, cacheRead: 0, cacheWrite: 100_000 }));

		// No evidence yet: the contract rule predicts a break, at the keystroke and in flight.
		await runner.emit({ type: "thinking_level_select", previousLevel: "low", level: "high" });
		assert.match(host.ui.widgetLines("pi-cachemire")?.join("\n") ?? "", /thinking level changed/);
		host.session.sessionManager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		await runner.emitBeforeProviderRequest(anthropicPayload(fableFive, "high", ["first", "second"]));
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /cache breaking .* cause: thinking changed \(thinking effort low \u2192 thinking effort high\)/);

		// The usage says the prefix survived: the prediction resolves into a held line.
		const held = billed(fableFive, { input: 200, cacheRead: 100_000, cacheWrite: 300 });
		await runner.emitMessageEnd({ type: "message_end", message: held });
		host.session.sessionManager.appendMessage(held);
		assert.equal(notices.length, 2);
		assert.equal(
			notices[1],
			"\u25cd cache held \u00b7 read 100.0k of 100.0k expected \u00b7 effort low \u2192 high kept the prefix warm on this route",
		);

		// The verdict now outranks the contract: the next change is quiet end to end.
		await runner.emit({ type: "thinking_level_select", previousLevel: "high", level: "low" });
		assert.equal(host.ui.widgetLines("pi-cachemire"), undefined, "evidence must silence the stale clock");
		host.session.sessionManager.appendMessage({ role: "user", content: "third", timestamp: Date.now() });
		await runner.emitBeforeProviderRequest(anthropicPayload(fableFive, "low", ["first", "second", "third"]));
		assert.equal(notices.length, 2, "evidence must silence the in-flight prediction");
		const quiet = billed(fableFive, { input: 200, cacheRead: 100_300, cacheWrite: 300 });
		await runner.emitMessageEnd({ type: "message_end", message: quiet });
		host.session.sessionManager.appendMessage(quiet);
		assert.equal(notices.length, 2, "a hit that was expected earns no line");

		// The payload diff still saw the wire change; only the claim was withheld. A miss
		// on the same route names it, so the verdict can flip back.
		await runner.emit({ type: "thinking_level_select", previousLevel: "low", level: "high" });
		await call(
			host,
			anthropicPayload(fableFive, "high", ["first", "second", "third", "fourth"]),
			billed(fableFive, { input: 2, cacheRead: 0, cacheWrite: 101_000 }),
		);
		assert.equal(notices.length, 3);
		assert.match(notices[2]!, /cache broke .* cause: thinking changed \(thinking effort low \u2192 thinking effort high\)/);
		await runner.emit({ type: "thinking_level_select", previousLevel: "high", level: "low" });
		assert.match(host.ui.widgetLines("pi-cachemire")?.join("\n") ?? "", /thinking level changed/, "a billed miss reinstates the expectation");

		// Turning thinking off is a different mutation and stays material regardless.
		await runner.emit({ type: "thinking_level_select", previousLevel: "low", level: "off" });
		assert.match(host.ui.widgetLines("pi-cachemire")?.join("\n") ?? "", /thinking level changed/);
	} finally {
		await host.dispose();
		project.dispose();
	}
});

test("GPT-6 Astra: the usage decides, and only a fresh effort can prove the route holds", async () => {
	const project = new IsolatedProject();
	const host = await hostExtension(piCachemire, { project, model: astra, thinkingLevel: "low" });
	const runner = host.session.extensionRunner;
	const notices = host.ui.notifications;
	const turns = ["first"];
	const change = async (previousLevel: ThinkingLevel, level: ThinkingLevel, usage: { input: number; cacheRead: number }) => {
		await runner.emit({ type: "thinking_level_select", previousLevel, level });
		turns.push(level);
		await call(host, astraPayload(level, turns), billed(astra, { ...usage, cacheWrite: 0 }));
	};
	try {
		await call(host, astraPayload("low", turns), billed(astra, { input: 30_000, cacheRead: 0, cacheWrite: 0 }));

		// Stock Pi: the request-level effort changes and the bill says miss. The payload
		// diff names it, and an OpenAI window never earns an in-flight claim.
		await change("low", "high", { input: 30_600, cacheRead: 0 });
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /^\u25cd cache broke .* cause: thinking changed \(effort low \u2192 effort high\)$/);
		await change("high", "medium", { input: 30_800, cacheRead: 0 });
		assert.equal(notices.length, 2);
		assert.match(notices[1]!, /cause: thinking changed \(effort high \u2192 effort medium\)$/);

		// Back to an effort already billed: the provider still holds that effort's own
		// entry, so the hit is real but proves nothing about the route. No line, and the
		// expectation stays.
		await change("medium", "high", { input: 400, cacheRead: 30_600 });
		assert.equal(notices.length, 2, "a hit on a previously billed effort is not evidence");

		// A hit on an effort this route has never billed is the verdict: a later-loaded
		// extension kept the prefix (configuration_update) even though the payload
		// Cachemire saw changed effort. Say so once; record it.
		await change("high", "xhigh", { input: 400, cacheRead: 30_800 });
		assert.equal(notices.length, 3);
		assert.equal(
			notices[2],
			"\u25cd cache held \u00b7 read 30.8k of 31.0k expected \u00b7 effort high \u2192 xhigh kept the prefix warm on this route",
		);

		// The route now holds: an expected hit earns no line.
		await change("xhigh", "low", { input: 400, cacheRead: 31_200 });
		assert.equal(notices.length, 3);

		await host.session.prompt("/cache");
		const ledger = notices.at(-1)!;
		assert.match(ledger, /\u25cc miss \u2014 thinking changed \(effort low \u2192 effort high\)/);
		assert.match(ledger, /\u25cc miss \u2014 thinking changed \(effort high \u2192 effort medium\)/);
		assert.match(ledger, /\u25cf hit \u2014 effort high \u2192 xhigh kept the prefix/);
		assert.equal((ledger.match(/\u25cf hit \u2014/g) ?? []).length, 1, "only the fresh-effort hit names the change");
	} finally {
		await host.dispose();
		project.dispose();
	}
});

test("a billed miss on a contract-neutral route names the effort change and charges the route", async () => {
	const project = new IsolatedProject();
	const host = await hostExtension(piCachemire, { project, model: fable, thinkingLevel: "low" });
	const runner = host.session.extensionRunner;
	const notices = host.ui.notifications;
	try {
		await call(host, anthropicPayload(fable, "low", ["first"]), billed(fable, { input: 2, cacheRead: 0, cacheWrite: 100_000 }));
		host.session.setThinkingLevel("high");
		assert.equal(host.ui.widgetLines("pi-cachemire"), undefined, "the contract calls the change neutral: no claim");

		// The cache-key diff withheld the change (lineage keeps one prefix), and the contract
		// silenced the in-flight claim; the bill still says miss, so the change is charged.
		await call(host, anthropicPayload(fable, "high", ["first", "second"]), billed(fable, { input: 2, cacheRead: 0, cacheWrite: 101_000 }));
		assert.equal(notices.length, 1, "no in-flight claim on a contract-neutral route");
		assert.match(notices[0]!, /^\u25cd cache broke .* cause: thinking changed \(thinking effort low \u2192 thinking effort high\)$/);

		// The verdict now outranks the contract: the next change is material end to end.
		host.session.setThinkingLevel("low");
		assert.match(host.ui.widgetLines("pi-cachemire")?.join("\n") ?? "", /thinking level changed/, "a billed miss overrides the contract");
		host.session.sessionManager.appendMessage({ role: "user", content: "third", timestamp: Date.now() });
		await runner.emitBeforeProviderRequest(anthropicPayload(fable, "low", ["first", "second", "third"]));
		assert.equal(notices.length, 2);
		assert.match(notices[1]!, /^\u25cd cache breaking .* cause: thinking changed \(thinking effort high \u2192 thinking effort low\)$/);
		const back = billed(fable, { input: 200, cacheRead: 101_000, cacheWrite: 300 });
		await runner.emitMessageEnd({ type: "message_end", message: back });
		host.session.sessionManager.appendMessage(back);
		assert.equal(notices.length, 2, "the claim resolves in place; a hit on a billed effort adds nothing");
		host.session.setThinkingLevel("high");
		assert.match(host.ui.widgetLines("pi-cachemire")?.join("\n") ?? "", /thinking level changed/, "low was billed before: that hit is not a fresh verdict");
	} finally {
		await host.dispose();
		project.dispose();
	}
});

test("GPT-6 Astra: a miss after the retention floor is expiry, not evidence against a route that held", async () => {
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const project = new IsolatedProject();
	const host = await hostExtension(piCachemire, { project, model: astra, thinkingLevel: "low" });
	const notices = host.ui.notifications;
	const turns = ["first"];
	const change = async (level: ThinkingLevel, usage: { input: number; cacheRead: number }) => {
		host.session.setThinkingLevel(level);
		turns.push(level);
		await call(host, astraPayload(level, turns), billed(astra, { ...usage, cacheWrite: 0 }));
	};
	try {
		await call(host, astraPayload("low", turns), billed(astra, { input: 30_000, cacheRead: 0, cacheWrite: 0 }));
		await change("high", { input: 400, cacheRead: 29_800 });
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /^\u25cd cache held .* effort low \u2192 high kept the prefix warm on this route$/);

		// Three hours idle: the 30-minute minimum stopped vouching for the entry long ago.
		// The payload diff still names the effort change, the lapse shares the blame, and
		// the verdict is left alone.
		mock.timers.tick(3 * 60 * 60 * 1000);
		await change("medium", { input: 30_800, cacheRead: 0 });
		assert.equal(notices.length, 2);
		assert.match(notices[1]!, /^\u25cd cache broke .* cause: thinking changed \(effort high \u2192 effort medium\) \(also 30m minimum passed\)$/);

		// Still held: a fresh-effort hit is expected and earns no line.
		await change("xhigh", { input: 400, cacheRead: 30_600 });
		assert.equal(notices.length, 2, "an unproven miss must not reinstate the expectation");
	} finally {
		mock.timers.reset();
		await host.dispose();
		project.dispose();
	}
});

test("a branch switch measures the next effort change from that branch's last billed call", async () => {
	const project = new IsolatedProject();
	// A session file from an earlier process: one turn at low, then two sibling branches,
	// A billed at high and B (the leaf being resumed) billed at low.
	const history = SessionManager.inMemory(project.dir);
	const now = Date.now();
	const turn = (text: string, level: string, prompt: number, at: number) => {
		history.appendMessage({ role: "user", content: text, timestamp: at - 1_000 });
		const message = { ...billed(astra, { input: prompt, cacheRead: 0, cacheWrite: 0 }), timestamp: at };
		history.appendMessage(message);
		return { id: history.getLeafId()!, level, prompt };
	};
	history.appendThinkingLevelChange("low");
	const root = turn("first", "low", 20_000, now - 3_000_000);
	history.appendThinkingLevelChange("high");
	const branchA = turn("second (A)", "high", 30_000, now - 2_000_000);
	history.branch(root.id);
	turn("second (B)", "low", 30_500, now - 1_000_000);

	// pi --continue: a fresh process (startup) opening the file at branch B's leaf.
	const host = await hostExtension(piCachemire, { project, model: astra, sessionManager: history });
	const notices = host.ui.notifications;
	try {
		assert.equal(host.session.thinkingLevel, "low", "Pi restores the resumed branch's level");
		await host.session.navigateTree(branchA.id);
		assert.equal(host.session.thinkingLevel, "low", "Pi does not restore the level on a branch switch");

		// Cachemire does: branch A was last billed at high, so returning to high is no
		// change on the wire. The hit reads A's own entry back and proves nothing.
		host.session.setThinkingLevel("high");
		await call(host, astraPayload("high", ["first", "second (A)", "third"]), billed(astra, { input: 400, cacheRead: 29_900, cacheWrite: 0 }));
		assert.deepEqual(notices, [], "a return to the branch's billed effort is not a fresh-effort verdict");
		await host.session.prompt("/cache");
		assert.doesNotMatch(notices.at(-1)!, /kept the prefix/);
	} finally {
		await host.dispose();
		project.dispose();
	}
});
