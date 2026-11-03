// The shared provider request cycle: which before_provider_request belongs to the agent loop.
import { test } from "node:test";
import assert from "node:assert/strict";

import { RequestTracker } from "../../extensions/_lib/request-cycle.ts";

const turn = (...messages: string[]) => ({ max_tokens: 4096, messages: messages.map((content) => ({ role: "user", content })) });
const warm = (payload: ReturnType<typeof turn>) => ({ ...payload, max_tokens: 1 });

function tracker() {
  const requests = new RequestTracker<{ id: number; attempts: number }>();
  let next = 1;
  const send = (payload: unknown) => requests.payload(payload, () => ({ id: next++, attempts: 1 }), (sent) => { sent.attempts++; });
  return { requests, send };
}

test("only an armed payload starts a request", () => {
  const { requests, send } = tracker();
  assert.equal(send(turn("a")), false);
  assert.equal(requests.inFlight, undefined);
  requests.arm();
  assert.equal(send(turn("a")), true);
  assert.deepEqual(requests.inFlight, { id: 1, attempts: 1 });
});

test("a second payload for the in-flight request is a re-attempt of the same request", () => {
  const { requests, send } = tracker();
  requests.arm();
  send(turn("a"));
  assert.equal(send({ ...turn("a"), tools: [{ strict: false }] }), true);
  assert.deepEqual(requests.settle(), { sent: { id: 1, attempts: 2 }, respondedAt: undefined });
});

test("a warm replay of the last request never consumes the arm, before or during a request", () => {
  const { requests, send } = tracker();
  requests.arm();
  send(turn("a"));
  requests.settle();
  requests.arm();
  requests.expectReplay();
  assert.equal(send(warm(turn("a"))), false, "replayed while the next request is armed");
  assert.equal(requests.armed, true);
  assert.equal(send(turn("a", "b")), true);
  requests.expectReplay();
  assert.equal(send(warm(turn("a", "b"))), false, "replayed while the request streams");
  assert.deepEqual(requests.inFlight, { id: 2, attempts: 1 });
});

test("a refresh aborted by the next request can still deliver its replay after that request is sent", () => {
  const { requests, send } = tracker();
  requests.arm();
  send(turn("a"));
  requests.settle();
  requests.expectReplay();
  requests.arm();
  assert.equal(send(turn("a", "b")), true);
  assert.equal(send(warm(turn("a"))), false, "the late replay is not a second attempt of the new request");
  assert.deepEqual(requests.inFlight, { id: 2, attempts: 1 });
});

test("a replay is recognised by its conversation whatever cap the adapter wrote", () => {
  const { requests, send } = tracker();
  const responses = { max_output_tokens: 32_000, input: [{ role: "user", content: "a" }] };
  requests.arm();
  send(responses);
  requests.settle();
  requests.expectReplay();
  // OpenAI Responses raises the warmer's one-token cap to its minimum of 16.
  requests.arm();
  assert.equal(send({ ...responses, max_output_tokens: 16 }), false);
  assert.equal(requests.armed, true);
});

test("a warm decision that no replay follows does not swallow a later request", () => {
  const { requests, send } = tracker();
  requests.arm();
  send(turn("a"));
  requests.settle();
  requests.expectReplay(); // an extension stopped the refresh
  requests.arm();
  assert.equal(send(turn("a", "b")), true);
  requests.settle();
  requests.expectReplay(); // stopped again
  requests.abandon(); // agent_end: Pi retries a failed request only after the run ends
  requests.arm();
  assert.equal(send(turn("a", "b")), true, "a retry resending the same conversation is not a replay");
  assert.deepEqual(requests.inFlight, { id: 3, attempts: 1 });
});

test("a response is attributed only when no replay waits for its own", () => {
  const { requests, send } = tracker();
  requests.arm();
  send(turn("a"));
  requests.responded(100);
  requests.responded(200);
  assert.equal(requests.settle()?.respondedAt, 100, "the first response anchors the request");

  requests.arm();
  send(turn("a", "b"));
  requests.expectReplay();
  send(warm(turn("a", "b")));
  requests.responded(300);
  requests.responded(400);
  assert.equal(requests.settle()?.respondedAt, undefined, "either response may be the replay's");

  requests.arm();
  send(turn("a", "b", "c"));
  requests.responded(500);
  assert.equal(requests.settle()?.respondedAt, 500, "a settled request leaves no ambiguity behind");
});

test("abandoning drops the request and any expected replay", () => {
  const { requests, send } = tracker();
  requests.arm();
  send(turn("a"));
  requests.expectReplay();
  assert.deepEqual(requests.abandon()?.sent, { id: 1, attempts: 1 });
  assert.equal(requests.inFlight, undefined);
  assert.equal(send(turn("a")), false);
  requests.arm();
  assert.equal(send(turn("a")), true);
  assert.deepEqual(requests.inFlight, { id: 2, attempts: 1 });
});
