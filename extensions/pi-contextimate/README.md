# pi-contextimate

`pi-contextimate` is a Pi extension that adds a startup `[Contextimate]` panel showing what is filling the current model context window: system prompt, AGENTS.md files, skill frontmatter (the always-loaded skill index, not the skill bodies), active tools, and current session material.

![Contextimate summary panel at startup](../../docs/img/pi-contextimate-summary.png)

`ctrl+o` cycles two deeper views. Compact, one aligned line per skill and tool:

![Contextimate compact view](../../docs/img/pi-contextimate-compact.png)

and expanded, which adds per-section sources and a readable schema tree for every active tool (excerpt):

![Contextimate expanded view, excerpt](../../docs/img/pi-contextimate-expanded.png)

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

- `[Contextimate]` renders after Pi's native startup resource sections, leaving Pi's default `[Context]`, `[Skills]`, `[Prompts]`, and `[Extensions]` order untouched.
- `Ctrl+O` cycles the `[Contextimate]` view through Pi's native expand/collapse path: summary → compact → expanded.
- `Ctrl+T` toggles Pi's thinking-block visibility and rebuilds the chat transcript; the estimator watches for that rebuild and re-inserts itself if Pi drops the startup block.
- `/contextimate` cycles the view.
- `/contextimate summary`, `/contextimate compact`, and `/contextimate expanded` jump directly to a mode.
- The panel speaks the family design language (`docs/design-language.md`): `[Contextimate]` brands the header in the theme accent with mode pips, the dim hint line carries the keybinding, model, and counting methodology once (`counts ch ÷ 2.6 (Claude 4.7+ heuristic)`, with `session ÷ …` / `tools ÷ …` / `tools: OpenAI formula` qualifiers when those methods deviate), and data rows carry only their raw size (`(9.2k ch)`). Section rows open with the family `▸` glyph in every mode, numbers use the shared fixed-k grammar (`~64.3k tokens`), and the total rows show their share of the context window with the `~` estimate marker (`~32% ctx`, `<1% ctx`) plus one stacked accent/dim bar under the pi-exact `Total request` answering “how full am I?” at a glance.
- Compact is a scan view: one aligned line per skill and per tool (name · estimated tokens · short description), sorted by estimated tokens. Loaded-but-inactive tools are shown as dim rows with `-` for tokens and `(inactive)` at the start of the description.
- Expanded adds the deep detail: per-section method/caveats and sources, plus a readable schema field tree for each active tool (name · type · required · description, with nested array/object fields indented), sorted by estimated tokens. Token counts are still computed on the minified provider-shaped payload; the tree is just the legible view of it. Paths and URLs are shown as text rather than terminal hyperlinks, because OSC-8 file links are unreliable in this startup-component surface. (Runtime system prompt and context files stay summarized.)
- The first row is `Runtime system prompt` rather than "System prompt" because Pi assembles that prompt at runtime from its base prompt plus tool/extension contributions (the `Available tools` snippet lines and tool `promptGuidelines`). In expanded view the row attributes the part it can verify, `of which tool/extension instructions: ~Nk tokens (…)`, counted by matching each loaded tool's snippet line and deduplicated guidelines against the actual prompt text, so the `Tools` row is not mistaken for a tool's complete context footprint. The attribution is informational; those tokens are already included in the row's count.
- Each expanded tool header renders the tool name in bold with a short dim provenance beside it: `scope · path`, where **scope** is `user` / `project` / `temporary` and **path** is the defining file, home-shortened to `~/…` and middle-truncated to stay on one line (builtins collapse to the single word `builtin`; tools without a path fall back to their loader source, e.g. `npm:<pkg>`). The origin URL / `package` / `top-level` decorations are dropped; the path already identifies the artifact. The token estimate stays right-aligned, and parameter columns align across the whole tools block.

## Docs

Full notes, accounting heuristics, experiment results, and validation-script instructions live in the package docs:

- `docs/pi-contextimate.md`
- `docs/pi-contextimate-codex-context-accounting.md`

Packaged diagnostics:

- `pi-contextimate-probe-prefix`: run a tiny live prefix probe and print sanitized payload-size/usage summaries.
- `pi-contextimate-evaluate-transcripts`: evaluate local Pi JSONL session-growth heuristics against recorded usage.
- `pi-contextimate-check-provider-tokens`: provider-exact token counts (baseline / system / all-tools / per-tool) for a captured payload, with solved tool-block overhead and suggested heuristic denominators. Anthropic is free (`count_tokens`); OpenAI probes cost a fraction of a cent.
