# pi-contextimate

`pi-contextimate` is a Pi extension that adds a startup `[Context Estimator]` panel showing what is filling the current model context window: system prompt, AGENTS.md files, skill frontmatter (the always-loaded skill index, not the skill bodies), active tools, and current session material.

## Install

Install from npm:

```bash
pi install npm:pine-of-glass
```

Try it for one run without installing:

```bash
pi -e npm:pine-of-glass
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
- Compact is a scan view: one aligned line per skill and per tool (name · estimated tokens · short description), sorted by estimated tokens, with the counting method shown once on the category header. Loaded-but-inactive tools are shown as dim rows with `-` for tokens and `(inactive)` at the start of the description.
- Expanded adds the deep detail: per-section method/caveats and sources, plus a readable schema field tree for each active tool (name · type · required · description, with nested array/object fields indented), sorted by estimated tokens. Token counts are still computed on the minified provider-shaped payload; the tree is just the legible view of it. Paths and URLs are shown as text rather than terminal hyperlinks, because OSC-8 file links are unreliable in this startup-component surface. (Runtime system prompt and context files stay summarized.)
- The first row is `Runtime system prompt` rather than "System prompt" because Pi assembles that prompt at runtime from its base prompt plus tool/extension contributions (the `Available tools` snippet lines and tool `promptGuidelines`). In expanded view the row attributes the part it can verify — `of which tool/extension instructions: ~Nk tokens (…)` — counted by matching each loaded tool's snippet line and deduplicated guidelines against the actual prompt text, so the `Tools` row is not mistaken for a tool's complete context footprint. The attribution is informational; those tokens are already included in the row's count.
- Each expanded tool header includes the tool name followed by Pi's `SourceInfo`, read as `scope · source · origin · path`: **scope** is `user` / `project` / `temporary` (builtins are temporary), **source** is the loader/package label (`auto`, `builtin`, `npm:<pkg>`), **origin** is `package` vs `top-level`, and **path** is the defining file (or a synthetic id like `<builtin:edit>`), home-shortened to `~/…` and middle-truncated to stay on one line; the token estimate stays right-aligned.

## Docs

Full notes, accounting heuristics, experiment results, and validation-script instructions live in the package docs:

- `docs/pi-contextimate.md`
- `docs/pi-contextimate-codex-context-accounting.md`

Packaged diagnostics:

- `pi-contextimate-probe-prefix` — run a tiny live prefix probe and print sanitized payload-size/usage summaries.
- `pi-contextimate-evaluate-transcripts` — evaluate local Pi JSONL session-growth heuristics against recorded usage.
