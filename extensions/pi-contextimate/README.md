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

The package manifest points Pi at this extension directory, so future internal splits into multiple files can keep the same install path.

## Use

- `Ctrl+O` cycles the `[Context Estimator]` view: summary → compact → expanded.
- `/contextimate` cycles the view.
- `/contextimate summary`, `/contextimate compact`, and `/contextimate expanded` jump directly to a mode.
- Compact/expanded modes show structural drilldowns and per-skill/per-tool estimates rather than dumping full prompt text.

## Docs

Full notes, accounting heuristics, experiment results, and validation-script instructions live in the package docs:

- `docs/pi-contextimate.md`
- `docs/pi-contextimate-codex-context-accounting.md`

Packaged diagnostics:

- `pi-contextimate-probe-prefix` — run a tiny live prefix probe and print sanitized payload-size/usage summaries.
- `pi-contextimate-evaluate-transcripts` — evaluate local Pi JSONL session-growth heuristics against recorded usage.
