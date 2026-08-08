import assert from "node:assert/strict";
import { test } from "node:test";

import type { Component } from "@earendil-works/pi-tui";
import { internals } from "../../extensions/pi-contextimate/index.ts";

const {
  prefixBlockLocations,
  removeExistingPrefixBlocks,
  reconcileContextBlockTree,
} = internals;

type TestContainer = { children: unknown[] };
type TestPrefixBlock = Component & { __piContextimateBlock: true };

function component(lines: string[]): Component {
  return {
    render: () => lines,
    invalidate: () => {},
  };
}

function prefixBlock(label: string): TestPrefixBlock {
  return {
    __piContextimateBlock: true,
    render: () => [`[Contextimate] ${label}`],
    invalidate: () => {},
  };
}

test("startup block reconciliation removes stale blocks across the live TUI tree", () => {
  const resource = component(["[Context]  AGENTS.md"]);
  const spacer = component([""]);
  const retained = component(["retained by another extension"]);
  const stale = prefixBlock("stale");
  const duplicate = prefixBlock("duplicate");
  const active = prefixBlock("active");
  const target: TestContainer = { children: [resource, spacer, duplicate, retained] };
  const staleContainer: TestContainer = { children: [stale] };
  const root: TestContainer = { children: [staleContainer, target] };
  const targetChildren = target.children;
  const staleChildren = staleContainer.children;

  assert.equal(reconcileContextBlockTree(root, target, active), true);
  assert.equal(target.children, targetChildren, "target children array identity is preserved");
  assert.equal(staleContainer.children, staleChildren, "stale container array identity is preserved");
  assert.deepEqual(target.children, [resource, spacer, active, retained]);
  assert.deepEqual(staleContainer.children, []);
  assert.deepEqual(prefixBlockLocations(root), [{ container: target, block: active }]);

  assert.equal(reconcileContextBlockTree(root, target, active), false, "canonical installation is idempotent");
  assert.deepEqual(target.children, [resource, spacer, active, retained]);
});

test("startup cleanup removes every marked block without replacing container arrays", () => {
  const first = prefixBlock("first");
  const second = prefixBlock("second");
  const nested: TestContainer = { children: [second] };
  const root: TestContainer = { children: [first, nested] };
  const rootChildren = root.children;
  const nestedChildren = nested.children;

  assert.equal(removeExistingPrefixBlocks(root), 2);
  assert.equal(root.children, rootChildren);
  assert.equal(nested.children, nestedChildren);
  assert.deepEqual(root.children, [nested]);
  assert.deepEqual(nested.children, []);
});
