# Next release notes (draft)

These notes are prepared for the next release after v0.10.2. No version or
publication date has been assigned.

## Traceline

- Click tool traces and reasoning runs to expand or collapse them in fullscreen Pi.
  Native reasoning clicks remain independent, and folded tool groups can be revealed
  and refolded. Includes selection, resize, Drill and reload support.
  [#108](https://github.com/tmustier/pine-of-glass/pull/108).
- Reuse thinking previews when Pi rebuilds components, avoiding repeated Markdown
  parsing of unchanged reasoning. Thanks to Alexandre Stahmer
  ([@astahmer](https://github.com/astahmer)) for
  [#104](https://github.com/tmustier/pine-of-glass/pull/104).
  Integration retains the new click behaviour and handles final reasoning text
  replacements even when the text length stays the same.
- Keep the parent pane's Traceline UI and Ctrl+T listener intact when a headless
  subagent starts or stops in the same process. Thanks to Ben Tang
  ([@0xbentang](https://github.com/0xbentang)) for
  [#105](https://github.com/tmustier/pine-of-glass/pull/105).

- Cache tool rows and shared layout work during streaming. Based on Alexey Bagno's
  ([@swit33](https://github.com/swit33))
  [#106](https://github.com/tmustier/pine-of-glass/pull/106).

All three contributors' original commits are preserved through merge commits.

## Cachemire

- Recognise GPT-6 Astra's documented 30-minute cache minimum on direct OpenAI
  Responses and Codex routes after a reported cache read or write. Other routes
  remain unknown. [#109](https://github.com/tmustier/pine-of-glass/pull/109).

## Maintainer validation

The scoped cache remains in draft pending a live-session soak.
See [the work log](../../LOG.md) for check results.
PR #112 is not included.
