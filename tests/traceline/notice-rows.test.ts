// Notice headlines (design language §9.15): what one line says for a custom message
// or entry, in precedence order, and what the char cell counts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import type { NoticeRowDataLike } from "../../extensions/_lib/chat.ts";
import { stripTrailingExpandHint } from "../../extensions/pi-traceline/native-lines.ts";
import { firstMeaningfulLine, noticeContentChars, noticeHeadline } from "../../extensions/pi-traceline/notice-rows.ts";

const plain = (row: NoticeRowDataLike) => stripAnsi(noticeHeadline(row, undefined));
const rendering = (...lines: string[]) => ({ render: () => lines });

test("first meaningful content line drops heading, quote, list markers, emphasis, code ticks and link syntax", () => {
  assert.equal(firstMeaningfulLine("\n\n## Deploy **finished**\n\nbody"), "Deploy finished");
  assert.equal(firstMeaningfulLine("> - 1. `api-gateway` is [live](https://x)  now"), "api-gateway is live now");
  assert.equal(firstMeaningfulLine("---\n\n   \nSecond paragraph"), "Second paragraph");
  assert.equal(firstMeaningfulLine("\n  \n"), undefined);
});

test("precedence: details.summary, then the renderer's collapsed line, then content, then the bare label", () => {
  const content = [{ type: "text", text: "# Worker asks\n\nmay I continue?" }];
  const withAll: NoticeRowDataLike = {
    message: { customType: "subagent-request", content, details: { summary: "worker  asks\nto continue" } },
    customComponent: rendering("", " [subagent] worker needs a decision (ctrl+o to expand) "),
  };
  assert.equal(plain(withAll), "[subagent-request] worker asks to continue");
  assert.equal(plain({ ...withAll, message: { customType: "subagent-request", content } }), "[subagent] worker needs a decision");
  assert.equal(plain({ message: { customType: "subagent-request", content } }), "[subagent-request] Worker asks");
  assert.equal(plain({ message: { customType: "subagent-request", content: "   \n" } }), "[subagent-request]");
});

test("a renderer line without its own label gets the customType in front; a throwing renderer falls through", () => {
  assert.equal(
    plain({ entry: { customType: "my-entry", data: {} }, customComponent: rendering("saved 3 files") }),
    "[my-entry] saved 3 files",
  );
  assert.equal(
    plain({ message: { customType: "x", content: "fallback line" }, customComponent: { render: () => { throw new Error("boom"); } } }),
    "[x] fallback line",
  );
  assert.equal(plain({ entry: { customType: "my-entry", data: { summary: "from data" } } }), "[my-entry] from data");
});

test("the hint strip is anchored to the line end and keeps everything before it", () => {
  assert.equal(stripAnsi(stripTrailingExpandHint("[skill] name (ctrl+o to expand)")), "[skill] name");
  assert.equal(stripAnsi(stripTrailingExpandHint("(ctrl+o to expand) is not a hint here")), "(ctrl+o to expand) is not a hint here");
});

test("the char cell counts a message's text blocks and never an entry", () => {
  assert.equal(noticeContentChars({ message: { customType: "x", content: "abc" } }), 3);
  assert.equal(noticeContentChars({ message: { customType: "x", content: [{ type: "text", text: "ab" }, { type: "image" }, { type: "text", text: "cd" }] } }), 5);
  assert.equal(noticeContentChars({ entry: { customType: "x", data: { huge: "y".repeat(5_000) } } }), undefined);
});
