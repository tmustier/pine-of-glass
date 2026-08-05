# README screenshot rig

Regenerates the `docs/img/*.png` screenshots for the root and extension READMEs.
Every shot is taken **inside the real pi TUI**: the transcript may be crafted, but the
rendering never is: the point is to show what the actual renderers produce.

## Quick start

```bash
node scripts/dev/screenshots/rig.mjs traceline     # replays a crafted session (free)
node scripts/dev/screenshots/rig.mjs contextimate  # real startup panel (free)
node scripts/dev/screenshots/rig.mjs cachemire     # LIVE model calls (cents, gpt-5.6-sol)
node scripts/dev/screenshots/rig.mjs meantime      # LIVE model calls (cents, gpt-5.6-sol)
```

PNGs land in `docs/img/`. Each run prints the intermediate ANSI capture path so you can
inspect exactly what was on screen. Pass `--keep` to leave the tmux session and fixture
HOME in place for debugging (attach with `tmux -L pogshots attach -t pog-shots-<pid>`).

Requirements: `pi` on PATH, `tmux`, Google Chrome (headless), `python3` with PIL,
`~/.pi/agent/auth.json` (copied into the fixture; live scenarios need working credentials,
including Anthropic for Cachemire's no-call model switch).

## How it works

```
rig.mjs                 orchestrator: fixture HOME → tmux → pi → capture → PNG
traceline-session.mjs   builds the story-shaped session JSONL replayed by `pi --session`
ansi2html.mjs           tmux ANSI capture → styled HTML (truecolor/256, bold, dim,
                        italic, reverse, proper SGR resets; `freeze` got these wrong).
                        Vertical rail glyphs (▏ │) are drawn as full-line-height CSS
                        blocks, not font glyphs: terminals stretch block characters to
                        fill the cell so rails connect across lines, fonts don't;
                        without this the rail renders disjointed
html2png.py             headless Chrome screenshot → shadow-aware autocrop (PIL)
```

Per scenario, `rig.mjs`:

1. **Builds an isolated fixture HOME** (`makeFixture`) so *only this repo's extensions
   load*, so no personal extensions (e.g. session-hud) can restyle the TUI. It pre-seeds
   `~/.pi/agent/trust.json` (same recipe as `tests/smoke/startup-smoke.mjs`), writes a
   `.pi/settings.json` pointing at `extensions/<name>/index.ts`, and copies your real
   `auth.json` in.
2. **Puts the fixture project *inside* the fixture HOME** at `~/projects/site`, so every
   path pi renders tildifies like a normal machine instead of leaking temp dirs.
3. **Launches pi in tmux on a private server** (`tmux -L pogshots`, own config with
   `extended-keys on` and truecolor) so nothing touches your real tmux server and pi's
   extended-keys warning never fires.
4. **Drives the session** (waits on pane text predicates, sends keys), then captures the
   pane with `capture-pane -e` (colors preserved).
5. **Post-processes the capture** (`shoot()`):
   - drops startup housekeeping (subscription-auth warnings) and status echoes
     (`Thinking blocks: …`, `[Contextimate] view: …`) wherever they sit;
   - **crops everything below the input box**: finds the editor's bottom border and
     cuts the footer buckets (cwd · usage · model);
   - `trimTo:` cuts leading lines (pi header, extension announce) down to the first
     interesting line; `cutFrom:` cuts the tail from a marker onward and leaves a dim
     `⋮`, so long views ship as intentional-looking excerpts.
6. **Renders**: ANSI → HTML → PNG at device scale 2 in a fake window chrome, autocropped
   with a thresholded diff so the frame's soft drop shadow doesn't skew the margins.

## The scenarios

### traceline: crafted session, real renderer

`traceline-session.mjs` writes a session JSONL that tells one coherent story (recon →
folded reads → edits with diffs → a failed build → the fix) and exercises the design
language: rails, folded reads with line ranges, `./` cwd collapse, block-scoped path
emphasis and size column, diff facts, error tinting, deterministic mid-token cuts.
`pi --session <file>` replays it; nothing is invented by the renderer.

Crafting rules learned the hard way:

- **Assistant messages must carry `usage`** (`input/output/cacheRead/cacheWrite/
  totalTokens/cost`) plus `api/provider/model/stopReason`; pi's footer dereferences
  `usage` unconditionally and **crashes on resume** without it.
- Entries chain linearly by `parentId`; the header line is
  `{"type":"session","version":3,id,timestamp,cwd}` and `cwd` must match the dir pi is
  launched from (that's what `./` collapse keys on).
- Tool results are `role: "toolResult"` messages; edit/write results carry
  `details.diff` (lines starting `- ` / `+ `) which traceline turns into `+N -M` facts.
- Size the result texts deliberately; they drive the size column (block-scoped:
  one row ≥100 ch lights the cells for the whole fused block).

**Restored sessions open with thinking visible**, and traceline one-lines tool rows
only while thinking is hidden (its live default), so the rig sends one `Ctrl+T` before
shooting. Same trick in the cachemire scenario for a consistent look.

### contextimate: fully real

Fresh `pi --no-session` startup over a fixture project with an `AGENTS.md` and one
skill (`release-notes`), so the panel has real material to account for. Shoots all
three views: the summary panel, `/contextimate compact` (the whole table, it's short),
and `/contextimate expanded` cut after the first tool's schema tree (`cutFrom`), since
the full dump is a wall and one tree gives the sense.

### cachemire: fully live (costs money)

Cache behaviour needs live evidence, so this scenario makes **real model calls**:
3 tiny turns against a small fixture README, then `/cache`. It uses
`openai-codex/gpt-5.6-sol`, whose retention is unknown, switches to Anthropic without
calling it to capture the model-switch warning, then switches back for the OpenAI
ledger. Expect the table to vary: cold starts, hits and observed misses are authentic.
An unexplained miss keeps an unknown cause.

### meantime: fully live (costs money)

The meantime scenario asks `openai-codex/gpt-5.6-sol` to run an eight-second sleep. It
captures the live tool-union clock while the tool is open, then captures `/pace` after
the follow-up model call resolves. Both images come from real stream and tool event
boundaries; only the tiny fixture prompt is crafted.

## Iterating

- Change the traceline story in `traceline-session.mjs`; everything re-renders through
  the real pipeline on the next run.
- New scenario = new function in `rig.mjs` + an entry in `scenarios`. Compose from
  `makeFixture` / `launchPi` / `waitFor` / `send` / `shoot`.
- Wait on **pane text**, not sleeps, for anything that matters (`waitFor` polls
  `capture-pane`); keep the short `sleep()`s after, they let pi finish paint/fades.
- If a run dies early, the tmux session usually died with pi: re-run with `--keep`,
  or launch the fixture manually with `2>/tmp/pi-err.log` appended to see the crash.
- Screenshots are `docs/img/pi-<extension>-<what>.png`; READMEs reference them
  relatively (`./docs/img/…` from root, `../../docs/img/…` from extensions).
- Cleanup is automatic unless `--keep`: fixture HOMEs are `pog-shots-home-*` under the
  system temp dir, and the private tmux server dies with its last session
  (`tmux -L pogshots kill-server` to be sure).
