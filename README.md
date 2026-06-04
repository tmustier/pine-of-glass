# pine-of-glass

A single pane of glass for what's happening inside a [Pi](https://github.com/earendil-works/pi-coding-agent) session — a small collection of observability extensions that make a Pi turn legible at a glance.

## Extensions

| Extension | What it does |
|---|---|
| [`pi-contextimate`](./extensions/pi-contextimate) | Startup `[Context Estimator]` panel breaking down what is filling the model context window — system prompt, AGENTS.md files, Agent Skills, active tools, and session material. `Ctrl+O` cycles summary → compact → expanded. |
| [`pi-traceline`](./extensions/pi-traceline) | Collapses each tool call in a turn to one scannable trace line, so the full arc of what Pi did (which path it took, what context it pulled, which outputs ballooned) reads at a glance. Follows Pi's `Ctrl+T` reasoning toggle and supports one-shot click expansion for individual tool rows. |

Together they answer the two questions you have when you come back to a long-running session: *what's filling my context?* (`pi-contextimate`) and *what did Pi just do?* (`pi-traceline`).

## Install

Install the whole collection from GitHub:

```bash
pi install git:github.com/tmustier/pine-of-glass
```

Or load it directly from a local clone:

```bash
pi -e .
```

You can also load one extension at a time:

```bash
pi -e ./extensions/pi-contextimate
pi -e ./extensions/pi-traceline
```

`pi-contextimate` is also published to npm:

```bash
pi install npm:pi-contextimate
```

See each extension's own `README.md` for details, and `docs/` for the deeper accounting notes.

## License

MIT — see [LICENSE](./LICENSE).
