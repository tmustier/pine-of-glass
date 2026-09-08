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

Reworked Alexey Bagno's (@swit33) render memoization proposal while preserving both
original commits in the local merge history. Added dependency-linked row facts,
shared block/step plans, topology indexing and fitted-line reuse. Cached click
geometry and membership travel with the exact output variant. Mutation hooks cover
same-object updates, native renderer invalidation, semantic assistant shape changes,
container replacement and reload. No #112 call-summary changes are included.

Added 16 deterministic cache/transition tests and a real-component benchmark with
isolated processes. On the 500-row fixture, warm rendering measured 0.202 ms median
and an active update 0.325 ms; only the active five-row group was reconsidered, with
one native call recapture. The single 200-row group measured 2.349 ms per active
update after retaining unchanged fitted lines. These are synthetic component costs,
not end-to-end TUI frame claims; detailed methodology and limits are in
`docs/traceline-cache-design.md`.

Lint/typecheck and all smoke suites passed on the initial integration base; full
suite: 355 passed with the same four baseline failures. One early Drill smoke run
failed its restored-row comparison; a diagnostic rerun and subsequent full smoke
runs passed. No smoke assertions were weakened. Independent final review found no
blocking regressions. #111 landed during final validation; clean latest main now
passes all 340 tests, so refresh the integration before considering a merge.

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

Integrated #111 without changing its runtime work. Clean main passes 340 tests;
this branch now passes lint, typecheck, all 357 tests and every real-Pi smoke suite.
Reviewed revealed tool rows plus compact and narrow expanded reasoning screenshots.
No intended output changes, no PR comments and no #112 integration.

A final source check found Pi's direct insertion before its streaming component,
which disproved an append-only assumption in the advisory review. Added a failing
cached-versus-raw regression, then fixed it with stable predecessor-link tokens in
the topology index. The test passes after the fix. Final benchmark: 500 rows warm
0.159 ms, active update 0.295 ms; one 200-row group active update 2.162 ms (p95
3.249 ms). One native invocation recapture per tool update in every fixture. Results
and limits are recorded in `docs/traceline-cache-design.md`; a live-session soak is
still recommended before merging. Original #106 author commits remain preserved.
