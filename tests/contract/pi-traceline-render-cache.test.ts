import { test } from "node:test";
import assert from "node:assert/strict";
import { TraceRenderCache } from "../../extensions/pi-traceline/render-cache.ts";

test("shared memo invalidation reaches its dependants, not unrelated entries", () => {
  const cache = new TraceRenderCache();
  const shared = {}, unrelated = {}, a = {}, b = {}, c = {};
  let sharedWork = 0, unrelatedWork = 0;
  const sharedMemo = () => cache.memo(shared, "value", () => ++sharedWork);
  const renderA = () => cache.value(a, "80", () => sharedMemo());
  const renderB = () => cache.value(b, "80", () => sharedMemo());
  const renderC = () => cache.value(c, "80", () => cache.memo(unrelated, "value", () => ++unrelatedWork));
  renderA(); renderB(); renderC();
  renderA(); renderB(); renderC();
  assert.deepEqual({ sharedWork, unrelatedWork }, { sharedWork: 1, unrelatedWork: 1 });
  cache.dirty(shared);
  renderA(); renderB(); renderC();
  assert.deepEqual({ sharedWork, unrelatedWork }, { sharedWork: 2, unrelatedWork: 1 });
  assert.equal(cache.memo(shared, "outside", () => ++sharedWork), 3, "memo outside a render is not retained");
  assert.equal(cache.memo(shared, "outside", () => ++sharedWork), 4);
});

test("resize variants are bounded and retain live invalidation links", () => {
  const cache = new TraceRenderCache();
  const owner = {}, dependency = {};
  let work = 0;
  for (let width = 40; width < 57; width++) {
    cache.value(owner, String(width), () => { cache.depend(dependency); return ++work; });
  }
  assert.equal(cache.value(owner, "56", () => ++work), 17, "newest variant stays warm");
  assert.equal(cache.value(owner, "40", () => ++work), 18, "oldest variant was evicted");
  cache.dirty(dependency);
  assert.equal(cache.value(owner, "56", () => ++work), 19, "live dependency edge invalidates");
});
