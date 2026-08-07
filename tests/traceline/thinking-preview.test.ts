// Collapsed-thinking preview grammar (design language §9.11): adjacent provider
// fragments append into one display row, while every non-thinking content entry is a
// semantic boundary. The installed-Pi suite separately pins native label spacing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { dedupeThinkingLabels } from "../../extensions/pi-traceline/thinking-preview.ts";

const LABEL = "\x1b[3mThinking...\x1b[23m";
const preview = (text: string) => `\x1b[3m${text}\x1b[23m`;

function thinkingComp(content: Array<Record<string, unknown>>) {
  return { hiddenThinkingLabel: "Thinking...", lastMessage: { content } };
}

test("a single block appends every non-empty line into one width-bounded preview", () => {
  const multiline = thinkingComp([
    { type: "thinking", thinking: "\n  **first reasoning line**\nsecond reasoning line" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(multiline, ["", LABEL]),
    ["", preview("first reasoning line · second reasoning line")],
  );

  const paragraphs = thinkingComp([
    { type: "thinking", thinking: "first paragraph\n\n\nsecond paragraph" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(paragraphs, [LABEL]),
    [preview("first paragraph · second paragraph")],
    "source paragraph breaks do not create display rows",
  );

  const mixedParagraphs = thinkingComp([
    { type: "thinking", thinking: "**Planning summary**\n\nordinary prose paragraph\n\n**Next summary**" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(mixedParagraphs, [LABEL]),
    [preview("Planning summary · ordinary prose paragraph · Next summary")],
    "summary and prose fragments follow the same one-line rule",
  );

  const literalStar = dedupeThinkingLabels(
    thinkingComp([{ type: "thinking", thinking: "2 * 3 = 6" }]),
    [LABEL],
  )[0]!;
  assert.equal(stripAnsi(literalStar).trim(), "2 * 3 = 6", "markdown rendering preserves genuine stars");

  const long = dedupeThinkingLabels(
    thinkingComp([{
      type: "thinking",
      thinking: "first framing thought\nintermediate detail that will be cut\nnewest appended thought",
    }]),
    [LABEL],
    52,
  )[0]!;
  const visibleLong = stripAnsi(long);
  assert.ok(visibleWidth(long) <= 52, `preview must respect row width: ${visibleLong}`);
  assert.ok(visibleLong.startsWith("first"), visibleLong);
  assert.ok(visibleLong.includes("…"), visibleLong);
  assert.ok(visibleLong.endsWith("newest appended thought"), visibleLong);

  const wide = dedupeThinkingLabels(
    thinkingComp([{ type: "thinking", thinking: `提交内容 ${"analysis ".repeat(40)}` }]),
    [LABEL],
    187,
  )[0]!;
  assert.equal(visibleWidth(wide), 187, `wide-character preview must fit: ${stripAnsi(wide)}`);
});

test("three adjacent blocks append into one preview row", () => {
  const adjacent = thinkingComp([
    { type: "thinking", thinking: "first reasoning block" },
    { type: "thinking", thinking: "second reasoning block" },
    { type: "thinking", thinking: "third reasoning block" },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(adjacent, ["", LABEL, "", LABEL, "", LABEL]),
    [
      "",
      preview("first reasoning block · second reasoning block · third reasoning block"),
    ],
  );
});

test("standalone summary paragraphs append within and across provider blocks", () => {
  const sessionShape = thinkingComp([
    {
      type: "thinking",
      thinking: "**Implementing conditional HUD rendering**\n\n**Assigning active inline renderer in factory**",
    },
    {
      type: "thinking",
      thinking: "**Refining editor text update flow**\n\n**Implementing dispatch control around edits**",
    },
  ]);
  assert.deepEqual(
    dedupeThinkingLabels(sessionShape, [LABEL]),
    [preview(
      "Implementing conditional HUD rendering · Assigning active inline renderer in factory · "
      + "Refining editor text update flow · Implementing dispatch control around edits",
    )],
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
    ["", preview("first reasoning block · second reasoning block")],
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
    `${markedEnd}${preview("first grouped step · second grouped step")}`,
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
    [`${markedEnd}${preview("visible step")}`],
    "an unpreviewable fragment adds no row and its native OSC mark reaches the run preview",
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
  assert.equal(out.length, 1);
  assert.ok(out[0]!.startsWith("\x1b]133;C\x07"), `native zone mark must survive: ${JSON.stringify(out)}`);
  assert.equal((out.join("").match(/\x1b\]133;C\x07/g) ?? []).length, 1, "the one preview keeps one OSC mark");

  assert.deepEqual(
    dedupeThinkingLabels({ hiddenThinkingLabel: "Pondering…" }, ["Pondering…", "", "Pondering…"]),
    ["Pondering…"],
    "a custom hidden-thinking label is respected",
  );
});
