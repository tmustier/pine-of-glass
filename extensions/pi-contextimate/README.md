# pi-contextimate

`pi-contextimate` is a Pi extension that adds a startup `[Context Estimator]` panel showing what is filling the current model context window: system prompt, AGENTS.md files, Agent Skills, active tools, and current session material.

## Install

Install from npm:

```bash
pi install npm:pi-contextimate
```

Try it for one run without installing:

```bash
pi -e npm:pi-contextimate
```

For local development from a clone:

```bash
pi -e ./extensions/pi-contextimate
```

The package manifest points Pi at this extension directory as part of the `pine-of-glass` collection, so future internal splits into multiple files can keep the same install path.

## Use

- `[Context Estimator]` renders after Pi's native startup resource sections, leaving Pi's default `[Context]`, `[Skills]`, `[Prompts]`, and `[Extensions]` order untouched.
- `Ctrl+O` cycles the `[Context Estimator]` view through Pi's native expand/collapse path: summary → compact → expanded.
- `Ctrl+T` toggles Pi's thinking-block visibility and rebuilds the chat transcript; the estimator watches for that rebuild and re-inserts itself if Pi drops the startup block.
- `/contextimate` cycles the view.
- `/contextimate summary`, `/contextimate compact`, and `/contextimate expanded` jump directly to a mode.
- Compact is a scan view: one aligned line per skill and per tool (name · estimated tokens · short description), sorted by estimated tokens, with the counting method shown once on the category header.
- Expanded adds the deep detail: per-section method/caveats and sources, plus a readable schema field tree for each active tool (name · type · required · description, with nested array/object fields indented), sorted by estimated tokens. Token counts are still computed on the minified provider-shaped payload; the tree is just the legible view of it. Paths and URLs are shown as text rather than terminal hyperlinks, because OSC-8 file links are unreliable in this startup-component surface. (System prompt and context files stay summarized.)
- Each tool's right-aligned source line is Pi's `SourceInfo`, read as `scope · source · origin · path`: **scope** is `user` / `project` / `temporary` (builtins are temporary), **source** is the loader/package label (`auto`, `builtin`, `npm:<pkg>`), **origin** is `package` vs `top-level`, and **path** is the defining file (or a synthetic id like `<builtin:edit>`), home-shortened to `~/…` and middle-truncated to stay on one line.

## Docs

Full notes, accounting heuristics, experiment results, and validation-script instructions live in the package docs:

- `docs/pi-contextimate.md`
- `docs/pi-contextimate-codex-context-accounting.md`

Packaged diagnostics:

- `pi-contextimate-probe-prefix` — run a tiny live prefix probe and print sanitized payload-size/usage summaries.
- `pi-contextimate-evaluate-transcripts` — evaluate local Pi JSONL session-growth heuristics against recorded usage.
