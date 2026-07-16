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
  runtime, so a `pi update` followed by `npm test` is the drift detector.
- **Testability route:** pure domain logic lives in importable modules or an exported
  `internals` object consumed by tests. Pi imports only each extension's default entry
  point, so named test surfaces are runtime-inert. Split files by domain when the code
  needs it, as cachemire's renderer and meantime's timing/render modules do.
- **Scripts:** `npm run lint` (agent coding-standard source checks),
  `npm run typecheck`, `npm test` (unit + render + contract),
  `npm run check` (lint + typecheck + tests), and `npm run test:smoke`
  (tmux startup smoke, local-only).

Layout:

```
tests/
  contract/pi-internals.test.ts      # layer 1: drift
  contextimate/*.test.ts             # layer 2/3
  traceline/*.test.ts                # layer 2
  cachemire/*.test.ts                # layer 2/3
  meantime/*.test.ts                 # layer 2/3
  fixtures/                          # frozen system prompts, tool schemas, goldens
scripts/dev/link-pi-runtime.sh
```

## Layer 1: contract tests against the installed Pi (drift)

`tests/contract/pi-internals.test.ts` imports the real installed Pi and asserts every
structural assumption the extensions make. Each assertion names the extension code that
depends on it. When `pi update` breaks one, the failure message says exactly which seam
moved.

| Assumption | Depended on by |
|---|---|
| `buildSessionContext`, `convertToLlm`, `keyText` are exported with compatible shapes (callable; `convertToLlm` yields messages with `role`, `content`; thinking blocks expose `thinking`/`thinkingSignature`; toolCall blocks expose `id`/`name`/`arguments`) | contextimate `buildSessionBreakdown` |
| A real Pi-built system prompt (constructed via Pi's own prompt assembly against a fixture project dir with an AGENTS.md and one skill) matches `PROJECT_INSTRUCTIONS_RE`, `AVAILABLE_SKILLS_RE`, `SKILL_RE`, and `getPromptRemainder` strips both blocks | contextimate section parsing; it silently renders wrong buckets if the prompt format drifts |
| `[Context]`/`[Skills]`/… resource headers still render in the startup transcript shape matched by `RESOURCE_HEADER_RE` | contextimate block insertion point |
| `ToolExecutionComponent` (or successor) instances satisfy `isToolRow`: `render`, `setExpanded`, `toolName` in instance; prototype is patchable | traceline prototype patch |
| Assistant message component satisfies `isAssistantRow`: `setHideThinkingBlock` fn + `hideThinkingBlock` boolean | traceline collapse-state source of truth |
| A collapsed `AssistantMessageComponent` skips empty thinking blocks, emits one label per non-empty block, and keeps native spacers across tool and text boundaries | traceline grouped thinking previews |
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
- **Collapsed thinking previews**: three adjacent non-empty blocks form one tight
  multiline run; empty thinking fragments do not consume labels or break adjacency;
  text, tools and other semantic content do; single-block rendering, fallback labels,
  OSC marks, paragraph breaks and width bounds remain unchanged.

### contextimate

- **Heuristic resolution precedence** (`resolveHeuristic`): fallback < default profile <
  flat defaults < built-in model rule < config rules in order, later rules override
  earlier. `parseContextimateConfig` drops non-positive JSON denominators before
  resolution; `cleanDenominator` remains the defensive pure boundary for direct patches.
  This is user-configurable surface; precedence bugs misprice every row.
- **Built-in rule matching**: boundary table: `claude-opus-4-8` → 4.7+ rule;
  `claude-sonnet-4-5` → 4.5/4.6 rule; other anthropic → generic; `openai-codex` vs
  `openai` vs `mistral` vs `gemini` vs `bedrock` routing by provider/api.
- **Tool payload shaping**: for one frozen `ToolSummary` fixture, the exact JSON emitted
  per shape (`anthropic`, `openai-responses`, `openai-chat`, `bedrock`, `raw-schema`),
  the *aggregated* gemini `functionDeclarations` form, and the unknown-shape fallback to
  the OpenAI Responses payload.
  Consistency invariant: `buildToolDisplayEstimate` counts the same payload shape that
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
  `"pi"`, `other = total − tools − messages` clamped ≥ 0; without → heuristic fallback;
  thinking chars counted from `thinkingSignature` when present else `thinking` text.
- **Token label alignment** (`tokenLabelLayout`/`estimatedTokenField`/`exactTokenLabel`):
  for value sets spanning <1k/≥1k/≥100k, all emitted fields share one visible width and
  `~`/exact variants align; this is the invariant behind the recent column-alignment commits.
- **Snapshot signature**: identical inputs → identical signature; changing the active tool
  set, model, config, or session chars each changes it (render-cache invalidation).

### meantime

- **Segment and resolution arithmetic**: the bare stream start does not set TTFT;
  thinking, text and tool-argument events open the right spans; silent reasoning omits
  a resolved rate because its generation start is not observable.
- **Tool interval union**: parallel intervals count once, harness gaps do not count as
  live or resolved tool time, and harness duration is only attached when a next request
  supplies an end boundary.
- **Per-model baselines and calibration**: medians filter on provider-qualified model
  identity, need the configured sample floor, and exclude silent-reasoning calls from
  live-rate calibration.
- **Session totals and config parsing**: open idle time contributes to idle, active is
  the watched span minus idle, and malformed boundary values are ignored.

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

- `test:smoke:traceline` resumes a crafted session with three adjacent collapsed
  thinking blocks and empty or whitespace-only fragments interleaved. It requires all
  three preview rows to render consecutively, then proves Pi still handles `/quit`. A
  45-second hard watchdog
  kills only the uniquely launched fixture process if rendering blocks, so the regression
  cannot leave a hot orphan behind.
- The full startup smoke checks that the `[Contextimate]` block renders, that
  `/contextimate compact` and `expanded` change the rendered mode line, and that `/reload`
  keeps exactly one block. It also proves `/cache` and `/pace` render through the real TUI
  and both survive the Ctrl+T chat rebuild.
- Both exit non-zero on assertion failure so they can gate publishes. They do not run in
  CI because they need a TTY and an installed Pi. A "live turn" variant (real model, one
  bash call, assert a trace line appears and Ctrl+T restores native rows) stays a
  documented manual step in the publish checklist, not a script dependency on provider
  auth.

## Acceptance tests for the queued work

Designed now so the features land with their proofs:

- **#9 (system-prompt row clarity):** golden diff shows the renamed row + method caveat
  in all three views; unit test that the section id stays `"system"` (config/signature
  compat) while the title changes.
- **#8 (provider token check):** the checker is a script (`scripts/contextimate/
  check-provider-tokens.mjs`) whose *request-building* is pure and unit-tested: given the
  snapshot fixture, the exact Anthropic `count_tokens` body and OpenAI Responses body it
  would send, asserting the counted payload equals the displayed payload (shared shaping
  code, not a re-implementation). Network execution is manual; tests never call providers.
- **#7 (click UX decision):** resolved by removal; click-to-expand shipped, proved
  unusable in practice, and was deleted (v0.5.18). Ctrl+T is the whole surface.

## What "passing" means

`npm test` green on a machine with the current Pi installed means: our assumptions about
Pi still hold (layer 1), our logic still computes what it computed when last verified
against live providers (layer 2), and the views render what a human last approved
(layer 3). It does **not** mean live-provider token accuracy; that claim only comes from
the manual probes, and the docs/READMEs must keep saying so.
