// Direct OpenAI GPT-6 effort changes under Pi 1.3's append-only protocol, driven
// through Pi's SDK. The shared evidence rules are in thinking-events.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const model = openaiProvider().getModels().find((model) => model.id === "gpt-6.1-sol");
assert(model);
const sol = model;

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
async function call(host: Awaited<ReturnType<typeof hostExtension>>, efforts: string[], message: AssistantMessage, signedIn: boolean) {
	const runner = host.session.extensionRunner;
	host.session.sessionManager.appendMessage({ role: "user", content: String(efforts.length), timestamp: Date.now() });
	await runner.emitContext([]);
	await runner.emitBeforeProviderRequest({
		model: sol.id,
		input: efforts.flatMap((effort, index) => [
			{ role: "user", content: [{ type: "input_text", text: String(index) }] },
			...(signedIn ? [] : [{ type: "configuration_update", reasoning: { effort } }]),
		]),
		reasoning: { effort: signedIn ? efforts.at(-1) : "medium", summary: "auto" },
	});
	await runner.emitMessageEnd({ type: "message_end", message });
	host.session.sessionManager.appendMessage(message);
}

// A low-to-high change that the bill shows kept the prefix; returns Cachemire's notices.
async function noticesAfterHeldEffortChange(signedIn: boolean): Promise<string[]> {
	const project = new IsolatedProject();
	if (signedIn) {
		const agentDir = join(project.home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
			openai: { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3_600_000 },
		}));
	}
	const host = await hostExtension(piCachemire, { project, model: sol, thinkingLevel: "low" });
	try {
		await call(host, ["low"], billed({ input: 30_000, cacheRead: 0 }), signedIn);
		host.session.setThinkingLevel("high");
		await call(host, ["low", "high"], billed({ input: 400, cacheRead: 29_800 }), signedIn);
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
