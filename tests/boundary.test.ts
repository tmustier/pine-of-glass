import assert from "node:assert/strict";
import { test } from "node:test";
import { isJsonObject, stringValue, type JsonValue } from "../extensions/_lib/boundary.ts";

test("shallow object inspection leaves each field unvalidated", () => {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Deliberately erase fixture evidence to test the guard's type promise on external input.
  const candidate: unknown = { label: "example", callback: () => 1 };
  assert.ok(isJsonObject(candidate));
  assert.equal(stringValue(candidate.label), "example");
  assert.equal(stringValue(candidate.callback), undefined);

  // SAFETY: compile-time regression assertion: a shallow object check must not promise
  // that its fields are recursively JSON-compatible. This must fail under tsc.
  // @ts-expect-error field has not been validated
  const unvalidated: JsonValue = candidate.callback;
  assert.equal(typeof unvalidated, "function");

  for (const value of [null, undefined, [], "text", 12]) {
    assert.equal(isJsonObject(value), false);
  }
});
