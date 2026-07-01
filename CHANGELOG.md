# Changelog

## Unreleased

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
