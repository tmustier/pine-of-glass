# Changelog

## 0.5.14 — 2026-07-04

A self-evident toggle needs no caption in `pi-traceline` (design language §12.24):

- pi's Ctrl+T handler appends a dim `Thinking blocks: hidden/visible` status pair
  (Spacer + Text) to the chat tail — a holdover from when the toggle's only visible
  effect was each thinking block collapsing to a label. With traceline loaded the
  flip is unmistakable (every tool row collapses to a trace line or expands back),
  so the pair is dropped inside the requestRender that announces it, before it ever
  renders. Surgical: only that exact caption at the chat tail matches; every other
  showStatus message ("Forked to new session", …) passes through untouched.

## 0.5.13 — 2026-07-02

A head must carry a word character in `pi-traceline` (design language §12.23):

- §12.20's per-command head hunt crowned the closing quote of a flattened
  `-e`/`-c` script string — `↵ '` rendered a bold white quote. A candidate head
  with no letters or digits (a lone quote, `[`, `{`) is shell apparatus: it dims,
  the command renders headless, and the head slot is consumed so a following pipe
  filter cannot inherit the crown (`↵ ' | tail -2` stays entirely dim, §12.2).
  Deliberately conservative — under-brightening is the family's bias.

## 0.5.12 — 2026-07-02

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
  two sign-aligned columns — a dropped zero side (still dropped as ink) holds its
  column as blank space, and the size cell pads left to the block's widest — so a
  plus-only `+18` and a minus-only `-1` land under each other instead of both
  right-aligning into the `·`, and every `+`, `-`, and separator keeps one x down
  the block.
- The README screenshot story now also ships and verifies: a
  `git add && git commit && git push` row demonstrating record facts (§12.19) and
  chain heads, plus a multiline `node -e` row demonstrating the `↵` flatten with
  middle truncation — one frame now covers folded reads, size tints, dim pipes,
  the failed row, the diff-stat table, records, and the right margin.

## 0.5.11 — 2026-07-02

Record verbs render bold in `pi-traceline` (§12.19 amended):

- 0.5.10 rendered whole record cells dim, and the facts drowned in the very wall
  they were meant to punctuate. The verb (`committed`/`pushed`/`merged`/…) is now
  bold — the trace row's white — so it pops from the dim right edge the way a bash
  head command pops from its arguments. Data and separators stay at the supporting
  grey; the size cell keeps its severity ink. Neutral bold even on failed rows: the
  fact states porcelain that succeeded.

## 0.5.10 — 2026-07-02

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

## 0.5.9 — 2026-07-02

cwd collapses to `./` in `pi-traceline` path rows (design language §12.18):

- A path under the row's cwd renders as a dim `./` plus the cwd-relative tail — the
  shell's own notation for "here", two columns instead of thirty. Paths outside cwd
  keep their tildified absolute form; the asymmetry is itself information.
- Emphasis follows §12.16 with `./` counting like `~`: alone it is a trivial root
  marker (yet always boring), while `./src/` is a meaningful shared prefix — blocks
  diverging under one `src/` dim `./src/`, blocks diverging at the repo root brighten
  whole relative paths, and lone rows keep basename-only emphasis.

## 0.5.8 — 2026-07-02

Deterministic truncation columns for `pi-traceline` (design language §12.17):

- The cut is a column: middle truncation now cuts at exact positions — the tail is a
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

## 0.5.7 — 2026-07-02

Block-scoped scannability for `pi-traceline` (design language §12.15–§12.16):

- The result-size fact floor is now block-scoped: if any row in a contiguous trace
  block clears 100 ch, every completed row in the block shows its size cell (dim
  `0.0k ch` included) so the right-edge column stays vertically aligned; an all-tiny
  cleanup block still shows nothing. Fixes the ragged edge where diff-only rows
  crashed into the `…k ch` column.
- Path emphasis dims the *boring prefix*, not the whole directory: the block's
  common directory prefix (≥2 segments) or the row's cwd prefix, whichever is
  longer. Divergent tails — directories included — render bold, so successive edits
  under one `src/` read as `pages/…` vs `components/…` at a glance. Lone rows and
  never-diverging blocks keep the classic basename-only emphasis.

## 0.5.6 — 2026-07-02

Full-sweep traceline polish (design language §12.12–§12.14):

- No plain ink in native rows: `grep`/`web_search`/`fetch_content`/`mcp` rows demote
  every span the native renderer left unstyled to the one dim supporting grey; pi's
  deliberate accents (patterns, ranges, backticks) and bold spans survive. §12.11's
  "no prose ink in a trace row" invariant now holds for every tool.
- A fact suffix must carry a fact: results under 100 ch render no `…k ch` suffix
  (goodbye `0.0k ch` on every `mkdir`), and diff stats drop their zero side
  (`+2 -0` → `+2`, `+0 -3` → `-3`).
- Errors tint the discriminators: failed rows render verb, bash head command, and
  basename in bold error ink — a failure is more than one red glyph in a dim wall.
  Healthy rows are untouched.

## 0.5.5 — 2026-07-02

- Bold is the trace row's white (design language §12.11): basenames and bash head
  command words in `pi-traceline` now render as the L0 discriminators §2 always
  assigned them — bold `text`, the same treatment as the verb — instead of the
  terminal default, which read identically to assistant prose. Plain prose-weight
  white no longer appears inside a trace row.

## 0.5.4 — 2026-07-02

- One supporting grey across `pi-traceline` rows (design language §12.9): the muted
  bash-body level dissolved. Bash rows now speak the path-row grammar — bold `$`
  anchor, the head command word bright like a basename (`$ rm`, `$ npm` scan like
  `read file.ts`, skipping env assignments and `⋯ &&` elisions), and everything else
  (arguments, connectors, redirects, fallback argument text) at the same dim grey as
  directories, plumbing, size suffixes, and the rail.
- `middleTruncate` now replays the net active SGR state after the ellipsis (design
  language §12.10), so a cut inside a styled span no longer strands the tail at the
  terminal default — the old "accepted quirk", fixed family-wide.

## 0.5.3 — 2026-07-01

- Nest `pi-traceline` trace blocks one 2-space gutter under the prose margin
  (design language §12.8): rows now render `  ▏ › body`, so the rail reads as a
  bracket around the group instead of a border flush against the terminal edge,
  and tool machinery indents beneath the narrative line that motivated it.

## 0.5.2 — 2026-07-01

- Fix the `pi-cachemire` cache clock after aborted sends: a request that ends without
  billed usage (fast abort or error) no longer keeps the TTL anchor it claimed at send
  time — the countdown rolls back to the last billed request instead of counting a
  fresh TTL from a request that may never have touched the cache (a first-send abort
  hides the clock outright). Mid-stream aborts keep their anchor: Anthropic's
  `message_start` usage confirms them.

## 0.5.1 — 2026-07-01

- End every `pi-contextimate` view with one blank spacer line so the panel no longer
  abuts the first user message (design language §12.5).
- Make the expanded tools view readable (design language §12.6–12.7): tool names render
  bold with a short dim `scope · path` provenance (builtins collapse to `builtin`;
  origin URL / package-ref / `top-level` decorations dropped), and parameter columns
  align across the whole tools block instead of per tool.

## 0.5.0 — 2026-07-01

- Differentiate `pi-traceline` trace rows from assistant prose (design language §12):
  every trace row opens with a dim `▏` rail so consecutive tool calls fuse into one
  visible block, verbs render neutral bold with status confined to the `›` bullet
  (only failed calls tint the verb red), and bash command bodies drop one ink level to
  muted with shell plumbing and `↵`/`⋯` marks a step dimmer, anchored by the bold `$`.
- Extend the dim-directory / bright-basename path emphasis from `read` rows to plain
  `edit` and `write` rows.
- Rebuild bash trace rows from the rendered plain text (dropping pi's native bash
  syntax styling in one-line mode) so the family ink hierarchy applies uniformly.

## 0.4.3 — 2026-07-01

- Fix `pi-traceline` / shared chat-container discovery for Pi 0.80's TUI layout, where loaded resources now render in a sibling `loadedResourcesContainer` before `chatContainer`.
- Update the Pi-internals contract test to pin the new fresh-session fallback seam.

## 0.4.2 — 2026-06-26

- In `pi-traceline`, show diff stats (`+N -M`) in collapsed rows for diff-backed `edit` calls.
- Add live pre-execution snapshots for `write` calls so collapsed rows show added/removed line counts for new files and rewrites.
- Document and test the file-mutation suffix grammar.

## 0.4.1 — 2026-06-20

- In `pi-traceline`, replace collapsed `Thinking...` placeholders with `Thinking: <first reasoning line>` previews.
- Render thinking previews through Markdown and strip formatting to plain text while preserving genuine literal punctuation.
- Add hidden reasoning line counts such as `... (2 lines)` and keep adjacent thinking labels coalesced.

## 0.4.0 — 2026-06-18

- Ship experimental `pi-cachemire` in the package alongside `pi-contextimate` and `pi-traceline`.
- Make `pi-traceline` rows unbanded by default, with the previous native tool-background slab available via `toolBackgrounds` config or `PI_TRACELINE_TOOL_BACKGROUNDS=1`.
- Preserve Pi's warning/yellow treatment for read `:line-range` metadata in single and folded read trace rows.
- Update docs and tests for the calmer traceline default and cachemire package inclusion.
