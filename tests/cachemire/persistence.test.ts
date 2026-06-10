// Chat-line persistence: cachemire's scrollback lines survive pi's chat rebuilds
// (Ctrl+T reasoning toggle, etc.) by re-attaching at durable anchors. pi rebuilds the
// container from session messages, so raw appended children — including pi's own status
// lines — are dropped; these tests drive the pure anchor/re-attach machinery with
// synthetic children shaped like the real components (shape pinned by the contract suite).
import { test } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-cachemire/index.ts";
import type { AnchoredLine } from "../../extensions/pi-cachemire/index.ts";

const { childAnchorKey, anchorForAppend, reattachAnchored } = internals;

const tool = (id: string) => ({ toolCallId: id, render: () => [] });
const assistant = (ts: string) => ({ lastMessage: { role: "assistant", timestamp: ts }, render: () => [] });
const spacer = () => ({ kind: "spacer" });
const user = () => ({ kind: "user-message" }); // UserMessageComponent exposes no durable identity

test("childAnchorKey: durable identities only", () => {
  assert.equal(childAnchorKey(tool("t1")), "tool#t1");
  assert.equal(childAnchorKey(assistant("2026-06-10T22:00:00.000Z")), "assistant#2026-06-10T22:00:00.000Z");
  assert.equal(childAnchorKey(spacer()), undefined);
  assert.equal(childAnchorKey(user()), undefined);
  assert.equal(childAnchorKey(undefined), undefined);
});

test("anchorForAppend: nearest keyed predecessor, counting only unkeyed non-cachemire children", () => {
  const t1 = tool("t1");
  // [assistant, spacer, tool, spacer, user] → anchor = tool, gap = 2 (spacer + user)
  const children: unknown[] = [assistant("T0"), spacer(), t1, spacer(), user()];
  assert.deepEqual(anchorForAppend(children, []), { anchorKey: "tool#t1", gap: 2 });

  // Lines of ours already appended after the anchor are not part of the gap.
  const mine: AnchoredLine = { spacer: spacer(), text: { line: 1 }, anchorKey: "tool#t1", gap: 0 };
  const withOurs = [t1, mine.spacer, mine.text, spacer(), user()];
  assert.deepEqual(anchorForAppend(withOurs, [mine]), { anchorKey: "tool#t1", gap: 2 });

  // No keyed child at all: anchored to chat start.
  assert.deepEqual(anchorForAppend([spacer(), user()], []), { gap: 2 });
});

test("reattachAnchored: a Ctrl+T-style rebuild restores lines in place", () => {
  // Append-time chat: [assistantA, toolT, SPACER, missLine, spacer, userB, SPACER, notice]
  const missLine: AnchoredLine = { spacer: spacer(), text: { line: "miss" }, anchorKey: "tool#t1", gap: 0 };
  const notice: AnchoredLine = { spacer: spacer(), text: { line: "notice" }, anchorKey: "tool#t1", gap: 2 };

  // pi rebuilds from session messages: same sequence, new component objects, no our lines,
  // plus pi's trailing status line pair.
  const rebuilt: unknown[] = [assistant("T0"), tool("t1"), spacer(), user(), spacer(), { status: true }];
  const survivors = reattachAnchored(rebuilt, [missLine, notice]);

  assert.equal(survivors.length, 2);
  assert.equal(rebuilt.indexOf(missLine.text), 3, "miss line returns to directly after its tool row");
  assert.equal(rebuilt.indexOf(notice.text), 7, "notice returns to after the user message it preceded the response of");
  assert.equal(rebuilt.indexOf(missLine.spacer), rebuilt.indexOf(missLine.text) - 1, "spacer travels with its line");

  // Idempotent: a second pass (clear() is called twice per toggle) changes nothing.
  const again = reattachAnchored(rebuilt, survivors);
  assert.equal(again.length, 2);
  assert.equal(rebuilt.filter((c) => c === missLine.text).length, 1, "no duplicate insertion");
});

test("reattachAnchored: vanished anchors drop their lines; start-anchored lines survive", () => {
  const line: AnchoredLine = { spacer: spacer(), text: { line: "old" }, anchorKey: "tool#gone", gap: 0 };
  const rebuilt: unknown[] = [assistant("T9")];
  assert.equal(reattachAnchored(rebuilt, [line]).length, 0, "compaction/navigation removed the anchor — line drops");
  assert.equal(rebuilt.length, 1, "children untouched for dropped lines");

  // A line appended before any keyed child re-attaches at the chat start (after its gap).
  const ledger: AnchoredLine = { spacer: spacer(), text: { line: "ledger" }, gap: 1 };
  const fresh: unknown[] = [{ banner: true }, spacer(), { status: true }];
  const survivors = reattachAnchored(fresh, [ledger]);
  assert.equal(survivors.length, 1);
  assert.equal(fresh.indexOf(ledger.text), 2, "inserted after its gap from the start");
});

test("multiple lines on one anchor keep append order", () => {
  const a: AnchoredLine = { spacer: spacer(), text: { line: "a" }, anchorKey: "tool#t1", gap: 0 };
  const b: AnchoredLine = { spacer: spacer(), text: { line: "b" }, anchorKey: "tool#t1", gap: 0 };
  const rebuilt: unknown[] = [tool("t1"), { after: true }];
  reattachAnchored(rebuilt, [a, b]);
  const ia = rebuilt.indexOf(a.text);
  const ib = rebuilt.indexOf(b.text);
  assert.ok(ia < ib, "append order preserved");
  assert.equal(ia, 2, "first line directly after the anchor");
});
