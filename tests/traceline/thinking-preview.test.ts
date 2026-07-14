// Collapsed-thinking preview grammar (design language §9.11): adjacent provider
// fragments form one multiline run, while every non-thinking content entry is a
// semantic boundary. The installed-Pi suite separately pins native label spacing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { dedupeThinkingLabels } from "../../extensions/pi-traceline/thinking-preview.ts";

const LABEL = "\x1b[3mThinking...\x1b[23m";
const preview = (text: string) => `\x1b[3mThinking: ${text}\x1b[23m`;

function thinkingComp(content: Array<Record<string, unknown>>) {
  return { hiddenThinkingLabel: "Thinking...", lastMessage: { content } };
}

test("a single block preserves reasoning lines, paragraph breaks, and width", () => {
  const multiline = thinkingComp([
    { type: "thinking", thinking: "\n  **first reasoning line**\nsecond reasoning line" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(multiline, ["", LABEL]),
    ["", preview("first reasoning line"), preview("second reasoning line")],
  );

  const paragraphs = thinkingComp([
    { type: "thinking", thinking: "first paragraph\n\n\nsecond paragraph" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(paragraphs, [LABEL]),
    [preview("first paragraph"), "", preview("second paragraph")],
    "long source blank runs collapse to one display line",
  );

  const literalStar = dedupeThinkingLabels(
    thinkingComp([{ type: "thinking", thinking: "2 * 3 = 6" }]),
    [LABEL],
  )[0]!;
  assert.equal(stripAnsi(literalStar).trim(), "Thinking: 2 * 3 = 6", "markdown rendering preserves genuine stars");

  const long = dedupeThinkingLabels(
    thinkingComp([{ type: "thinking", thinking: "a very long reasoning preview" }]),
    [LABEL],
    18,
  )[0]!;
  assert.ok(stripAnsi(long).length <= 18, `preview must respect row width: ${stripAnsi(long)}`);
  assert.ok(stripAnsi(long).startsWith("Thinking:"), stripAnsi(long));
});

test("three adjacent blocks form one tight multiline preview", () => {
  const adjacent = thinkingComp([
    { type: "thinking", thinking: "first reasoning block" },
    { type: "thinking", thinking: "second reasoning block" },
    { type: "thinking", thinking: "third reasoning block" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(adjacent, ["", LABEL, "", LABEL, "", LABEL]),
    [
      "",
      preview("first reasoning block"),
      preview("second reasoning block"),
      preview("third reasoning block"),
    ],
  );
});

test("empty thinking fragments neither consume labels nor break adjacency", () => {
  const interleaved = thinkingComp([
    { type: "thinking", thinking: "first reasoning block" },
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: " \n\t " },
    { type: "thinking", thinking: "second reasoning block" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(interleaved, ["", LABEL, "", LABEL]),
    ["", preview("first reasoning block"), preview("second reasoning block")],
  );
});

test("text, tools, and other semantic content end a thinking run", () => {
  const toolBoundary = thinkingComp([
    { type: "thinking", thinking: "before tool" },
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    { type: "thinking", thinking: "after tool" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(toolBoundary, [LABEL, "", LABEL]),
    [preview("before tool"), "", preview("after tool")],
    "an invisible tool call keeps the native boundary",
  );

  const otherBoundaries = thinkingComp([
    { type: "thinking", thinking: "before text" },
    { type: "text", text: "visible bridge" },
    { type: "thinking", thinking: "after text" },
    { type: "metadata", value: "semantic boundary" },
    { type: "thinking", thinking: "after other content" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(otherBoundaries, [LABEL, "", "visible bridge", "", LABEL, "", LABEL]),
    [
      preview("before text"),
      "",
      "visible bridge",
      "",
      preview("after text"),
      "",
      preview("after other content"),
    ],
  );
});

test("OSC marks from grouped labels stay before later semantic content", () => {
  const markedEnd = "\x1b]133;B\x07";
  const separated = thinkingComp([
    { type: "thinking", thinking: "first grouped step" },
    { type: "thinking", thinking: "second grouped step" },
    { type: "text", text: "visible boundary" },
    { type: "thinking", thinking: "later separate step" },
  ]);
  const out = dedupeThinkingLabels(
    separated,
    [LABEL, "", `${markedEnd}${LABEL}`, "", "visible boundary", LABEL],
  );
  assert.deepEqual(out, [
    preview("first grouped step"),
    `${markedEnd}${preview("second grouped step")}`,
    "",
    "visible boundary",
    preview("later separate step"),
  ]);
  assert.ok(!out.at(-1)!.includes(markedEnd), "a dropped mark must not cross the semantic boundary");
});

test("fallback labels fold only within a known run and preserve OSC marks", () => {
  const controlOnlyAdjacent = thinkingComp([
    { type: "thinking", thinking: "\x01" },
    { type: "thinking", thinking: "\x02" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(controlOnlyAdjacent, [LABEL, "", LABEL]),
    [LABEL],
    "unpreviewable adjacent payloads keep the duplicate-label fallback",
  );

  const markedStart = "\x1b]133;A\x07";
  const markedEnd = "\x1b]133;B\x07";
  assert.deepEqual(
    dedupeThinkingLabels(controlOnlyAdjacent, [`${markedStart}${LABEL}`, "", `${markedEnd}${LABEL}`]),
    [`${markedStart}${markedEnd}${LABEL}`],
    "later fallback marks retain their order after marks on the kept native row",
  );

  const mixedAdjacent = thinkingComp([
    { type: "thinking", thinking: "visible step" },
    { type: "thinking", thinking: "\x01" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(mixedAdjacent, [LABEL, "", `${markedEnd}${LABEL}`]),
    [preview("visible step"), `${markedEnd}${LABEL}`],
    "an unpreviewable block keeps one fallback row and receives its native OSC mark",
  );

  const controlOnlySeparated = thinkingComp([
    { type: "thinking", thinking: "\x01" },
    { type: "toolCall", id: "call-2", name: "read", arguments: {} },
    { type: "thinking", thinking: "\x02" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(controlOnlySeparated, [LABEL, "", LABEL]),
    [LABEL, "", LABEL],
    "semantic boundaries also separate fallback labels when content metadata exists",
  );

  assert.deepEqual(
    dedupeThinkingLabels({ hiddenThinkingLabel: "Thinking..." }, ["", LABEL, "", LABEL]),
    ["", LABEL],
    "missing content metadata retains the safe duplicate-label fallback",
  );

  const multiline = thinkingComp([{ type: "thinking", thinking: "first\nsecond" }]);
  const marked = `\x1b]133;C\x07${LABEL}`;
  const out = dedupeThinkingLabels(multiline, [marked]);
  assert.equal(out.length, 2);
  assert.ok(out[0]!.startsWith("\x1b]133;C\x07"), `native zone mark must survive: ${JSON.stringify(out)}`);
  assert.equal((out.join("").match(/\x1b\]133;C\x07/g) ?? []).length, 1, "synthetic rows do not duplicate OSC marks");

  assert.deepEqual(
    dedupeThinkingLabels({ hiddenThinkingLabel: "Pondering…" }, ["Pondering…", "", "Pondering…"]),
    ["Pondering…"],
    "a custom hidden-thinking label is respected",
  );
});
