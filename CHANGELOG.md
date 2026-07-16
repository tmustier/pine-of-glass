# Changelog

## 0.7.0 (unreleased)

New extension: `pi-meantime` (experimental, issue #26) answers "where did the
time go?" pi's footer counts elapsed time; meantime decomposes it, in the same
loop-economics voice as cachemire (`◍`) with wall-clock milliseconds as the
currency. Design language grows a family row, latency/rate number grammar, and
§10 (tempo facts: measurement honesty, segments, surfaces).

- Meantime is feature-flagged off by default while its experimental UX settles.
  Set `"enabled": true` in `pi-meantime.json` to opt in; otherwise its entrypoint
  registers no hooks, timer, widget, notices, or `/pace` command.
- A live tempo line above the editor names the current phase of the wait
  (`waiting`, `thinking`, `writing` with a `~tok/s` estimate from streamed
  chars, `tools` with wall-clock and a running count) and turns warning ink
  when the wait passes the session's slow-start bar. Hidden when idle: pi
  already counts time; the widget exists to decompose an active wait.
- Anomaly notices at call resolution, judged against the session's own rolling
  per-model medians (minimum samples plus an absolute floor keep short
  sessions silent): `slow start` names prefill as cause when uncached prompt
  tokens prove it and says `cause unknown` otherwise; `slow stream` reports a
  collapsed exact rate.
- `/pace` renders the tempo ledger: per-call ttft / think / write / tools /
  total / out / exact tok/s with row notes (slow start, silent reasoning,
  overlapped tools, harness stalls), a totals row, and a session line with an
  active-vs-idle `█▒` share bar.
- Honesty rules (design language §10.1): every duration is an event-boundary
  observation from this process; TTFT is one number on purpose (the
  network/queue/prefill split is not observable); resolved tok/s is exact
  provider usage over the observed stream span while live rates wear `~` and
  self-calibrate chars-per-token from resolved calls; silent-reasoning calls
  omit the rate when hidden generation has no observable start boundary; a
  silent pre-text gap is `waiting` until usage proves reasoning
  (`wait incl. silent reasoning`); parallel tools report the interval union
  with overlap noted, never a sum, and the live tool clock excludes harness gaps;
  the harness gap is only claimed when a next request bounded it; mixed-model
  ledgers mark transitions instead of labelling every row as the current model;
  restored sessions are not retro-timed.
- Shared plumbing: cachemire's durable-anchor chat-line machinery (append,
  clear-hook re-attachment, notify fallback) moves to `_lib/chatline.ts` and
  both extensions use it; `_lib/fmt.ts` gains `formatLatency` (one-decimal
  seconds under 10s, duration grammar above) and `formatRate`.
- `pi-traceline` now folds consecutive reads of sibling files (the same exact
  directory) into one row: the shared directory prints once, then the basenames
  follow with their line ranges, the call count and combined size on the right.
  A long file list wraps at file boundaries onto rail-only continuation lines
  instead of truncating basenames away. A file whose combined result reaches the
  warning size threshold keeps its own row (still folding its own pages) and
  splits the run, as an error row already did, so ballooned reads stay visible
  in the size column. Ctrl+T's expanded view still shows every individual call.
- Collapsed thinking previews flatten each adjacent thinking run to one line.
  Every non-empty fragment appends with a ` · ` separator, regardless of source
  newlines or Markdown paragraph boundaries. Width fitting middle-truncates the
  line so both its opening context and newest thought survive. The installed-Pi
  contracts track the one native label per adjacent thinking run introduced in
  Pi 0.80.8.
- Internal: the write pre-image snapshot and diff-stat parsing moved from
  `pi-traceline`'s `index.ts` into `write-diff.ts`; no behaviour change.

`pi-traceline` also adds drill mode: inspect one tool call without expanding
everything and without moving the transcript.

- Press `Alt+T` (configurable via `drillKey`, or run `/drill`) to number the
  visible tool rows in place. Each row's rail becomes its number at identical
  width, so nothing reflows; `1` is the most recent call and a folded read run
  is one number (a wrapped dir fold wears it on its bullet line). A two-line
  hint bar replaces the editor and restores your draft on exit.
- Type a number (or press `enter`) to open that call in a full-screen pager
  showing the trace lines, the complete invocation and the complete result.
  `j`/`k` scroll, `h`/`l` move between rows without closing, `esc` returns to
  the transcript exactly as you left it. The common case is two keys:
  `Alt+T`, then `1`.
- Press `p` to expand or collapse the selected row in place using Pi's native
  tool row. Expanded rows now also render natively outside drill mode, so
  Pi's `Ctrl+O` tool expansion works under traceline; an expanded row leaves
  read folds and shared columns and rejoins them when collapsed.
- Inside drill mode the mouse wheel moves the selection or scrolls the pager.
  Mouse reporting turns on only while the mode is open and always turns off on
  exit, so terminal text selection is never affected; `"drillMouse": false`
  opts out.

## 0.6.2 (2026-07-14)

- Fix a `pi-traceline` startup hang when a resumed session contains an empty or
  whitespace-only thinking block.
- `pi-traceline` now keeps every reasoning line visible in collapsed thinking
  previews instead of replacing multiline reasoning with a first-line summary
  and line count. A blank source line remains one blank display line, including
  the common two-newline paragraph boundary; longer blank runs collapse to one.

## 0.6.1 (2026-07-13)

`pi-traceline` now renders Pi's compact documentation and resource reads like
ordinary file reads.

- Paths use the same dim directory and neutral-bold filename grammar as other
  read rows, instead of colouring the whole path cyan.
- The useful `docs` or `resource` classification remains visible as dim
  apparatus, and line ranges keep their warning colour.

## 0.6.0 (2026-07-13)

`pi-traceline` now makes changed files and completed operations easier to scan.
This release also adds stricter checks for contributors and rewrites the
Traceline and Cachemire guides in plain English.

Changes include:

- edit and write rows now put `+N -M` next to the file name. They no longer show
  a result-size cell, because that measured the confirmation message rather than
  the changed file. Line counts and file names stay together when rows truncate.
- commands that prove they changed shared state now lead with the outcome, such
  as `pushed main $ git push`. The command remains visible so you can see what
  ran. These rows hide routine result sizes unless the output is unusually large.
- support for successful PR merges where `gh pr merge` produces no useful output
  but a same-row `gh pr view --json state` check returns `MERGED`. Traceline only
  records the merge when both commands name the same PR.
- an agent coding standard and deterministic lint checks. `npm run check` runs
  the linter, TypeScript checks and all tests. No existing lint findings are
  ignored.
- shorter Traceline and Cachemire READMEs, organised around common tasks. The
  Traceline screenshot now shows inline diffs and outcome-led records.

## 0.5.19 (2026-07-05)

`pi-traceline` reclaims the width that leading shell preambles used to spend.
Dimming a `set -euo pipefail ↵ cd <dir> ↵` preamble was only half the job: dim
ink still consumes the shared truncation budget (§9.8), so the real command was
middle-truncated behind boilerplate that carries no signal. Measured on a
script-heavy session, 82% of bash rows opened with a preamble eating a median of
61 columns (two-thirds of the row); the old `cd <dir> && ` fold fired on 1 of 49
rows because it missed `set`-first, `↵`-separated forms. Design language §9.4.

- A bash row's *leading preamble run* (`set -…` hygiene, `cd <dir>`, and bare
  `VAR=…`/`export` assignments, across `&&`, `;` and `↵` breaks) is now
  reclaimed, not just dimmed. A leading `set -…` run drops outright the way the
  `(timeout Ns)` suffix does; the remaining `cd`/assignment context folds to a
  dim `⋯` when it repeats the previous bash row's, whatever separator either row
  used to write it.
- The `⋯` now absorbs the whole run and its trailing separator (`⋯ npm test`,
  not `⋯ && npm test`); it still never points across visible prose, and never
  lands on a row with no real command after it (that row keeps its context, so no
  row goes dark). A distinct context prints once, on its first appearance.
- The narrow `cd <dir> && ` detector (`CD_PREAMBLE`/`repeatsPreviousCdPreamble`/
  `elideCdPreamble`) is replaced by a quote/substitution-aware segment splitter
  (`bashPreambleRun`/`foldBashPreamble`). Validated across the 51k-invocation
  bash corpus: zero exceptions, and the crown census is byte-identical (the crown
  grammar is untouched; 2.38 crowns/row holds). Goldens regenerated to gain a
  `set`-drop + newline-preamble-fold scene mirroring the reported case.

## 0.5.18 (2026-07-04)

Click-to-expand is removed from `pi-traceline`. It shipped behind careful
guards (one-shot arming, opt-in persistence) precisely because terminal mouse
reporting steals wheel/trackpad scroll, and in practice the feature never
became usable enough to justify carrying the machinery. Ctrl+T is the whole
expansion surface.

- Removed the `traceline-click` command, the `Ctrl+Shift+O` arm shortcut, the
  `PI_TRACELINE_CLICK` env opt-in, SGR mouse parsing, the one-shot state
  machine, per-row click expansion, and the container/TUI render wraps that
  existed only to build the row-to-tool hit map.
- The raw-input listener stays for Ctrl+T key-release/repeat consumption; the
  SGR foreground/background filtering tests move to
  `tests/traceline/sgr-filtering.test.ts` unchanged.
- No visible change to trace rows; the goldens are byte-identical.
- The `pi-traceline` and `pi-cachemire` READMEs are restructured to mirror
  `pi-contextimate`'s shape: pitch, screenshots, install, use, then depth.
  Cachemire's wire-level evidence (thinking-level cache keys, OpenAI replica
  arithmetic, lifecycle trade-offs) moves to `docs/pi-cachemire.md`, linked
  from the README the way contextimate links `docs/pi-contextimate.md`.

## 0.5.17 (2026-07-04)

The audit pass: `pi-traceline` sheds dead weight and stops re-deriving block
facts. No visible change; the goldens are byte-identical.

- Block-scoped facts (§12.15/§12.22) are computed once per rendered row and
  threaded through the suffix builders, and diff-text parsing caches per row
  against the text's identity. Deriving each fact independently walked the block
  again for every fact of every row, making a single row render O(block²) in
  diff parses.
- Removed the opt-in `toolBackgrounds` native-band path (config key, env var,
  and the `rowBackground`/`shadeRow` machinery): unbanded rows have been the
  design since §12, and git history keeps the slab.
- Removed the pre-0.80 resource-container fallback from the family's chat
  detection, and the settings.json disk fallback for reasoning visibility (a
  tool row always has an assistant sibling carrying the live state).
- Folded the duplicated row assembly (single rows and folded read runs) into one
  `fitTraceRow` helper, deduplicated the boolean-flag parser, collapsed the
  tool-row render patch to a single guard, and dropped provably dead members:
  the redundant `__tracelinePatched` global, a dead type field, and `internals`
  entries no test uses.
- docs/design-language.md rewritten from a layered amendment log into the
  current-state rules, in plain English: §1 to §7 keep their numbers, panels
  gather in §8, trace rows in §9, and an appendix maps the retired §12.x
  numbers (which this changelog's older entries still cite). All live code and
  test citations updated.

## 0.5.16 (2026-07-04)

Diff cells align like numbers, not like flags, in `pi-traceline` (design language
§12.27):

- §12.22's block-scoped diff columns padded on the right, so `+2` and `+20` shared
  their sign's x but not their place values: the units digit of a small count sat
  under the tens digit of a big one, and relative materiality stopped being
  readable at a glance. Cells now right-align within their sign column (units
  under units, the sign hugging its digits); what holds one x down the block is
  each column's right edge, the blank a dropped zero side keeps (§12.13), and the
  `·` separator. Materiality reads as width: a bigger count grows leftward into
  its column.
- Records of consequence wear the ink of what they state (§12.28): each record
  fact renders bold in its own tone, success for landed state, warning for a
  forced push, while opaque audit data (a commit sha) stays dim beside its verb.

## 0.5.15 (2026-07-04)

The corpus review: quote-aware sequencing and rationed crowns in `pi-traceline`
(design language §12.25/§12.26):

- §12.20's crown-every-head rule was measured against 51k real bash invocations
  from ~1,200 local sessions (new rig: `scripts/dev/bash-corpus/`) and the census
  was emphatic: `echo` was the third-most-bolded word yet almost never the point,
  `|| true` wore 4.8k crowns, `set -euo pipefail` opened 3.2k rows bold, the
  attached `;` (`sleep 60; ps …`, 23% of rows) never started a new command, and a
  `↵` inside a quoted inline script crowned `import`/`const`/`-H`.
- Sequencing now reads the shell, not the spacing (§12.25): a token-final unquoted
  `;` sequences like the space-delimited form; operators and `↵` inside an open
  quote are data; after a `↵`, flags render headless and block keywords (`do`,
  `fi`, …) pass the crown through; heredoc bodies additionally suspend quote
  tracking.
- The crown is rationed (§12.26): `cd`/`set` preambles and `echo`/`true`/`false`/
  `printf`/`exit` plumbing render headless whenever a real command in the row
  wears a crown (selection is row-global), while a row that is nothing but
  preamble/plumbing keeps its first operative head, so no row goes dark.
  Classification reads through parentheses (`(cd …`, `… || true)`).
- Measured effect: crowns drop 28% (3.30 → 2.38 per row) and the top-40 crowned
  words become a pure command census (`git`, `python3`, `rg`, `gh`, `tmux`, …)
  with `cd`, `echo`, `true`, `set`, `done`, `const`, `-H` gone from the ranks.
  Visible text is untouched: ink only, goldens unchanged.

## 0.5.14 (2026-07-04)

A self-evident toggle needs no caption in `pi-traceline` (design language §12.24):

- pi's Ctrl+T handler appends a dim `Thinking blocks: hidden/visible` status pair
  (Spacer + Text) to the chat tail, a holdover from when the toggle's only visible
  effect was each thinking block collapsing to a label. With traceline loaded the
  flip is unmistakable (every tool row collapses to a trace line or expands back),
  so the pair is dropped inside the requestRender that announces it, before it ever
  renders. Surgical: only that exact caption at the chat tail matches; every other
  showStatus message ("Forked to new session", …) passes through untouched.

## 0.5.13 (2026-07-02)

A head must carry a word character in `pi-traceline` (design language §12.23):

- §12.20's per-command head hunt crowned the closing quote of a flattened
  `-e`/`-c` script string: `↵ '` rendered a bold white quote. A candidate head
  with no letters or digits (a lone quote, `[`, `{`) is shell apparatus: it dims,
  the command renders headless, and the head slot is consumed so a following pipe
  filter cannot inherit the crown (`↵ ' | tail -2` stays entirely dim, §12.2).
  Deliberately conservative: under-brightening is the family's bias.

## 0.5.12 (2026-07-02)

Chain heads, a right margin, and diff-stat columns in `pi-traceline` (design
language §12.20/§12.21/§12.22):

- Every command head is bold: `&&`, `||`, space-delimited `;`, and flattened `↵`
  breaks each start a new command whose head word renders bold, so
  `cd X && printf 'HEAD ' ; git rev-parse HEAD` scans as three commands rather
  than one `cd` with baggage. Pipes and redirects continue a command (`| head -3`
  is a filter and stays dim, per §12.2), heredoc bodies are inert between `<<TAG`
  and its terminator line, and failed rows tint every head error.
- The right edge is a margin, not a wall: trace rows render into a 2-column right
  inset mirroring the left gutter, and the body-to-suffix gap floor rises to the
  two spaces §5 always specified (the implementation had drifted to one). Every
  truncated row in a block still ends flush at one shared cut column; that column
  now just breathes.
- Diff stats are a table, not a phrase: within a block the `+N`/`-M` cells form
  two sign-aligned columns; a dropped zero side (still dropped as ink) holds its
  column as blank space, and the size cell pads left to the block's widest, so a
  plus-only `+18` and a minus-only `-1` land under each other instead of both
  right-aligning into the `·`, and every `+`, `-`, and separator keeps one x down
  the block.
- The README screenshot story now also ships and verifies: a
  `git add && git commit && git push` row demonstrating record facts (§12.19) and
  chain heads, plus a multiline `node -e` row demonstrating the `↵` flatten with
  middle truncation; one frame now covers folded reads, size tints, dim pipes,
  the failed row, the diff-stat table, records, and the right margin.

## 0.5.11 (2026-07-02)

Record verbs render bold in `pi-traceline` (§12.19 amended):

- 0.5.10 rendered whole record cells dim, and the facts drowned in the very wall
  they were meant to punctuate. The verb (`committed`/`pushed`/`merged`/…) is now
  bold (the trace row's white), so it pops from the dim right edge the way a bash
  head command pops from its arguments. Data and separators stay at the supporting
  grey; the size cell keeps its severity ink. Neutral bold even on failed rows: the
  fact states porcelain that succeeded.

## 0.5.10 (2026-07-02)

Records of consequence in `pi-traceline` (design language §12.19):

- Bash rows that change shared state beyond the working tree (git commit/push,
  `gh pr merge`/`close`/`create`, `gh issue close`, `gh release create`,
  `npm publish`) add verb-first record facts to the suffix:
  `committed a4f21c9 · pushed main · 0.3k ch`, `merged PR #87 · 0.1k ch`.
- Output-only honesty: a fact appears only when the command names the operation
  *and* its success porcelain appears in the result (`[main a4f21c9]`,
  `1c75c2a..50cf33f main -> main`, `Merged pull request #87`,
  `/releases/tag/v0.5.9`, `+ pkg@0.5.10`). A failed push after a good commit shows
  `committed a4f21c9` on a red row: committed, demonstrably not landed. `git tag`
  earns nothing; its success porcelain is silence.
- Facts chain in output order with the family `·` separator; consecutive same-verb
  facts merge their data (`pushed main, v0.5.9`). Overflow drops whole facts oldest
  first (records take at most roughly a third of the row); the size cell keeps the
  rightmost aligned column.

## 0.5.9 (2026-07-02)

cwd collapses to `./` in `pi-traceline` path rows (design language §12.18):

- A path under the row's cwd renders as a dim `./` plus the cwd-relative tail,
  the shell's own notation for "here": two columns instead of thirty. Paths outside cwd
  keep their tildified absolute form; the asymmetry is itself information.
- Emphasis follows §12.16 with `./` counting like `~`: alone it is a trivial root
  marker (yet always boring), while `./src/` is a meaningful shared prefix; blocks
  diverging under one `src/` dim `./src/`, blocks diverging at the repo root brighten
  whole relative paths, and lone rows keep basename-only emphasis.

## 0.5.8 (2026-07-02)

Deterministic truncation columns for `pi-traceline` (design language §12.17):

- The cut is a column: middle truncation now cuts at exact positions; the tail is a
  fixed share of the budget and truncated lines fill it exactly. The content-dependent
  snapping (tail sliding to the nearest `/` or space, head snapping back up to eight
  columns) is gone; it made every row's ellipsis land somewhere different.
- Body budgets are block-scoped: every row in a rail-fused block reserves the block's
  widest fact suffix (folded read runs count as their single `N calls · size` cell), so
  ellipses and truncated tail edges align down the block. Rows that fit simply end
  early, like prose.
- Block boundaries now respect the rendered rail: a collapsed thinking preview renders
  with a blank line above it, so it starts a new block (it previously fused, which let a
  lone row above a `Thinking:` line inherit the block's budget and truncate needlessly).

## 0.5.7 (2026-07-02)

Block-scoped scannability for `pi-traceline` (design language §12.15–§12.16):

- The result-size fact floor is now block-scoped: if any row in a contiguous trace
  block clears 100 ch, every completed row in the block shows its size cell (dim
  `0.0k ch` included) so the right-edge column stays vertically aligned; an all-tiny
  cleanup block still shows nothing. Fixes the ragged edge where diff-only rows
  crashed into the `…k ch` column.
- Path emphasis dims the *boring prefix*, not the whole directory: the block's
  common directory prefix (≥2 segments) or the row's cwd prefix, whichever is
  longer. Divergent tails, directories included, render bold, so successive edits
  under one `src/` read as `pages/…` vs `components/…` at a glance. Lone rows and
  never-diverging blocks keep the classic basename-only emphasis.

## 0.5.6 (2026-07-02)

Full-sweep traceline polish (design language §12.12–§12.14):

- No plain ink in native rows: `grep`/`web_search`/`fetch_content`/`mcp` rows demote
  every span the native renderer left unstyled to the one dim supporting grey; pi's
  deliberate accents (patterns, ranges, backticks) and bold spans survive. §12.11's
  "no prose ink in a trace row" invariant now holds for every tool.
- A fact suffix must carry a fact: results under 100 ch render no `…k ch` suffix
  (goodbye `0.0k ch` on every `mkdir`), and diff stats drop their zero side
  (`+2 -0` → `+2`, `+0 -3` → `-3`).
- Errors tint the discriminators: failed rows render verb, bash head command, and
  basename in bold error ink: a failure is more than one red glyph in a dim wall.
  Healthy rows are untouched.

## 0.5.5 (2026-07-02)

- Bold is the trace row's white (design language §12.11): basenames and bash head
  command words in `pi-traceline` now render as the L0 discriminators §2 always
  assigned them: bold `text`, the same treatment as the verb, instead of the
  terminal default, which read identically to assistant prose. Plain prose-weight
  white no longer appears inside a trace row.

## 0.5.4 (2026-07-02)

- One supporting grey across `pi-traceline` rows (design language §12.9): the muted
  bash-body level dissolved. Bash rows now speak the path-row grammar: bold `$`
  anchor, the head command word bright like a basename (`$ rm`, `$ npm` scan like
  `read file.ts`, skipping env assignments and `⋯ &&` elisions), and everything else
  (arguments, connectors, redirects, fallback argument text) at the same dim grey as
  directories, plumbing, size suffixes, and the rail.
- `middleTruncate` now replays the net active SGR state after the ellipsis (design
  language §12.10), so a cut inside a styled span no longer strands the tail at the
  terminal default: the old "accepted quirk", fixed family-wide.

## 0.5.3 (2026-07-01)

- Nest `pi-traceline` trace blocks one 2-space gutter under the prose margin
  (design language §12.8): rows now render `  ▏ › body`, so the rail reads as a
  bracket around the group instead of a border flush against the terminal edge,
  and tool machinery indents beneath the narrative line that motivated it.

## 0.5.2 (2026-07-01)

- Fix the `pi-cachemire` cache clock after aborted sends: a request that ends without
  billed usage (fast abort or error) no longer keeps the TTL anchor it claimed at send
  time; the countdown rolls back to the last billed request instead of counting a
  fresh TTL from a request that may never have touched the cache (a first-send abort
  hides the clock outright). Mid-stream aborts keep their anchor: Anthropic's
  `message_start` usage confirms them.

## 0.5.1 (2026-07-01)

- End every `pi-contextimate` view with one blank spacer line so the panel no longer
  abuts the first user message (design language §12.5).
- Make the expanded tools view readable (design language §12.6–12.7): tool names render
  bold with a short dim `scope · path` provenance (builtins collapse to `builtin`;
  origin URL / package-ref / `top-level` decorations dropped), and parameter columns
  align across the whole tools block instead of per tool.

## 0.5.0 (2026-07-01)

- Differentiate `pi-traceline` trace rows from assistant prose (design language §12):
  every trace row opens with a dim `▏` rail so consecutive tool calls fuse into one
  visible block, verbs render neutral bold with status confined to the `›` bullet
  (only failed calls tint the verb red), and bash command bodies drop one ink level to
  muted with shell plumbing and `↵`/`⋯` marks a step dimmer, anchored by the bold `$`.
- Extend the dim-directory / bright-basename path emphasis from `read` rows to plain
  `edit` and `write` rows.
- Rebuild bash trace rows from the rendered plain text (dropping pi's native bash
  syntax styling in one-line mode) so the family ink hierarchy applies uniformly.

## 0.4.3 (2026-07-01)

- Fix `pi-traceline` / shared chat-container discovery for Pi 0.80's TUI layout, where loaded resources now render in a sibling `loadedResourcesContainer` before `chatContainer`.
- Update the Pi-internals contract test to pin the new fresh-session fallback seam.

## 0.4.2 (2026-06-26)

- In `pi-traceline`, show diff stats (`+N -M`) in collapsed rows for diff-backed `edit` calls.
- Add live pre-execution snapshots for `write` calls so collapsed rows show added/removed line counts for new files and rewrites.
- Document and test the file-mutation suffix grammar.

## 0.4.1 (2026-06-20)

- In `pi-traceline`, replace collapsed `Thinking...` placeholders with `Thinking: <first reasoning line>` previews.
- Render thinking previews through Markdown and strip formatting to plain text while preserving genuine literal punctuation.
- Add hidden reasoning line counts such as `... (2 lines)` and keep adjacent thinking labels coalesced.

## 0.4.0 (2026-06-18)

- Ship experimental `pi-cachemire` in the package alongside `pi-contextimate` and `pi-traceline`.
- Make `pi-traceline` rows unbanded by default, with the previous native tool-background slab available via `toolBackgrounds` config or `PI_TRACELINE_TOOL_BACKGROUNDS=1`.
- Preserve Pi's warning/yellow treatment for read `:line-range` metadata in single and folded read trace rows.
- Update docs and tests for the calmer traceline default and cachemire package inclusion.
