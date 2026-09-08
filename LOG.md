# Work log

## 2026-09-07: tool trace clicks

Added native per-call expansion and aggregate reveal/refold. Verified in fullscreen
Pi via isolated tmux, including selection, resize, global toggles, Drill and reload.
Lint, typecheck and all 127 Traceline tests passed. The full suite retained four
pre-existing Pi contract failures. Opened PR #108; retained the local test install.

## 2026-09-08: reasoning clicks and review cleanup

Moved reasoning previews into Pi's existing run-level mouse regions. Independent
expansion remains native; consecutive thinking blocks expand together. Removed the
obsolete string-replacement renderer and migrated its tests to real Pi components.
Simplified tool expansion, narrowed its fallback and removed redundant test setup.

Lint, typecheck and 134 focused tests passed. Full suite: 332 passed with the same
four baseline failures. Both fullscreen tmux click smokes passed, including Drill,
resize and reload. Reviewed 100/60-column terminal screenshots and a read-only code
review; no blocking findings. Updated PR #108 and the retained local test install.

## 2026-09-08: review follow-up

Simplified installation tracking and mouse-handler types; shared viewport/tmux
fixtures and corrected synthetic events, tool IDs and streaming lifecycles.
Visible reasoning now skips preview generation. Its regression test fails when
that optimisation is removed. Regenerated and visually checked the README image;
the screenshot rig now exits with Pi's supported `/quit` command.

Lint, typecheck, 135 focused tests and both fullscreen click smokes passed.
Full suite: 333 passed with the same four baseline failures.

## 2026-09-08: native-mode reasoning collapse

Reproduced the reported `Thinking...` label with the pre-PR renderer, then verified
that `/reload` into the current version fixes it in the same Pi process. No
production change was needed. Added component and fullscreen smoke coverage for
collapsing one reasoning run while other reasoning and tool output remain expanded.
Lint/typecheck passed; full suite: 334 passed with the same four baseline failures.

## 2026-09-08: integrate contributor PRs 104 and 105

Merged both contributor histories into an integration branch based on #108, retaining
all four original commits. Adapted #104 to native click regions and replaced its old
renderer timing test with deterministic Markdown parse-count coverage across
component rebuilds. Added a separate source-string cache fix with a same-length
replacement regression test, verified failing before the fix and passing after it.
Resolved #105 alongside the click fold-reset lifecycle without dropping either change.
Credited Alexandre Stahmer (@astahmer) and Ben Tang (@0xbentang) in the changelog and
prepared `docs/releases/next.md` for the next release. No package release requested.

Lint and typecheck pass. Main baseline: 334 pass, four contract failures; integrated:
339 pass, the same four failures. All real-Pi smoke suites pass. Reviewed compact and
narrow expanded reasoning screenshots; native clicks, grouping and rails remain
intact. Independent read-only review found no blocking findings. PR #106 remains
out of scope.

Fetched main again before landing and found #109 (Astra support). Merged it without
conflicts and reran the full check: 339 passed, the same four baseline failures.
Added its release-note entry without changing its implementation.

## 2026-09-08: scoped cache integration for PR 106

Reworked Alexey Bagno's (@swit33) proposal into dependency-scoped rendering, preserving
both author commits and keeping #112 separate. Added cache/transition tests and
`scripts/dev/bench-trace-cache.ts`. Initial validation: lint/typecheck passed;
355 tests passed with four baseline failures. An early Drill smoke comparison failed;
diagnostic and subsequent full smoke runs passed without weakening assertions.
#111 landed during validation and resolved the baseline failures on main.

## 2026-09-08: Pi compatibility and Cerebras retention

Required Pi 0.85.1 and removed Cachemire's obsolete provider-stream wrapper.
Native SSE contracts cover cached-token accounting, precedence (including zero),
totals and cost. Updated the bash renderer fixture and added real Pi thinking-toggle
and chat-rebuild lifecycle contracts, including both TUI modes and missing anchors.

Cerebras now has an explicit 5-minute minimum and 1-hour maximum for all models on
its supported route, activated only after a cache read. Clock, scheduling, switch-back
forecasts, classification and lineage checks preserve the unknown interval between
those bounds. Refreshed dated evidence, generated policy docs and clock goldens.

Validation: lint, typecheck and all 335 tests passed, with no baseline failures.
The full real-Pi tmux smoke suite passed without model calls. Reviewed captured
production widgets at both boundaries and the bounded ledger label. The existing
fixed-width ledger still wraps at 60 columns; its table layout is unchanged.

Rebased onto main's Astra support and contributor integrations (#109 and #110).
Reran the full check: all 340 tests passed, followed by the complete real-Pi smoke
suite. No baseline failures remain.

## 2026-09-08: PR 111 review cleanup

Removed redundant renderer scaffolding and source assertions from the native toggle
contract. Reused `pastWindow` for switch-back expiry decisions and expressed the
accounting fixture's expected cost as arithmetic. No new helpers or output changes.
Lint, typecheck, all 340 tests and the full real-Pi smoke suite passed; goldens unchanged.

## 2026-09-08: final scoped-cache validation on current main

Integrated #111; lint, typecheck, all 357 tests and all real-Pi smoke suites passed.
Reviewed tool/reasoning screenshots. Fixed Pi's direct streaming-message insertion
with predecessor-link tokens after reproducing its cache regression. Opened draft #113;
no PR comments, #112 integration or session activation.

## 2026-09-08: simplify scoped-cache review

Removed cache aliases, single-use wrappers, two module splits and repeated prose.
Corrected same-object and lifecycle fixtures; removed overlapping tests. Disabling
tool/container invalidation makes the relevant regressions fail. Lint, typecheck,
355 tests and the final full smoke run pass. The earlier Drill comparison flake
recurred once; three follow-up runs on each of pre-review and simplified code passed.
Improved its failure diagnostic without changing assertions. Final component timings:
500 rows warm 0.183 ms, active update 0.253 ms; one 200-row group active update
1.516 ms. These are synthetic component measurements; the live-session soak remains open.

## 2026-09-08: remove redundant cache documentation

Removed the standalone design note and duplicate design-language section. Benchmark
instructions stay in `docs/testing.md`; measurements stay in this log. Reviewed the
test boundaries; no test or runtime changes in this pass.

## 2026-09-08: share fold rules and tighten cache contracts

Cached and uncached rendering now share fold planners. Removed the duplicate test
matrix and forced-miss checks; repaired resize, prose, step-isolation and Drill
assertions. Six deliberate mutations failed their targeted tests, including existing
fold grammar tests. Lint, typecheck, all 355 tests and all real-Pi smokes pass.
Component benchmark: 500 rows warm 0.193 ms, active 0.276 ms; giant-group active
1.530 ms. Live-session soak remains outstanding.

## 2026-09-08: v0.11.0 release and live CPU soak

Live soak on real Pi 0.85.1 with `openai-codex/gpt-5.6-sol:low`, Traceline only,
isolated HOME, same prompt (60 sequential reads then 15 bash calls), CPU sampled
every 0.5 s on the pi process:

| | v0.10.2 | main (5e572a2) |
|---|---|---|
| tool rows streamed | 76 (turn finished, 342 s) | 123 (stopped at 600 s, model looping) |
| total CPU time | 17.3 s | 6.9 s |
| CPU per row | ~0.23 s | ~0.06 s |
| mean / peak CPU | 4.8% / 39.7% | 0.9% / 8.8% |
| RSS | 190 MB | 152 MB |
| idle after turn | 0% | 0% |

Rendered folds, ranges and size columns looked correct in both captures. Released
v0.11.0 from main after the soak.
