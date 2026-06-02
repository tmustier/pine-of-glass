# pi-contextimate

`pi-contextimate` is a Pi extension that adds a startup `[Context summary]` panel showing what is filling the current model context window: system prompt, AGENTS.md files, Agent Skills, active tools, and current session material.

## Install

Install the package repo:

```bash
pi install git:github.com/tmustier/pine-of-glass
```

Try it for one run without installing:

```bash
pi -e git:github.com/tmustier/pine-of-glass
```

For local development from a clone:

```bash
pi -e ./extensions/pi-contextimate
```

The package manifest points Pi at this extension directory, so future internal splits into multiple files can keep the same install path.

## Use

- `Ctrl+O` cycles the `[Context summary]` view.
- `/contextimate` cycles the view.
- `/contextimate summary`, `/contextimate compact`, and `/contextimate expanded` jump directly to a mode.

## Docs

Full notes, accounting heuristics, and experiment results live in the repo docs:

https://github.com/tmustier/pine-of-glass/blob/main/docs/pi-contextimate.md
