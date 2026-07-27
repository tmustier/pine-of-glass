# pi-traceline

`pi-traceline` turns each tool call into one line. Use it to see what Pi did, which files it changed and which tool results used the most context.

Press `Ctrl+T` to switch between the trace and Pi's full tool output. Press `Alt+T` to drill into a single row without moving the transcript.

![Traceline showing one tool call per line](../../docs/img/pi-traceline-collapsed.png)

A trace looks like this:

```
  ▏ › read resource .pi/agent/AGENTS.md:1-20                 1.4k ch
  ▏ › [skill] google-workspace-stack:1-20                    1.0k ch
  ▏ › subagent delegate                                      0.1k ch
  ▏ › edit ./index.ts +3 -1
  ▏ › write /tmp/pi-extension-test-...-elephant.txt +5
  ▏ › pushed main $ git push
```

Each line shows the action and its target. Traceline also shows useful facts such as:

- line ranges for reads
- added and removed lines for file changes
- verified outcomes for commands such as `git push` and `gh pr merge`
- result size in characters, aligned on the right

## Install

Install the `pine-of-glass` package from npm:

```bash
pi install npm:pine-of-glass
```

Try it for one run without installing:

```bash
pi -e npm:pine-of-glass
```

Run it from a local clone:

```bash
pi -e ./extensions/pi-traceline
```

## Switch between trace and detail

Traceline follows Pi's reasoning visibility setting. The full view reuses Pi's own `Ctrl+T` keybinding.

- press `Ctrl+T` to show Pi's reasoning and full tool output
- press `Ctrl+T` again to hide reasoning and show one line per tool call
- press `Ctrl+O` (Pi's tool expansion) to expand or collapse every tool row in place while reasoning stays hidden

`Ctrl+T` remains decisive after `Ctrl+O`: if every tool row is expanded, Traceline collapses that expansion before Pi toggles reasoning. The next hidden-reasoning view therefore returns to the trace instead of staying expanded. Press `Ctrl+O` again whenever you want the expanded tool view.

The tool view reads its state from the live assistant row. It cannot get out of sync with the reasoning view. Traceline hides Pi's `Thinking blocks: hidden/visible` caption because the changing tool rows already show the state.

Outside drill mode, Traceline does not enable mouse reporting or change terminal scrolling.

## Drill into one row

`Ctrl+T` and `Ctrl+O` show everything at once. Drill mode shows one call.

Press `Alt+T` (or run `/drill`) to number the tool rows in place. The transcript does not move or reflow: each row's rail becomes its number, and `1` is the most recent call. A folded read row is one number. A two-line hint bar replaces the editor while the mode is open; your draft comes back when you leave.

- type a number to open that row in a full-screen pager; short numbers open instantly, and `enter` forces an ambiguous one
- press `enter` to open the selected row, `j`/`k` or the arrow keys to move the selection
- press `p` to expand or collapse the selected row in place, using Pi's native tool row
- press `esc` to leave

A modifier chord drill mode does not own (`Option+Up`, `Ctrl+C`, …) leaves the mode and still does its normal job: the editor is restored first, then the same keystroke lands in it. Drill mode never silently eats a shortcut that means something outside it.

The pager shows the row's trace line, then the complete invocation and the complete result. It never shows less than the model saw:

- a tool with no call renderer of its own (papercut, MCP tools, most extension tools) shows its complete arguments as aligned `key  value` rows instead of a bare tool name
- a result that provably is code renders as code: a read whose path names a code language gets pi's own syntax highlighting, a dim line-number gutter counting from the call's offset, and wrapped lines that hang under the code's indentation instead of snapping back to the margin. A bash `cat`/`sed`/`head`/`tail` of a single code file earns the same ink (without the gutter)
- an image result always shows a fact line (`image · png · 1044×646 · 65.6k bytes`), and on a terminal with inline-image support (kitty, iTerm2, Ghostty) the pixels render right in the pager, mirroring pi's own inline images. A partially scrolled image shows a dim `scroll to view` hint instead of a torn image

Scroll with `j`/`k`, the arrow keys, the page keys or `g`/`G`. Press `h`/`l` to move to the neighbouring row without closing. Press `esc` to return to the numbered transcript, exactly as you left it.

The most common case takes two keys: `Alt+T`, then `1` for the latest call.

Inside drill mode the mouse wheel works: it moves the selection, or scrolls the pager. Traceline turns mouse reporting on only while drill mode is open and turns it off again on exit, so normal terminal text selection is never affected.

Configure drill mode in the same config file as the size thresholds:

```json
{ "drillKey": "alt+d", "drillMouse": false }
```

`drillKey` changes the shortcut. `drillMouse: false` keeps mouse reporting off even inside drill mode.

On macOS, an Alt-letter shortcut works only when the terminal sends Option as Alt. In Ghostty, set `macos-option-as-alt = left` in the active config. cmux users can set the same value in Terminal settings or in `~/Library/Application Support/com.cmuxterm.app/config.ghostty`, then run `cmux reload-config`. This leaves right Option available for character composition. The `/drill` command works without Option-as-Alt.

## Find large tool results

Completed rows show their result size on a shared right edge. This makes unusually large results easy to spot.

Results use these colours by default:

- dim below 10k characters
- warning colour from 10k characters
- error colour from 50k characters

Results under 100 characters stay hidden unless another row in the same block has a visible size. File changes show diff counts instead of result size. A result that carries an image shows what was pulled instead of a misleading text-only count: `png 1044×646`, dim.

Set different thresholds in `~/.pi/agent/pi-traceline.json` or `<project>/.pi/pi-traceline.json`:

```json
{ "sizeWarningChars": 10000, "sizeErrorChars": 50000 }
```

## Read command rows

A command starts with `$`. Traceline highlights the commands that carry meaning and dims arguments, redirects and plumbing.

```
  ▏ › $ cd ~/projects/pine-of-glass && npm test 2>/dev/null | tail -5  1.4k ch
```

Multiline commands fit on one line. A dim `↵` marks each original line break. Traceline removes common boilerplate such as a leading `set -euo pipefail` and the bash tool's `(timeout Ns)` suffix. Use `Ctrl+T` to see the complete command.

Successful commands can lead with a verified outcome:

```
  ▏ › committed a1b2c3d $ git commit -m "Fix parser"
  ▏ › pushed main $ git push
  ▏ › merged PR #87 $ gh pr merge 87 --squash
```

Traceline only shows an outcome when the tool output proves it happened. It does not treat the command arguments as proof.

## Keep repeated work compact

Traceline folds adjacent rows when repetition would hide the useful difference:

- repeated `cd`, environment assignment and setup prefixes become `⋯`
- paginated reads of one file become one row with all ranges, the call count and total size
- consecutive reads of sibling files become one row: the shared directory prints once,
  then the basenames follow with their ranges. A long list wraps at file boundaries
  instead of truncating, and a file whose combined result grows past the warning
  threshold keeps its own row so the size column stays honest
- adjacent collapsed thinking blocks become one `Thinking: …` line. Their non-empty fragments append with ` · ` separators; source newlines never add display rows, and middle truncation keeps the newest thought visible

Text, tool calls and other content separate thinking previews. Visible prose between tool calls stops a row fold. Pi's full view always keeps the original rows.

## Keep the useful part visible

Traceline shortens rows before they reach the terminal edge. It:

- changes the home directory to `~`
- changes the current working directory to `./` for file reads and changes
- dims common path prefixes
- removes the middle of long rows so the basename, line range or final command stays visible
- uses one width for a block so columns and ellipses line up

```
  ▏ › read ~/projects/pine-of-glass/…/pi-traceline/README.md:1-300   3.8k ch
  ▏ › read ~/projects/pine-of-glass/…/pi-traceline/index.ts:1-200  18.5k ch
```

## Understand colours and status

The `›` bullet shows status: blue while running, green after success and red after failure. Failed rows also colour the action and main target red, so the failure does not depend on one small glyph.

The dim `▏` rail joins consecutive tool calls into a visible block. Traceline uses theme-derived colours rather than fixed terminal colours.

Read the [family design language](../../docs/design-language.md#9-trace-rows) for the full rendering rules.

## How Traceline works

Traceline wraps Pi's tool-row renderer after the session starts. When reasoning is visible, it uses Pi's native renderer unchanged. When reasoning is hidden, it renders the compact trace.

If compact rendering fails, Traceline falls back to Pi's native row. It does not modify Pi's `node_modules`, so it survives `pi update`.
