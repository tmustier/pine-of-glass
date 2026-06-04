# pi-traceline

`pi-traceline` collapses each tool call in a turn down to a single, scannable **trace line**, so you can read the full arc of what Pi did at a glance - which path it took, what context it pulled in, and which tool outputs ballooned - instead of scrolling through pages of raw output.

It is built for the "I let Pi run for a couple of minutes and came back" moment. Full tool outputs are noisy, and a turn with more than a couple of commands is hard to follow unless you watched it happen live. Rendered one row per tool, the same turn becomes a timeline you can take in immediately - and you can still expand back to the native view whenever you want the detail.

![One tool call per trace line, with a result-size suffix on the right](../../docs/img/pi-traceline-collapsed.png)

## What you get

When tool rows are collapsed, each one renders as a single line:

```
› read resource .pi/agent/AGENTS.md:1-20            (chars 1.4k)
› [skill] google-workspace-stack:1-20               (chars 1.0k)
› [skill] tmux:1-20                                 (chars 0.9k)
› subagent list                                     (chars 1.1k)
› subagent delegate                                 (chars 0.1k)
› write /tmp/pi-extension-test-...-elephant.txt     (chars 0.1k)
› $ rm /tmp/pi-extension-test-...-elephant.txt ...  (chars 0.0k)
```

- **The arc of the turn** - every tool call in order, one line each, so you see the path Pi took.
- **What context Pi got** - which files it read and how much of them (`read ... :1-20`), which skills it invoked (`[skill] ...`), which subagents ran.
- **Which outputs were massive** - a right-aligned `(chars x.xk)` result-size suffix per row makes an over-large tool output (often a sign of a tool or guidance issue) jump out.
- **A status colour** on each row's bullet (`›`): green = success, blue = running, red = error.

Rendering reuses Pi's own tool-call renderer, so the visual grammar (bold command name, accented paths/backticks, warning line ranges, custom-tool renderers) tracks Pi's defaults. One blank line precedes a group of tool calls; consecutive tool calls stay tight.

### Reading the end of the line

The discriminating part of a row usually lives at the **tail** — the filename + `:line-range` for a path, or the operative end of a command — while the head is boilerplate (long `~/projects/...` prefixes, `cd … &&` preambles). So instead of a trailing ellipsis that deletes the signal, `pi-traceline`:

- **tildifies** home directories (`/Users/you/...` → `~/...`) to reclaim width before truncating;
- **middle-truncates** with a dimmed `…`, protecting the tail so the basename and `:range` survive, snapping the cut to a nearby `/` or space;
- **dims the directory** on plain file reads so the basename — *which* file — stands out.

```
›  read ~/projects/pine-of-glass/…/pi-traceline/README.md:1-300   (chars 3.8k)
›  read ~/projects/pine-of-glass/…/pi-traceline/index.ts:1-200    (chars 18.5k)
›  $ cd ~/projects/pine-of-glass && rm -f docs/img/…-native.png   (chars 0.0k)
```

## Install

For local development from a clone:

```bash
pi -e ./extensions/pi-traceline
```

Or add it to your Pi config's extension list pointing at this directory. If you install the whole `pine-of-glass` package from the repository root, `pi-traceline` loads alongside `pi-contextimate`.

## Use

`pi-traceline` rides Pi's native reasoning-visibility toggle - it does not add a keybinding of its own:

- **`Ctrl+T`** toggles Pi's reasoning visibility. `pi-traceline` makes tool rows follow that same state:
  - **reasoning shown** → native tool rows, untouched (full detail).
  - **reasoning hidden** → each tool row collapses to one trace line.
- So one keystroke flips the whole turn between "full detail" and "trace line", and back again when you want to expand.

The collapse state is read from a live assistant row (falling back to `~/.pi/agent/settings.json`'s `hideThinkingBlock`), so the tool view can never desync from the reasoning view.

## How it works

- On `session_start` it captures the real TUI and wraps `requestRender`, then patches the shared tool-row component prototype's `render` the moment a tool row exists. The patch is versioned and idempotent across reloads and session resumes.
- While reasoning is shown, `render` defers to Pi's original implementation unchanged. While reasoning is hidden, it emits the single trace line.
- Any failure inside the one-line path falls back to Pi's original `render`, so the extension can never break a frame.
- Nothing in Pi's `node_modules` is modified, so it survives `pi update`.
