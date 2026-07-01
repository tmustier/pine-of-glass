# Changelog

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
