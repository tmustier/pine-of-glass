# Test design

Tests in this repo exist to catch three specific kinds of breakage, in order of real-world
likelihood. Anything that does not map to one of these failure modes does not get a test.

1. **Pi drift**: the extensions reach into Pi internals (prototype patching, duck-typed
   component detection, system-prompt regex parsing, `buildSessionContext`/`convertToLlm`
   imports). `pi update` can silently invalidate any of these assumptions. This is the #1
   failure mode and it is *not* catchable by conventional unit tests.
2. **Silent regression of subtle pure logic**: ANSI-aware truncation, SGR filtering, token
   formula constants, heuristic precedence, alignment layout. These encode hard-won
   behaviour (several were the subject of past fix commits) and a wrong answer renders as
   plausible-looking output, so a human won't notice.
3. **Render regressions**: alignment, row order, and labels in the family views.
   These change as a side effect of unrelated edits (e.g. the Total-row reorder) and are
   only verifiable today by eyeballing a live TUI.

## Public interfaces: what a test may touch

A test is a specification of a capability. It names something the extension does for a
user ("enabling meantime makes `/pace` answer with the ledger"), drives that capability
through the surface a user or Pi would use, and asserts on what a user would see. The
code behind the capability can change entirely; the test should not have to. A test that
breaks on a refactor with no behaviour change is a bug in the test.

Three tiers, from most to least preferred:

1. **Extension behaviour goes through Pi.** The public interface of an extension is its
   default export loaded by Pi, the config files it reads, the events Pi delivers, the
   commands it registers, and the UI surface it writes to (notifications, widgets,
   status, chat lines, terminal input). `tests/harness/extension-host.ts` makes this
   cheap: it loads the default export through Pi's real factory loader into a real
   `ExtensionRunner`, records the UI, and isolates `process.cwd()` and `$HOME` so config
   files can be written per test. `tests/meantime/feature-flag.test.ts` is the reference
   shape. Prefer this tier for lifecycle, commands, config, and anything a user sees.
2. **Pure logic goes through the named exports of a domain module.** ANSI truncation,
   SGR filtering, token formulas, heuristic precedence and retention policy are contracts
   whose inputs and outputs are the specification. Test them directly from their module
   (`extensions/_lib/*.ts` or an extension's own domain module such as
   `pi-cachemire/retention.ts`), with tables and invariants, not by inspecting how they
   compute. A module's exports are its interface; if a test needs something the module
   does not export, the module boundary is wrong, not the test.
3. **Privates of `index.ts` are not a test surface.** The `export const internals`
   grab bags exist because logic was never extracted from the entry files. They are a
   migration ledger, not an API: `npm run lint` fails if one grows (POG012), and each
   entry leaves by moving its logic into a domain module (tier 2) or testing the
   behaviour through the harness (tier 1). Do not add entries.

What a good test in any tier looks like:

- The name states the capability in user terms, not the function under test.
- Inputs are the smallest realistic fixture; synthetic duck-typed comps are fine where
  the contract suite proves the duck type against real Pi.
- Assertions are on outputs and visible state, never on which helpers ran or in what
  order. `assert.deepEqual(events, ["session_start", ...])` against a fake `pi` is the
  anti-pattern this section exists to stop.
- It fails against the bug it guards or a plausible mutation. Delete tests that cannot.

## Explicit non-goals

Deliberately **not** tested:

- **Pi's own renderer output.** `pi-traceline` reuses Pi's `renderCall` for the invocation
  text; golden-testing that text would couple us to Pi's visual grammar, which we *want* to
  drift with Pi. We only test our transformations of it (truncation, recolouring, suffix).
- **Patch mechanics against mocks of Pi internals.** A mock TUI would mirror our own
  assumptions and pass forever. The contract suite (below) tests the assumptions against
  the *real installed Pi* instead, which is strictly stronger.
- **Exact token counts against live providers in CI.** Cost, flake, auth. Live accuracy is
  what `scripts/contextimate/probe-live-prefix.mjs` and the issue-#8 checker are for, run
  manually. Tests assert formula *determinism* against frozen fixtures, not provider truth.
- **Styling coverage for its own sake.** No tests that assert specific ANSI colour codes
  except where colour encodes state (tool status) or where stripping/filtering is the
  function under test.

## Infrastructure

- **Runner:** `node:test` + `node:assert/strict`, native TypeScript type stripping
  (Node ≥ 22.6; this repo develops on 26). **Zero new dependencies.**
- **Pi runtime linkage:** `scripts/dev/link-pi-runtime.sh` symlinks the globally installed
  Pi packages (`pi-coding-agent`, `pi-tui`, `pi-ai`, `pi-agent-core`) into the repo's
  gitignored `node_modules/`. Tests and `tsc --noEmit` resolve against the *real* installed
  runtime. Pi 0.85.1 is the minimum supported version, so a `pi update` followed by
  `npm test` is the drift detector.
- **Testability route:** pure domain logic lives in importable domain modules; see
  "Public interfaces" above. Pi imports only each extension's default entry point, so
  named exports are runtime-inert. Split files by domain when the code needs it, as
  cachemire's renderer and meantime's timing/render modules do. The legacy `internals`
  objects on the three older entry files only shrink.
- **Extension host:** `tests/harness/extension-host.ts` hosts a default export the way
  Pi does (real loader, real runner, recorded UI, isolated project and home directories).
  Pi installs a UI context by spreading it, so the recorder's members are own properties.
  There is no chat container in the recorder; chat lines arrive through each extension's
  own notify fallback and are read from `ui.notifications`.
- **Scripts:** `npm run lint` (agent coding-standard and generated-doc drift checks),
  `npm run docs:cache` (regenerate Cachemire retention docs),
  `npm run typecheck`, `npm test` (unit + render + contract),
  `npm run check` (lint + typecheck + tests), and `npm run test:smoke`
  (tmux startup smoke, local-only).

Layout:

```
tests/
  harness/extension-host.ts          # real Pi loader + runner + recorded UI
  contract/*.test.ts                 # layer 1: Pi drift and lifecycle contracts
  contextimate/*.test.ts             # layer 2/3
  traceline/*.test.ts                # layer 2
  cachemire/*.test.ts                # layer 2/3
  meantime/*.test.ts                 # layer 2/3
  fixtures/                          # frozen system prompts, tool schemas, goldens
scripts/dev/link-pi-runtime.sh
```

## Layer 1: contract tests against the installed Pi (drift)

`tests/contract/*.test.ts` import the real installed Pi and assert every structural
assumption the extensions make. Each assertion names the extension code that depends on
it. When `pi update` breaks one, the failure message says exactly which seam moved.

| Assumption | Depended on by |
|---|---|
| `buildSessionContext`, `convertToLlm`, `keyText` are exported with compatible shapes (callable; `convertToLlm` yields messages with `role`, `content`; thinking blocks expose `thinking`/`thinkingSignature`; toolCall blocks expose `id`/`name`/`arguments`) | contextimate `buildSessionBreakdown` |
| A real Pi-built system prompt (constructed via Pi's own prompt assembly against a fixture project dir with an AGENTS.md and one skill) matches `PROJECT_INSTRUCTIONS_RE`, `AVAILABLE_SKILLS_RE`, `SKILL_RE`, and `getPromptRemainder` strips both blocks | contextimate section parsing; it silently renders wrong buckets if the prompt format drifts |
| `[Context]`/`[Skills]`/… resource headers still render in the startup transcript shape matched by `RESOURCE_HEADER_RE` | contextimate block insertion point |
| `ToolExecutionComponent` (or successor) instances satisfy `isToolRow`: `render`, `setExpanded`, `toolName` in instance; prototype is patchable | traceline prototype patch |
| A successful silent built-in bash call returns exactly `(no output)` | traceline's terminal `gh pr merge` evidence rule |
| Native thinking toggles preserve assistant and family-line identities; native rebuilds trigger anchored-line restoration and retire missing anchors | shared chat-line persistence |
| Assistant message component satisfies `isAssistantRow`: `setHideThinkingBlock` fn + `hideThinkingBlock` boolean | traceline collapse-state source of truth |
| A collapsed `AssistantMessageComponent` skips empty thinking blocks, emits one label per adjacent thinking run, and keeps native spacers across tool and text boundaries | traceline grouped thinking previews |
| Real assistant thinking runs retain Pi's native `MouseRegion` and `thinkingVisibilityOverrides` behaviour after preview substitution: independent clicks, streaming rebuilds, Ctrl+T reset, links and drag selection | traceline reasoning preview clicks |
| Two extensions loaded through Pi's real factory loader and `ExtensionRunner` distinguish headless and interactive sessions through `ctx.hasUI`; a headless child cannot write into Cachemire's interactive ledger, while the root still can | cachemire process-global session ownership |
| The same two-runner setup keeps a headless child's `session_start` and `session_shutdown` from dropping the interactive Traceline TUI handle or Ctrl+T listener | traceline process-global TUI ownership |
| Direct OpenAI request payloads can expose `prompt_cache_retention`; Codex OAuth uses a separate backend shape with a cache key but no public API retention field | cachemire route, model and outgoing-policy evidence |
| Native OpenAI Completions accounts top-level `usage.cached_tokens` for Moonshot, Moonshot CN and Together, while preserving detailed-field precedence and cost accounting | cachemire provider usage accounting |
| `ExtensionAPI` exposes `getActiveTools()` ⊆ `getAllTools()` by name; `ToolInfo` has `name`, `description`, `parameters`, `sourceInfo{scope,source,origin,path}`, `promptGuidelines` | contextimate tools section |

Where instantiating real components is impractical, the contract test asserts on the
class/prototype from Pi's modules rather than a live TUI; that is still the real artifact,
not a mock. Anything requiring a live terminal goes to the smoke layer instead.

## Layer 2: pure-logic unit tests

### traceline

- **`middleTruncate` invariants** (property-style over a table of ANSI-laden inputs ×
  widths): result visible-width ≤ width; tail of the visible string is preserved verbatim
  (basename + `:range` survive); short input returned unchanged; no half-emitted SGR
  sequence (strip-then-rebuild round-trips); falls back to tail-truncation below
  `MIN_HEAD_COLS`.
- **`rawIndexAtVisibleIndex` / `rawIndexBeforeVisibleIndex`** against strings mixing SGR,
  OSC-8 links, and plain text; off-by-one here corrupts every truncated row.
- **`stripSgrBackgrounds` / `stripSgrForegrounds`**: parameterised over `38;2;r;g;b`,
  `38;5;n`, `48;…`, basic 30–37/90–97, mixed multi-param sequences (`\x1b[1;31;48;5;2m`);
  asserts non-colour params (bold) survive.
- **`fitOneLineAndSuffix`**: suffix right-aligned at exact width; ≥1 gap column; suffix
  wins when width is tiny; no overlap at any width (sweep widths 1..120 on one fixture).
- **`formatCharCount`, `lineRange`, `tildify`**: table-driven exact outputs (these strings
  are user-facing grammar).
- **`toolStatus`**: result+`isError` → error; result+complete → success; partial/none →
  running.
- **Record evidence**: a successful terminal `gh pr merge <number>` may graduate from
  Pi's exact `(no output)` result; auto modes, status masks and later commands do not.
  Same-row state verification accepts bare or JSON `MERGED` state and matches the
  explicit merge and view targets.
- **Collapsed thinking previews**: three adjacent non-empty blocks and every non-empty
  line inside them append into one ` · `-separated display row; source paragraph breaks
  never add rows; empty thinking fragments do not consume labels or break adjacency;
  text, tools and other semantic content do; fallback labels, OSC marks, middle-truncated
  tail visibility and width bounds remain covered.

### contextimate

- **Heuristic resolution precedence** (`resolveHeuristic`): fallback < default profile <
  flat defaults < built-in model rule < config rules in order, later rules override
  earlier. `parseContextimateConfig` drops non-positive JSON denominators before
  resolution; `cleanDenominator` remains the defensive pure boundary for direct patches.
  This is user-configurable surface; precedence bugs misprice every row.
- **Built-in rule matching**: boundary tables map explicit model IDs to measured
  families and leave dynamic or unverified aliases on the fallback. Separate cases pin
  Claude family boundaries and tool payload routing by provider and API.
- **Tool payload shaping**: for one frozen `ToolSummary` fixture, the exact JSON emitted
  per tool numerator (`anthropic`, `openai-responses`, `openai-chat`, `bedrock`,
  `raw-schema`), the *aggregated* gemini `functionDeclarations` form, and the
  unknown-numerator fallback to the OpenAI Responses payload.
  Consistency invariant: `buildToolDisplayEstimate` counts the same payload that
  `buildToolNumerator` counts (per-tool vs aggregate); this is also the invariant the
  issue-#8 checker must preserve.
- **OpenAI cookbook formula** (`estimateOpenAIFunctionToolTokens`): frozen multi-tool
  fixture (nested objects, arrays, enums) → exact expected token number, computed once by
  hand from the documented constants (+7/fn, +3/prop-section, +3/prop, −3/enum,
  +3/enum-item, +12 once, chars/6.6 fragments). Guards the constants against "harmless"
  refactors.
- **System-prompt parsing**: fixture prompt with two `<project_instructions>` blocks, an
  `<available_skills>` list with XML entities (`&amp;`, `&apos;`) → correct section split,
  unescaped names, wrapper-chars math (`content − Σ skill chars ≥ 0`); prompt *without*
  skills/context blocks degrades to a single system section.
- **Session estimate math** (`buildSessionEstimate`): with `contextUsage` → totalSource
  `"pi"`, `unattributed = total − tools − messages − uncovered thinking summaries −
  exact retained reasoning` clamped ≥ 0; without → heuristic fallback. The session walk
  sums provider-reported `usage.reasoning`, including zero, on documented Anthropic and
  OpenAI Responses retention paths under Pi's exact provider/API/model identity. Boundary
  fixtures pin Anthropic's keep-all families, OpenAI's all-turns and current-turn defaults,
  cross-model summary conversion, relays, missing breakdowns, and trailing local estimates
  including excluded bash messages. The exact prompt total, including cache reads and
  writes, rejects impossible history. Summary text and opaque signatures never become
  estimated reasoning.
- **Token label alignment** (`tokenLabelLayout`/`estimatedTokenField`/`exactTokenLabel`):
  for value sets spanning <1k/≥1k/≥100k, all emitted fields share one visible width and
  `~`/exact variants align; this is the invariant behind the recent column-alignment commits.
- **Snapshot signature**: identical inputs → identical signature; changing the active tool
  set, model, config, or session chars each changes it (render-cache invalidation).

### cachemire

- **Model-switch currency**: target forecasts never classify provider usage against an
  old-model token count or rescale a target estimate from a source-model bill.
  Switch-back warmth requires exact provider, API and model identity plus an active TTL
  or minimum. Unknown retention makes no warmth claim, and compaction invalidates prior
  warmth.
- **Stable model-switch forecast**: tests pin the target-family estimate from canonical
  system, tools and history. An event test proves that the outgoing payload does not
  replace that estimate. The [forecast probe](../scripts/cachemire/README.md) records
  aggregate estimates and exact usage without prompt content.
- **Retention evidence**: `retention.ts` drives runtime resolution and generated policy
  docs. `retention-evidence.test.ts` pins routes and boundaries; clock tests pin visible
  wording; `pi-cache-retention-seams.test.ts` covers installed Pi routes. `npm run lint`
  rejects stale generated blocks.
- **Provider response normalization**: native Pi contracts replay SSE usage fixtures
  and check field precedence, explicit zero counts, token totals and cost.
- **Restored freshness**: persisted lineage uses the parent entry timestamp as its
  request anchor and response time only as fallback. Model-level registry policies can
  resolve after restore; request-only evidence stays unknown because the outgoing payload
  was not persisted.

### meantime

- **Segment and resolution arithmetic**: the bare stream start does not set TTFT;
  thinking, text and tool-argument events open the right spans; silent reasoning omits
  a resolved rate because its generation start is not observable.
- **Tool interval union**: parallel intervals count once, harness gaps do not count as
  live or resolved tool time, and harness duration is only attached when a next request
  supplies an end boundary.
- **Per-model baselines and calibration**: medians filter on provider-qualified model
  identity and need the configured sample floor. Live thinking has no rate; writing
  calibration skips calls without a usable reasoning split.
- **Session totals and config parsing**: open idle time contributes to idle, active is
  the watched span minus idle, and malformed boundary values are ignored.
- **Opt-in through config**: hosted through the extension harness, a project without
  `.pi/pi-meantime.json` has no `/pace` and no widget; `enabled: true` answers `/pace`
  with the ledger and shows the waiting clock once a provider request is in flight;
  `widget: false` keeps `/pace` and suppresses the widget.

## Layer 3: render goldens

`tests/contextimate/render-golden.test.ts` builds one synthetic `PrefixSnapshot` (fixture:
2 context files, 3 skills, 4 tools incl. one inactive, session breakdown + contextUsage)
with a stub `Theme` whose styles emit distinguishable plain markers, renders
`renderSummary` / `renderCompact` / `renderExpanded` at widths 80 and 120, strips ANSI,
and compares against checked-in golden files (`tests/fixtures/goldens/*.txt`).

- Catches: row order (e.g. Total-below-subtotals), label/caveat wording, alignment,
  truncation at narrow width.
- Update procedure: regenerate with `UPDATE_GOLDENS=1 npm test`, review the diff in the
  PR like any code change. The golden diff *is* the review surface for issues #9's relabel.
- Traceline gets a narrow golden: `oneLine()` output (ANSI stripped) for a table of
  synthetic comps (read with range, bash with `cd …`, MCP tool, error status, missing
  renderer fallback) and one three-block collapsed thinking run at width 80; this pins
  the row grammar without touching Pi's renderer. The stand-ins preserve causal runtime
  invariants: native renderer text derives
  from the same arguments, following tool rows have matching assistant `toolCall` blocks,
  and write results follow a pre-execution snapshot. The contract suite separately proves
  that the duck types match real Pi.
- Cachemire gets one combined golden (`tests/cachemire/goldens.test.ts` →
  `cachemire-lines.txt`): the `/cache` ledger panel over a cold/hit/partial/miss
  session plus every one-line `◍` surface (clock states, break notices, resolutions,
  and the turn summary), pinning wording, glyphs, and fact order (colour excluded as
  everywhere).
- Meantime gets one combined golden (`tests/meantime/goldens.test.ts` →
  `meantime-lines.txt`): every widget phase, both anomaly notices, and the `/pace`
  ledger with aligned columns, notes, totals and the active/idle share bar. A focused
  render test separately pins provider-qualified model transitions.

## Layer 4: startup smoke (tmux, local-only)

`npm run test:smoke` launches real `pi` processes in isolated tmux sessions with no
model call required:

- `test:smoke:traceline` resumes a crafted session with adjacent collapsed thinking
  blocks, standalone strong-emphasis summary paragraphs, and empty or whitespace-only
  fragments interleaved. It requires the whole run to render on exactly one preview row,
  with the newest fragment visible after width fitting, then proves Pi still handles
  `/quit`. A 45-second hard watchdog kills only the uniquely launched fixture process
  if rendering blocks, so the regression cannot leave a hot orphan behind.
- `test:smoke:click` exercises tool and reasoning clicks in fullscreen Pi through raw
  mouse input: independent expansion, tool aggregate reveal/refold, native collapse,
  Drill isolation, global toggles, resize and reload.
- The full startup smoke checks that the `[Contextimate]` block renders, that
  `/contextimate compact` and `expanded` change the rendered mode line, and that `/reload`
  keeps exactly one block. Its project config explicitly enables Meantime, proving the
  public opt-in path; it then proves `/cache` and `/pace` render through the real TUI and
  both remain in place across the Ctrl+T visibility update.
- Both exit non-zero on assertion failure so they can gate publishes. They do not run in
  CI because they need a TTY and an installed Pi. A "live turn" variant (real model, one
  bash call, assert a trace line appears and Ctrl+T restores native rows) stays a
  documented manual step in the publish checklist, not a script dependency on provider
  auth.

## Scoped render cache

Run `node --expose-gc scripts/dev/bench-trace-cache.ts` for isolated component timings
and deterministic capture-count checks. It makes no model calls. Timings are
observations, not CI thresholds or end-to-end TUI latency measurements.

## What "passing" means

`npm test` green on a machine with the current Pi installed means: our assumptions about
Pi still hold (layer 1), our logic still computes what it computed when last verified
against live providers (layer 2), and the views render what a human last approved
(layer 3). It does **not** mean live-provider token accuracy; that claim only comes from
the manual probes, and the docs/READMEs must keep saying so.
