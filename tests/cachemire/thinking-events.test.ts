import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

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

const payload = {
	model: fable.id,
	system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
	messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
	thinking: { type: "adaptive" },
	output_config: { effort: "low" },
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "answer" }],
	provider: fable.provider,
	api: fable.api,
	model: fable.id,
	usage: {
		input: 2,
		output: 10,
		cacheRead: 0,
		cacheWrite: 100_000,
		totalTokens: 100_012,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

test("thinking_level_select keeps direct Claude Fable 5.1 cache UI silent", async () => {
	const project = new IsolatedProject();
	const host = await hostExtension(piCachemire, { project, model: fable, thinkingLevel: "low" });
	try {
		await host.session.extensionRunner.emitBeforeProviderRequest(payload);
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
