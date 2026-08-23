import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { replaceThinkingLabels } from "../../extensions/pi-traceline/thinking-preview.ts";

// The assistant-row prototype patch routes EVERY row render through
// replaceThinkingLabels(), and pi re-renders visible rows on every streaming delta.
// On long conversations (many historical thinking blocks) any per-call work scales
// with total conversation thinking volume, so per-call cost must stay flat across
// repeated renders of an unchanged row.

const LABEL = "\x1b[3mThinking...\x1b[23m";

const REASONING_LINE =
	"The `patchAssistantRowPrototype` wrapper runs on **every** render pass, so let me trace how `AssistantRow.render()` gets invoked while deltas stream in.";

/** A realistic high-thinking-level block: 120 mixed prose/markdown reasoning lines. */
const BLOCK_TEXT = Array.from({ length: 120 }, (_, i) => (i % 12 === 0 ? "" : `${REASONING_LINE} (${i})`)).join("\n");

/** Long-conversation-shaped row: 40 turns x 3 thinking blocks, separated by text. */
function longConversationComp() {
	const content: unknown[] = [];
	for (let turn = 0; turn < 40; turn++) {
		for (let block = 0; block < 3; block++) content.push({ type: "thinking", thinking: BLOCK_TEXT });
		content.push({ type: "text", text: `turn ${turn} result` });
	}
	return { hiddenThinkingLabel: "Thinking...", lastMessage: { content } };
}

function labelLines(count: number): string[] {
	return Array.from({ length: count }, () => LABEL);
}

test("long-conversation shape produces the expected previews", () => {
	// Consecutive thinking blocks fold into ONE preview per label (grouping semantics).
	const comp = longConversationComp();
	const out = replaceThinkingLabels(comp, labelLines(40));
	assert.strictEqual(out.length, 40);
	assert.ok(out.every((line) => line !== LABEL), "every label should be replaced");
	assert.match(stripAnsi(out[0]!), /^The patchAssistantRowPrototype/);
});

test("repeat renders of an unchanged row are fast (no per-frame recomputation)", () => {
	const comp = longConversationComp();
	const lines = labelLines(40);

	replaceThinkingLabels(comp, lines); // warmup / correctness
	const baseline = replaceThinkingLabels(comp, lines);

	const FRAMES = 20;
	const start = performance.now();
	for (let frame = 0; frame < FRAMES; frame++) {
		assert.deepEqual(replaceThinkingLabels(comp, lines), baseline, "cached renders must be identical");
	}
	const elapsedMs = performance.now() - start;

	// Broken (recompute-all-previews-per-frame) costs O(total thinking lines x Markdown
	// parse) ~= 15k renders per frame here, ~200ms/frame on dev hardware. Cached cost is
	// effectively flat. 5ms/frame average leaves >40x headroom for slow CI machines
	// while still failing loudly (~100x over budget) on the un-cached implementation.
	const budgetPerFrameMs = 5;
	assert.ok(
		elapsedMs / FRAMES < budgetPerFrameMs,
		`${FRAMES} repeat renders took ${elapsedMs.toFixed(1)}ms total (${(elapsedMs / FRAMES).toFixed(2)}ms/frame, budget ${budgetPerFrameMs}ms/frame)`,
	);
});

test("a streaming block grows without re-deriving unrelated work incorrectly", () => {
	const content: unknown[] = [{ type: "text", text: "intro" }, { type: "thinking", thinking: REASONING_LINE }];
	const comp = { hiddenThinkingLabel: "Thinking...", lastMessage: { content } };

	const before = replaceThinkingLabels(comp, [LABEL]);
	// Streamed delta arrives: same block object, longer text.
	(content[1] as { thinking: string }).thinking = `${REASONING_LINE}\nSecond thought about **caching**.`;
	const after = replaceThinkingLabels(comp, [LABEL]);

	assert.match(stripAnsi(before[0]!), /render pass/);
	assert.ok(!stripAnsi(before[0]!).includes("Second thought"));
	assert.match(stripAnsi(after[0]!), /Second thought about caching/, "grown block must be re-derived");
});
