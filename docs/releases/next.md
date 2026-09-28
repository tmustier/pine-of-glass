# Next release notes (draft)

- Traceline no longer freezes Pi for seconds whenever the transcript refreshes. Each
  tool row's one-line invocation borrowed Pi's native call rendering at 10,000 columns,
  and Pi pads and re-measures every line to that width, so startup, resume, `/clone`,
  Ctrl+O and theme or cell-size refreshes cost O(10,000 x call lines). Captures now run
  at 256 then 1,024 columns, each verified by a wider check render, and fall back to the
  old width only when no bounded pair can prove the result. Rendered output is unchanged.
- Collapsed thinking previews reuse their truncated label while the native label and
  width hold. Fullscreen Pi renders the whole transcript every frame, so every keystroke,
  scroll step and streaming delta used to re-truncate every preview in the session.
- `middleTruncate` finds its tail cut by walking back from the end of the line instead of
  segmenting the whole line up to it.
- On a resumed 1.9 MB session (321 calls, 315 thinking blocks), CPU before -> after with
  Pi alone in brackets: startup 21.6 s -> 5.3 s (3.2 s); a whole-transcript refresh
  18.8 s -> 2.4 s (1.2 s); 20 keystrokes 0.88 s -> 0.37 s (0.44 s). Details in `LOG.md`.
- Thanks to Stepan Mazurov ([@smazurov](https://github.com/smazurov)) for the Traceline
  changes above, [#129](https://github.com/tmustier/pine-of-glass/pull/129).
- Contextimate no longer searches the whole transcript on every redraw when its panel has
  nowhere to attach, for example with `quietStartup`. On a resumed 336-call session this
  kept a CPU core busy indefinitely; Pi now uses the same CPU as it does without
  Contextimate. The search skips the transcript, reuses the container once found, and only
  session start and `/contextimate` search before the panel first attaches. Reported by
  Nico Bailon ([@nicobailon](https://github.com/nicobailon)) in
  [#122](https://github.com/tmustier/pine-of-glass/issues/122).
- Contextimate counts the prompt the latest run sent. Extensions can change the prompt just
  before each run (for example `pi-skill-gate` hiding skills), but Pi reverts to the
  unchanged prompt once the run ends, so the panel had counted every skill, including
  hidden ones. It also reads a skill index an extension has moved out of Pi's `<skills>`
  section. Reported by [@punk-dev-robot](https://github.com/punk-dev-robot) in
  [#56](https://github.com/tmustier/pine-of-glass/issues/56).
