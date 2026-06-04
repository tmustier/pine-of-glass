# pine-of-glass

Small observability and context management tools for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).
1. [`contextimate`](./extensions/pi-contextimate) breaks down what is filling your context window: sysprompt, AGENTS.md, Skill frontmatter, Tool schemas, and session material. Toggle with ctrl+o on start and /reload.
2. [`traceline`](./extensions/pi-traceline) collapses tool calls to one trace line each, so you can see the full arc of what Pi did (path taken, context read, bloated tool results). Toggle with ctrl+t.
3. `cachemire` coming soon.

See each extension's own `README.md` for details, and `docs/` for deeper reference.

## Installation
- From GitHub: `pi install git:github.com/tmustier/pine-of-glass`
- npm:
  - `pi install npm:pi-contextimate`

## How they work
### [Contextimate](./extensions/pi-contextimate)
<img width="1477" height="589" alt="image" src="https://github.com/user-attachments/assets/8ff81aa2-f61b-4d8d-9507-f455f37c12cc" />

### [Traceline](./extensions/pi-traceline)
<img width="709" height="409" alt="image" src="https://github.com/user-attachments/assets/4a59fbae-8270-46d3-a4fc-fdf2e5c3ba8c" />

