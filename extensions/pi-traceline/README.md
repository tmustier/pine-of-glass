# pi-traceline

`pi-traceline` collapses each tool call in a turn down to a single, scannable **trace line**, so you can read the full arc of what Pi did at a glance - which path it took, what context it pulled in, and which tool outputs ballooned - instead of scrolling through pages of raw output.

It is built for the "I let Pi run for a couple of minutes and came back" moment. Full tool outputs are noisy, and a turn with more than a couple of commands is hard to follow unless you watched it happen live. Rendered one row per tool, the same turn becomes a timeline you can take in immediately - and you can still expand back to the native view whenever you want the detail.

![One tool call per trace line, with a result-size suffix on the right](../../docs/img/pi-traceline-collapsed.png)

## What you get

When tool rows are collapsed, each one renders as a single line:

```
  ▏ › read resource .pi/agent/AGENTS.md:1-20                 1.4k ch
  ▏ › [skill] google-workspace-stack:1-20                    1.0k ch
  ▏ › [skill] tmux:1-20                                      0.9k ch
  ▏ › subagent list                                          1.1k ch
  ▏ › subagent delegate                                      0.1k ch
  ▏ › edit ~/projects/demo/index.ts                   +3 -1 · 0.1k ch
  ▏ › write /tmp/pi-extension-test-...-elephant.txt   +5 -0 · 0.0k ch
  ▏ › $ rm /tmp/pi-extension-test-...-elephant.txt ...       0.0k ch
```

- **The arc of the turn** - every tool call in order, one line each, so you see the path Pi took.
- **What context Pi got** - which files it read and how much of them (`read ... :1-20`), which skills it invoked (`[skill] ...`), which subagents ran.
- **Which outputs were massive** - a right-aligned result-size suffix per row (`1.4k ch`, in the family number grammar shared with `pi-contextimate` and `pi-cachemire`). The suffix is **severity-tinted**: dim while healthy, warning-coloured at ≥10k ch, error-coloured at ≥50k ch — so an over-large tool output (often a sign of a tool or guidance issue) jumps out of the column. Thresholds are overridable via the family config convention (`~/.pi/agent/pi-traceline.json` or `<cwd>/.pi/pi-traceline.json`: `{ "sizeWarningChars": 10000, "sizeErrorChars": 50000 }`).
- **How much a file mutation changed** - diff-backed `edit` and live-snapshotted `write` rows include `+N -M` before the size suffix (`edit … +3 -1 · 0.1k ch`, `write … +5 -0 · 0.0k ch`). `write` stats come from a pre-execution snapshot, so historical/restored rows that were not seen live may still show only the size suffix.
- **A status colour** on each row's bullet (`›`): green = success, blue = running, red = error. The verb itself stays neutral bold — only a *failed* call tints its verb red — so a healthy trace column reads calm and errors actually pop.
- **A dim `▏` rail** opening every trace row, with the whole block indented one gutter under the prose margin, so a run of tool calls nests beneath the narrative and fuses into one visible block — block identity from indentation and one character of layout, not from painted backgrounds.
- **Selective expansion** - arm a one-shot click and then click a tool row to expand or collapse only that row, without flipping every tool result in the turn.

Rendering reuses Pi's own tool-call renderer for most tools, so the visual grammar (accented paths/backticks, warning line ranges, custom-tool renderers) tracks Pi's defaults, and traceline's own ink is **theme-derived** (the family `ink()` helper — see `docs/design-language.md`, amended §12), so it follows your active theme. On top of that sits an **ink hierarchy** that keeps tool rows one step quieter than assistant prose: verbs render neutral bold with status confined to the bullet; bash command bodies sit at the muted level with shell plumbing (`&&`, `|`, `;`, `2>/dev/null`, heredoc markers) a step dimmer still, anchored by the bold `$`; and the boilerplate `(timeout Ns)` suffix is dropped — the full invocation is one Ctrl+T or click away. One blank line precedes a group of tool calls; consecutive tool calls stay tight (their `▏` rails fusing into one block), and a tool row sits tight under the collapsed `Thinking: <first reasoning line> ... (N lines)` preview that motivated it, so each thought→action couplet reads as one unit.

### Repetition folds instead of re-printing (issue #14)

The information-dense diff between adjacent rows is often small — the command tail, a line
range — while a shared prefix dominates. Three folds keep the trace skimmable:

- **Repeated `cd <dir> && ` preambles** — pi's bash tool is stateless per call, so agents
  working outside the session cwd re-`cd` on *every* call (90% of bash rows in a measured
  session). When a row's preamble repeats the previous bash row's, it renders as a dim
  `⋯`, giving the width back to the part of the command that differs. The first
  occurrence always keeps the full path, and a `⋯` never points across visible prose.
- **Paginated reads** — consecutive reads of the same file (paging past the read cap)
  fold into one row with the combined ranges, call count, and total size. Anything
  visible between the reads breaks the fold, and clicking the folded row open restores
  the individual rows.
- **Collapsed thinking previews** — pi renders the collapsed label once per thinking
  *block*; traceline replaces the placeholder with `Thinking: <first reasoning line>`
  (rendered through Markdown, then stripped to plain text) plus `... (N lines)` when
  more trace lines are hidden, and coalesces adjacent label runs into one.

```
  ▏ › $ cd ~/projects/pine-of-glass && npm test 2>/dev/null | tail -5      1.4k ch
  ▏ › $ ⋯ && npm run typecheck                                            14.2k ch
  ▏ › read ~/projects/pine-of-gl…index.ts:1-200,201-400,401-600 3 calls · 51.1k ch
```

### Tool backgrounds

Trace lines are unbanded by default: status stays in the bullet and result-size suffix, while the body keeps the calmer edit-tool look. The previous full-width native background path is still available behind a flag if we want it back: set `PI_TRACELINE_TOOL_BACKGROUNDS=1` or add `{ "toolBackgrounds": true }` to `~/.pi/agent/pi-traceline.json` / `<cwd>/.pi/pi-traceline.json`, then reload Pi. When enabled, the band is still borrowed from Pi's own tool background (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`) rather than synthesized.

### Multiline commands stay one line

Bash commands keep their real newlines — heredocs, inline `python3 -c` scripts, chained `tmux` pipelines. Taking only the first rendered line collapsed them to an uninformative prefix like `$ python3 -c "` (issue #10). Instead, the whole command is flattened into the one trace line with a dim `↵` marking each original break, and middle truncation then keeps both the head and the *operative tail* — the checks at the end of a pipeline, not just its preamble:

```
  ▏ › $ python3 -c " ↵ import json ↵ p='~/.pi/agent/… -p -t pog-th | grep -E "cache|fable" | tail -4  0.3k ch
```

### Reading the end of the line

The discriminating part of a row usually lives at the **tail** — the filename + `:line-range` for a path, or the operative end of a command — while the head is boilerplate (long `~/projects/...` prefixes, `cd ... &&` preambles). So instead of a trailing ellipsis that deletes the signal, `pi-traceline`:

- **tildifies** home directories (`/Users/you/...` -> `~/...`) to reclaim width before truncating (OSC 8 hyperlink URLs are left intact, so click targets keep working);
- **middle-truncates** with a dimmed `…`, protecting the tail so the basename and warning-coloured `:range` survive, snapping the cut to a nearby `/` or space;
- **dims the directory** on plain file reads, edits, and writes so the basename — *which* file — stands out.

```
  ▏ › read ~/projects/pine-of-glass/…/pi-traceline/README.md:1-300        3.8k ch
  ▏ › read ~/projects/pine-of-glass/…/pi-traceline/index.ts:1-200        18.5k ch
  ▏ › $ cd ~/projects/pine-of-glass && rm -f docs/img/…-native.png        0.0k ch
```

## Install

From npm (published as part of the `pine-of-glass` package):

```bash
pi install npm:pine-of-glass
```

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
- Plain terminal scrolling stays available by default. To expand/collapse one row with the mouse, press `Ctrl+Shift+O` or run `/traceline-click` (optionally `/traceline-click 20` for a 20s window), then click the row.
- If you prefer always-on click handling, run `/traceline-click on`; this uses terminal mouse reporting and may capture wheel/trackpad scrolling until `/traceline-click off`. You can also start Pi with `PI_TRACELINE_CLICK=1` to opt into persistent click handling by default.

### Why clicks are off by default (design decision)

Receiving click events requires terminal mouse reporting (`1000` + SGR `1006`), and once that is on, terminals route wheel/trackpad scroll through the application instead of native scrollback — making Pi feel broken in the way users notice most. That cost is too high for a convenience feature, so the resolution (issue #7) is:

- **No mouse reporting by default, ever.** Plain terminal scrolling always wins.
- **One-shot arm is the primary path**: `Ctrl+Shift+O` or `/traceline-click` enables reporting for a single click or 8 seconds, whichever comes first, then releases the terminal. Every exit path (click consumed, TTL expiry, explicit disable) ends with mouse reporting off — this invariant is pinned by the test suite (`tests/traceline/click-state.test.ts`).
- **Persistent mode stays as an explicit escape hatch** (`/traceline-click on`, `PI_TRACELINE_CLICK=1`) for users who accept the scroll tradeoff knowingly.
- **Hit-map tracking is lazy**: the render-layout pass that maps screen rows to tool components only runs while click handling is armed or enabled, so the default configuration pays zero render-time cost for the feature.
- **Keyboard-first remains `Ctrl+T`** for the whole-turn toggle. A dedicated keyboard row-picker was considered and deferred: it would add modal selection UI for a gap the one-shot click already covers. Revisit if real usage shows the one-shot is too clunky.

The collapse state is read from a live assistant row (falling back to `~/.pi/agent/settings.json`'s `hideThinkingBlock`), so the tool view can never desync from the reasoning view.

## How it works

- On `session_start` it captures the real TUI and wraps `requestRender`, then patches the shared tool-row component prototype's `render` the moment a tool row exists (and the assistant-row prototype, for collapsed-thinking previews/coalescing). The patches are versioned and idempotent across reloads and session resumes.
- It also wraps the captured TUI render path to build a row-to-tool hit map. One-shot click mode briefly enables SGR mouse reporting and consumes SGR click events through Pi's public raw-input hook, then disables mouse reporting again so terminal scrolling works normally.
- While reasoning is shown, `render` defers to Pi's original implementation unchanged. While reasoning is hidden, it emits the single trace line unless that individual row has been clicked open.
- Any failure inside the one-line path falls back to Pi's original `render`, so the extension can never break a frame.
- Nothing in Pi's `node_modules` is modified, so it survives `pi update`.
