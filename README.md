# pine-of-glass

Small observability and context management tools for [Pi](https://github.com/earendil-works/pi) in the terminal.
1. [`contextimate`](./extensions/pi-contextimate) breaks down what is filling your context window: sysprompt, AGENTS.md, Skill frontmatter, Tool schemas, and session material. Toggle with ctrl+o on start and /reload.
2. [`traceline`](./extensions/pi-traceline) collapses tool calls to one trace line each, so you can see the full arc of what Pi did (path taken, context read, bloated tool results). Toggle with ctrl+t (expands/collapses both thinking blocks and tools so you can see everything your agent did since your last message).
3. `cachemire` coming soon.

See each extension's own `README.md` for details, and `docs/` for deeper reference.

## Installation
- From GitHub: `pi install git:github.com/tmustier/pine-of-glass`
- From npm (installs both `contextimate` and `traceline`): `pi install npm:pine-of-glass`

## Screenshots
### [Contextimate](./extensions/pi-contextimate)
<img width="1477" height="589" alt="image" src="https://github.com/user-attachments/assets/8ff81aa2-f61b-4d8d-9507-f455f37c12cc" />

### [Traceline](./extensions/pi-traceline)
<img width="709" height="409" alt="image" src="https://github.com/user-attachments/assets/4a59fbae-8270-46d3-a4fc-fdf2e5c3ba8c" />

## Plans
1. The current goal is to provide an interface that makes tool and agent behaviour more legible for humans using pi in their terminal interactively. 
2. Once that's solid, we can help both humans and agents to more easily analyse previous sessions and traces, including when pi is running in RPC mode, remotely, or there is a large number of agent sessions we need to read to get insights from.

*Note: A nice side benefit of 1. is that tools like `traceline` can help agents running interactive pi subagents in tmux to monitor them without risking context bloat from tool outputs.*

**Status:** There are several things left to do in 1., including
- making the agent loop/cache behaviour more transparent (`cachemire` - e.g. am I using too many agent turns? am I past TTL? if I am mutating the prefix, is the cache miss worth it?),
- UI improvements for `traceline` (filepath/multi-read UI, tool result size)
- making `contextimate` more useful beyond upfront context (for example, are my MCP servers and skills efficient when loaded?)
- and other refinements tracked in issues.
