# Scoped Traceline render cache

The cache reworks Alexey Bagno's [#106](https://github.com/tmustier/pine-of-glass/pull/106).
Cached output, ANSI styling and click membership must match an uncached render.

## Structure

`render-cache.ts` tracks dependencies between cached computations. Dirtying a row
invalidates its dependants. Nested hits depend on entry tokens, so a shared group
stores linear rather than quadratic dependency edges. Weak-map owners retain at most
16 variants; invalidation and eviction unlink dependencies and release stored values.

The cache stores row facts, shared fold/column plans, fitted lines and final layouts.
Fitted lines use their evaluated inputs as keys: a group update can reuse unchanged
members' layout work. Final layouts include stripped click geometry and fold members.

`topology.ts` indexes positions, visual blocks, assistant steps and bash predecessors.
Structural changes rebuild the index while retaining unchanged group identities.
Repetition follows assistant tool-call IDs. Bash context can cross collapsed thinking
but stops at prose, so visual blocks alone cannot describe every dependency.

## Invalidation

- Tool `updateDisplay()` covers arguments, results, expansion, image settings and
  custom renderer invalidation. Contract tests pin this private Pi method.
- Assistant `updateContent()` compares tool-call IDs and prose/reasoning boundaries.
  Ordinary text deltas leave historical tool rows cached.
- Container add/remove/clear hooks update topology and rebind on reload. Length
  checks also detect Pi's direct insertion before its streaming assistant.
- Width, theme identity, Drill selection and fold reveal state enter layout keys.
  Pi's identity-stable theme Proxy changes through TUI invalidation, which reaches
  each tool's `updateDisplay()`.
- Write snapshots dirty their tool row. Session, reload and configuration changes
  reset the cache. Native expanded rendering stays with Pi.

Finished rows can change. Custom renderers must signal changes through Pi's
invalidation API. Neither elapsed time nor `requestRender()` invalidates the cache.

## Validation and measurements

The two cache contract suites compare cached and raw output after real Pi mutations.
They assert avoided work, shared dependency invalidation and bounded resize variants.
Run `node --expose-gc scripts/dev/bench-trace-cache.ts` for isolated real-component
fixtures: 30 warm frames, 20 result updates and 5 appends, without model calls.
Every update must recapture only its changed tool's native invocation.

After simplification, 8 September 2026, Pi 0.85.1, Node 26.5.1. Medians in ms:

| Rows | Rows per block | Uncached | Warm | Active update |
|---|---|---|---|---|
| 50 | 5 | 45.334 | 0.019 | 0.119 |
| 200 | 5 | 180.745 | 0.068 | 0.147 |
| 500 | 5 | 497.468 | 0.183 | 0.253 |
| 200 | 200 | not timed | 0.068 | 1.516 |

These measure component rendering, not terminal paint or live-session latency.
Uncached medians have 3 samples; the giant case uses selected raw oracle rows because
full uncached frames exceeded the benchmark budget. Timings are not CI thresholds.
Post-GC heap deltas include fixture and runtime costs, not just cache storage.

Pi still visits mounted components. Structural edits reindex the transcript; updates
can reconsider every member of a large shared group. A live-session CPU and
interaction soak remains outstanding before merging.
