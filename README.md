# pine-of-glass

Small observability and context management tools for [Pi](https://github.com/earendil-works/pi) in the terminal.
1. [`contextimate`](./extensions/pi-contextimate) breaks down what is filling your context window: sysprompt, AGENTS.md, Skill frontmatter, Tool schemas, and session material. Toggle with ctrl+o on start and /reload.
2. [`traceline`](./extensions/pi-traceline) collapses tool calls to one trace line each, so you can see the full arc of what Pi did (path taken, context read, bloated tool results). Toggle with ctrl+t (expands/collapses both thinking blocks and tools).
3. [`cachemire`](./extensions/pi-cachemire) (**experimental**) explains cache behaviour and agent-loop economics: a cache TTL clock above the editor, predicted-then-resolved cache-break notices, a per-turn ledger, and `/cache` forensics. Included in the package as of `0.4.0`; wording, thresholds, and states may still evolve.
4. [`meantime`](./extensions/pi-meantime) (**experimental, opt-in**) explains where the wall-clock went: a live tempo line above the editor (waiting / thinking / writing / tools, with `~tok/s`), slow-start and slow-stream notices judged against the session's own medians, and a `/pace` ledger with an active-vs-idle share bar. New in `0.7.0`, and feature-flagged off by default.

See each extension's own `README.md` for details, `docs/` for deeper reference, and [`AGENTS.md`](./AGENTS.md) for development workflows and conventions.

## Installation
- From GitHub: `pi install git:github.com/tmustier/pine-of-glass`
- From npm (installs `contextimate`, `traceline`, and experimental `cachemire` and `meantime`): `pi install npm:pine-of-glass`. Meantime stays inert until its config sets `"enabled": true`.

## Screenshots
### [Traceline](./extensions/pi-traceline)
`ctrl+t` now collapses each tool call and thinking summary to a single line, and you can expand everything back to see per-item details.

![Traceline: one tool call per trace line](./docs/img/pi-traceline-collapsed.png)

### [Contextimate](./extensions/pi-contextimate)
Each new session and /reload now lists what's in your context window before you type a word. Toggle level of detail with `ctrl+o`.

Summary mode:
![Contextimate summary panel](./docs/img/pi-contextimate-summary.png)

Compact mode, one aligned line per skill and tool:

![Contextimate compact view](./docs/img/pi-contextimate-compact.png)

Expanded mode, with per-section sources and a schema field tree for every active tool (excerpt):

![Contextimate expanded view, excerpt](./docs/img/pi-contextimate-expanded.png)

### [Cachemire](./extensions/pi-cachemire)
You now see cache-related warnings inline and a cache shotclock above the editor. `/cache` gives you a full session review by turn.

![Cachemire turn ledger and cache clock](./docs/img/pi-cachemire-clock.png)

![Cachemire /cache ledger table](./docs/img/pi-cachemire-ledger.png)

### [Meantime](./extensions/pi-meantime)
Feature-flagged off by default. Once its config sets `"enabled": true`, a tempo line above the editor decomposes the current wait (waiting / thinking / writing / tools), slow calls earn a notice with a named cause, and `/pace` shows the per-call tempo ledger:

![Meantime live tool clock](./docs/img/pi-meantime-tempo.png)

![Meantime pace ledger](./docs/img/pi-meantime-ledger.png)

```
  call    ttft   think   write   tools   total     out  tok/s
     1    1.9s     42s    8.0s     31s   1m22s    2.1k     48
     2    1.7s    3.0s     12s    4.2s     17s    0.8k     41
     3     14s    6.1s    5.0s     22s     26s    0.7k     35  slow start (median 1.9s)
  totals: 3 calls · waiting 18s · thinking 51s · writing 25s · tools 57s · harness 4.6s
  timed 1h42m   ██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  active 10m (10%) · idle 1h32m
```

## Plans
1. The current goal is to provide an interface that makes tool and agent behaviour more legible for humans using pi in their terminal interactively. 
2. Once that's solid, we can help both humans and agents to more easily analyse previous sessions and traces, including when pi is running in RPC mode, remotely, or there is a large number of agent sessions we need to read to get insights from.

*Note: A nice side benefit of 1. is that tools like `traceline` can help agents running interactive pi subagents in tmux to monitor them without risking context bloat from tool outputs.*

**Status:** There are several things left to do in 1., including
- maturing [`cachemire`](./extensions/pi-cachemire) (implemented, live-tested, conformant with the family design language, and now shipped as experimental while the UX settles; see issue #6),
- making `contextimate` more useful beyond upfront context (for example, are my MCP servers and skills efficient when loaded?)
- and other refinements tracked in issues.
