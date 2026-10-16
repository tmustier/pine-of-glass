// Direct OpenAI GPT-6 effort changes under Pi 1.3's append-only protocol, driven
// through Pi's SDK. The shared evidence rules are in thinking-events.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

// Pi's catalogue record for direct OpenAI GPT-6.1 Sol: Pi 1.3 keeps request-level
// effort fixed and appends configuration_update items, unless signed in with ChatGPT.
const sol: Model<"openai-responses"> = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
	input: ["text", "image"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 500_000,
	maxTokens: 128_000,
	compat: { supportsMidConvoEffort: true },
};

function solPayload(efforts: string[]) {
	return {
		model: sol.id,
		input: efforts.flatMap((effort, index) => [
			{ role: "user", content: [{ type: "input_text", text: String(index) }] },
			{ type: "configuration_update", reasoning: { effort } },
		]),
		reasoning: { effort: "medium", summary: "auto" },
	};
}

function signInWithChatGPT(project: IsolatedProject): void {
	const agentDir = join(project.home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		openai: { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3_600_000 },
	}));
}

function billed(usage: { input: number; cacheRead: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		provider: sol.provider,
		api: sol.api,
		model: sol.id,
		usage: {
			...usage,
			cacheWrite: 0,
			output: 10,
			totalTokens: usage.input + usage.cacheRead + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// One billed turn as Pi runs it: the user entry before the request, the assistant after.
async function call(host: Awaited<ReturnType<typeof hostExtension>>, efforts: string[], message: AssistantMessage) {
	const runner = host.session.extensionRunner;
	host.session.sessionManager.appendMessage({ role: "user", content: String(efforts.length), timestamp: Date.now() });
	await runner.emitContext([]);
	await runner.emitBeforeProviderRequest(solPayload(efforts));
	await runner.emitMessageEnd({ type: "message_end", message });
	host.session.sessionManager.appendMessage(message);
}

// A low-to-high change that the bill shows kept the prefix; returns Cachemire's notices.
async function noticesAfterHeldEffortChange(signedIn: boolean): Promise<string[]> {
	const project = new IsolatedProject();
	if (signedIn) signInWithChatGPT(project);
	const host = await hostExtension(piCachemire, { project, model: sol, thinkingLevel: "low" });
	try {
		await call(host, ["low"], billed({ input: 30_000, cacheRead: 0 }));
		host.session.setThinkingLevel("high");
		await call(host, ["low", "high"], billed({ input: 400, cacheRead: 29_800 }));
		return [...host.ui.notifications];
	} finally {
		await host.dispose();
		project.dispose();
	}
}

test("direct OpenAI GPT-6 with an API key: an effort change is expected to hold, so the hit earns no line", async () => {
	assert.deepEqual(await noticesAfterHeldEffortChange(false), []);
});

test("direct OpenAI GPT-6 with Sign in with ChatGPT: Pi changes request-level effort, so a hit is news", async () => {
	const notices = await noticesAfterHeldEffortChange(true);
	assert.equal(notices.length, 1);
	assert.match(notices[0]!, /^\u25cd cache held .* effort low \u2192 high kept the prefix warm on this route$/);
});
