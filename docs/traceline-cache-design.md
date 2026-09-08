# Scoped Traceline render cache

This reworks [#106](https://github.com/tmustier/pine-of-glass/pull/106), contributed
by Alexey Bagno ([@swit33](https://github.com/swit33)). Both original commits are
preserved in the integration history. It does not include #112's call-summary work.

## Invariants

Cached output and its click membership must match the uncached renderer. There is no
TTL and no assumption that finished tools or provider result objects are immutable.
The cache does not use `requestRender()` as an invalidation signal.

`render-cache.ts` records a graph of computations. Nested cache hits depend on the
nested entry, not a copy of every underlying row. Dirtying a row invalidates its
computations and their dependants. Replacing or evicting an entry removes reverse
links; invalid entries release their stored values. Each owner has at most 16 variants
in insertion order. Owners live in weak maps.

The layers are:

- Row facts: native call capture, output counts, image/diff/record facts and invocation
  formatting. These survive unrelated row updates and, where width-independent,
  resizes.
- Topology: row positions, contiguous blocks, assistant-step membership and bash
  predecessor links. A cheap
  metadata pass runs after structural changes; unchanged group arrays retain identity.
  The last assistant pointer makes compact/native mode lookup constant-time per row.
- Shared plans: read/repetition folds, column facts, suffix reserves and path context.
  Compute once per affected group, rather than independently for each member.
- Fitted lines: key by the actual body, suffix, width, reserve, tone and view state.
  A group may need reconsideration without discarding unchanged fitted lines.
- Output layout: cache styled lines, stripped hit geometry and the exact fold members
  together. No per-repaint ANSI stripping or membership rescan on a warm hit.

Pi still walks mounted components. Cache hits do not make total frame work O(1).

## Mutation boundaries

- Pi 0.85.1 tool `updateDisplay()` is the central dirty seam for args/results,
  execution state, expansion, images and renderer-requested invalidation. Missing
  that seam disables caching for that tool prototype instead of serving stale data.
- Assistant `updateContent()` compares the shape that tools depend on: hidden-thinking
  state, empty/prose/reasoning boundary classification and tool-call IDs. Ordinary
  text deltas do not invalidate historical tool rows. This private method is pinned
  by a contract test.
- Container add/remove/clear updates topology, including earlier fold carriers.
  Pi also inserts messages before its streaming component with a direct splice;
  length changes trigger reindexing, and changed predecessor tokens invalidate bash
  context even if visual block membership stays identical.
  Hooks attach to replacement containers even when prototypes are already patched;
  their callback is rebound on reload without stacking wrappers.
- Click reveal/refold dirties affected rows. Drill number/selection state participates
  in each row's output and fitting key. Native expanded rendering stays with Pi.
- Write snapshot capture dirties an existing matching tool row, if any.
- Theme object keys distinguish explicit theme objects. Pi's production theme is an
  identity-stable Proxy, so the real theme-change contract matters: InteractiveMode
  invalidates its TUI, reaching each tool's `invalidate()` and `updateDisplay()`.
  A real-theme contract test covers this path. We do not replace Pi's single-slot
  `onThemeChange` listener or add a private theme-symbol lookup.
- Session/reload and configuration changes reset the cache. A temporarily missing
  chat container takes the uncached path, rather than storing structure-blind output.

Repetition membership follows assistant-step tool IDs. Bash preamble dependencies
follow the preceding bash across reads, empty connectors and collapsed thinking,
but stop at prose. Both relationships can differ from contiguous visual blocks.

## Validation

`tests/contract/pi-traceline-render-cache.test.ts` and
`tests/contract/pi-traceline-cache-transitions.test.ts` use real Pi components and
compare exact cached and uncached strings, including ANSI. They cover warm hits,
same-object mutations, group isolation, fold errors/size breakouts, append/remove,
path emphasis, cross-block bash preambles, text streaming, expansion, native custom
renderer invalidation, the real theme Proxy, resize, Drill and new containers.
Engine tests cover nested dependencies and variant eviction. Final validation on
main including #111: lint, typecheck, all 357 tests and all real-Pi smoke suites pass. Existing native click
and reasoning contracts continue to run against the patched prototype.

`node --expose-gc scripts/dev/bench-trace-cache.ts` runs each fixture in a separate
process with real Pi tool components and no model calls. It measures cold renders,
30 warm frames, 20 result updates and 5 appends. Work-count assertions require zero
warm captures/misses and exactly one native invocation recapture per active update.
Only the active block's output entries are reconsidered.

## Measurements

One local run on 8 September 2026, Pi 0.85.1 and Node 26.5.1. These are synthetic
component-render measurements, not terminal paint, scrolling or live-provider latency.
Medians are milliseconds; raw rendering has only three samples. Cold measurements
include JIT effects and are not directly comparable across fixture sizes.

| Tool rows | Rows per block | Uncached | Cold | Warm | Active update | Append |
|---|---|---|---|---|---|---|
| 50 | 5 | 56.394 | 11.599 | 0.024 | 0.235 | 0.306 |
| 200 | 5 | 203.998 | 29.787 | 0.076 | 0.169 | 0.385 |
| 500 | 5 | 600.313 | 60.449 | 0.159 | 0.295 | 0.791 |
| 200 | 200 | not timed | 31.079 | 0.082 | 2.162 | 2.379 |

For five-row blocks, every update reconsidered five output entries and recaptured one
native invocation, regardless of transcript length. In the single 200-row block, all
200 output entries were reconsidered, but unchanged invocation/fitting computations
remained cached; the active-update p95 was 3.249 ms. The giant uncached case took too
long for the benchmark's original time budget, so the script checks selected raw
oracle rows instead of reporting a misleading partial-frame baseline.

The script also reports post-GC process heap deltas. These include JIT/runtime and
fixture effects, not just cache bytes; do not interpret them as per-row cache sizes.
There are deliberately no machine-dependent timing thresholds in `npm test`.

## Remaining limits

- Structural changes still rebuild cheap topology metadata across the transcript.
  They do not reparse or reformat unrelated historical rows.
- A change inside one giant group can reconsider that whole group. There is no claim
  of constant work for arbitrarily large shared column/fold scopes.
- Resize retains raw facts but invalidates width-dependent output. Real theme changes
  currently invalidate mounted row facts too, following Pi's existing invalidation.
- Custom renderer changes must use Pi's invalidation contract. A renderer that changes
  its output without signalling invalidation cannot safely participate in memoization.
- A representative live-session CPU/interaction soak remains useful before merging;
  synthetic wins alone do not establish an end-to-end user-visible speedup.
