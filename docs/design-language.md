# The pine-of-glass design language

One visual grammar for the extension family — `pi-contextimate`, `pi-traceline`,
`pi-cachemire`, and anything added later. This document is the contract; `extensions/_lib`
is its implementation. When a renderer and this document disagree, one of them is wrong —
fix whichever it is, deliberately.

**Status: agreed 2026-06-12; implemented 2026-06-12; amended 2026-07-01 (§12)** across the shared-library pass
(#18), the traceline pass (#19, #20), the contextimate pass (#21), and the cachemire
pass (#22). Decisions marked `[D]` were proposed-by-default and confirmed; the former
open questions are resolved in §11. Changes to this language are fine — but they are
design decisions, made here first, then implemented. §9's per-extension lists are the
as-built conformance record.

## Why

The three extensions answer adjacent questions about the same agent loop:

| | granularity | currency | question |
|---|---|---|---|
| contextimate | static prefix | estimated tokens | what am I carrying? |
| traceline | per tool call | exact chars | what did tools do? |
| cachemire | per model call / turn | exact provider tokens & $ | what did the loop cost, and why? |

They should read as one instrument panel, not three apps that happen to share a repo.
Today they are three dialects: three glyph sets, three colour-sourcing strategies, and
two private number formatters despite `_lib/fmt.ts` claiming a shared grammar. This
document defines the single language; the per-extension conformance lists at the end
say exactly what each one changes to speak it.

## Principles

1. **Skimmable first, auditable second.** The default rendering of every surface is
   optimized for the half-second glance. Methodology, provenance, and caveats exist —
   once, in a dim place — never repeated per row.
2. **Quantities carry the eye.** Counts are right-aligned or column-aligned, in one
   number grammar, so magnitude can be compared down a column without reading.
3. **Severity is colour, identity is glyph, content is neutral.** Status lives in the
   1-character marker that opens a line; the body text stays in the neutral ink ramp.
   A wall of family output should look calm until something is actually wrong or big.
4. **Honest tense and honest certainty.** Estimates wear `~`; provider-reported numbers
   do not. In-flight statements are progressive with estimates; resolved statements are
   past tense with exacts. Wording strength matches evidence strength
   (contract → definite, documented band → hedged, nothing → "likely").
5. **The theme owns the ink.** All colour flows through `_lib/style.ts`, which derives
   from the active pi `Theme`. No raw ANSI colour constants in extension code. Family
   identity comes from the glyph and layout grammar, not from a brand colour.
6. **Silence when healthy.** Lines appear when they inform a decision or flag an
   anomaly (cachemire's materiality threshold is the precedent). No ambient chrome.

## 1. Glyph grammar

Every family-rendered line opens with a one-character marker in the 2-space gutter.
The marker identifies the *kind* of line; its **colour carries status**; the body text
stays neutral.

| glyph | meaning | used by |
|---|---|---|
| `›` | a tool action (one trace row) | traceline |
| `◍` | a loop-economics fact (clock, notice, ledger line) | cachemire |
| `▸` | an expandable/summarizable section header | contextimate (all modes) |
| `▏` | tool-block rail: the dim left edge of a run of trace rows | traceline |

Status scale — family-shared vocabulary (today cachemire-only):

| glyph | meaning |
|---|---|
| `○` | cold / empty |
| `●` | hit / full |
| `◑` | partial |
| `◌` | miss / broken |

Auxiliary marks, always at the **dim** ink level: `…` (truncation), `↵` (flattened
newline), `·` (U+00B7, the only inline fact separator).

Rules:
- One glyph per line, gutter position, never inline mid-sentence.
- The rail is the one sanctioned pairing: it is block chrome, not a line kind — always
  L3-dim, always the first visible mark of an indented trace block (column 2, §5),
  never a status carrier — and a railed line still carries exactly one kind-glyph
  (`  ▏ › body`).
- New line kinds reuse an existing glyph if the kind matches; a new glyph is a design
  decision recorded here, not an ad-hoc choice.

## 2. Ink hierarchy

Four levels, mapped to pi theme roles. Every piece of text in a family surface is
assigned a level on purpose.

| level | role | carries | theme source |
|---|---|---|---|
| L0 | discriminator | verb/tool name, basename, bash head command, totals, panel brand | `text` + bold; panel brands/totals `accent` |
| L1 | content | operative values | `text` |
| L2 | secondary identity | descriptions, field types | `muted` |
| L3 | apparatus | methodology, directories, bash argument text, plumbing (`&&`, `2>/dev/null`), markers, units, causes | `dim` |

Status/severity tones (glyphs, quantity suffixes, and native tool metadata like read `:line-range` spans; never body prose):

| tone | meaning | theme source |
|---|---|---|
| success | completed / hit / fresh | `success` |
| warning | fading / closing / large / partial | `warning` |
| error | failed / broken / huge | `error` |
| running | in flight | none faithful — `style.ts` fallback (ANSI blue) `[D]` |

Status never tints body text: a verb is L0 neutral bold, and the `›` bullet alone
carries success/running. The single exception is a *failed* call, which may tint its
verb error — an error is a real anomaly, not ambient status. (Amended 2026-07-01, §12;
traceline previously tinted every verb with its status tone, which made healthy columns
green and defeated the squint test below.)

The test of a good ink assignment: squint. Only L0 and any non-dim severity tones
should survive the squint. If a wall of tool rows survives at the same brightness as
assistant prose, the hierarchy is wrong (the 2026-06 traceline complaint, resolved by
the §12 amendments: verbs neutral-bold, quiet bash bodies, the `▏` rail).

## 3. Colour sourcing

- **All ink goes through `_lib/style.ts`.** No `\x1b[32m`, no hardcoded
  `rgb(128,128,128)` in extension files. `style.ts` resolves tones against the live
  `Theme` (`theme.fg("dim", …)` etc.), so light terminals and custom themes work.
- **The family accent is `theme.fg("accent")`** `[D — resolved]`. The original orange
  `rgb(245,151,52)` was an arbitrary pick, not a brand, and is dropped. Accent is used
  sparingly: panel brands (`[Contextimate]`), highlighted token figures, total rows,
  the filled part of proportion bars. Recognizability comes from the glyph and layout
  grammar, which survives any theme.
- Family renderers do not synthesize backgrounds. Traceline's old tool-background
  experiment, when explicitly enabled, **borrows live from pi** (`contentBox.bgFn` /
  `toolSuccessBg`) rather than inventing colours; by default trace rows are unbanded.
- Components that render before a `Theme` handle exists may use `style.ts` raw
  fallbacks; everything rendered after `session_start` has `ctx.ui.theme` and must use it.

## 4. Number grammar

One formatter family in `_lib/fmt.ts`, used by everyone. Private formatters
(`compactTokenNumber` in contextimate, `formatTokensK` in cachemire) are deleted.

| quantity | format | examples |
|---|---|---|
| counts | **fixed k-unit**, one decimal (`0.0k`–`999.9k`); one-decimal M ≥ 1M | `0.1k`, `1.2k`, `52.3k`, `9.1M` |
| chars | count + ` ch` (`formatChars`) | `0.4k ch`, `1.4k ch`, `35.2k ch` |
| tokens, estimated | `~` + count + ` tokens` (unit word may be dropped in columns) | `~0.1k tokens`, `~14.2k tokens` |
| tokens, provider-reported | count, **no `~`** | `64.1k tokens` |
| money | `$` two decimals (three below $0.10, where the third digit is significant); `~` when projected | `$0.052`, `$17.03`, `~$2.67` |
| duration | compact mixed units, no spaces | `14s`, `4m30s`, `9h50m` |
| share | integer percent in parens; one decimal only for context-window usage | `(97%)`, `32.2% / 200k ctx` |

Hard rules:
- **One unit, everywhere.** `[D — confirmed]` Counts never switch between raw integers
  and k-units: same-unit rendering is what makes magnitudes comparable down a column
  and across surfaces. `0.1k ch` and `35.2k ch` compare at a glance; `133 ch` and
  `35.2k ch` do not. `0.0k` is acceptable noise; mixed units are not.
  - This re-specifies `compactCount` in `_lib/fmt.ts` to fixed-k (its raw-integer
    branch is removed), which *changes current output*: traceline suffixes
    (`133 ch` → `0.1k ch`) and the cachemire ledger (`out 400` → `out 0.4k`).
  - M is the only permitted step-up, at ≥ 1M, where k becomes unreadable
    (`9.1M`, not `9100.0k`).
- The `~`/no-`~` distinction is semantic — estimated vs provider-reported — not
  stylistic. Do not add `~` for visual symmetry or drop it to save a column.
- Bare counts (no unit) are allowed only directly after a labelled verb where the unit
  is unambiguous: `read 150.3k · wrote 1.8k` (cachemire ledger style).
- `formatUsd` and `formatDuration` move from cachemire into `_lib/fmt.ts`.

## 5. Layout grammar

- **Gutter:** 2 spaces, then the glyph, then 1 space, then the body. Tool trace rows
  nest one gutter deeper: 2 spaces, the dim `▏` rail, a space, then the standard
  glyph gutter (`  ▏ › body`, six visible columns) — prose owns the margin and the
  tool block indents beneath the narrative line that motivated it; consecutive rows
  fuse into one visible block, and the blank spacer before a group ends the rail
  (§12.3, §12.8).
- **Quantities right.** Per-row magnitudes are a right-aligned dim suffix with a ≥2-space
  gap (traceline's `… 1.4k ch` pattern) or a column-aligned field (contextimate rows,
  cachemire `/cache` table). Never woven mid-sentence when the line is a row in a list.
  Trace rows keep a 2-column right inset from the terminal edge, mirroring the left
  gutter (§12.21).
- **Facts inline are `·`-separated**, ordered: *what happened · how big · share · cost ·
  cause*. Cause is always last and always L3-dim.
- **Methodology appears once per panel** — a dim line under the panel header, or the
  right side of a section header — never on data rows. Data rows carry at most a raw
  size in parens: `(9.2k ch)`.
- **Blank lines:** one before a group; none within it; a row sits tight under the
  collapsed `Thinking…` line that motivated it (traceline's couplet rule, family-wide).
- **Tildify** home paths; **middle-truncate** protecting the tail; dim the directory,
  brighten the basename, and keep read `:line-range` spans warning-coloured so scoped
  file reads remain visible. (Traceline's rules, promoted to family rules;
  contextimate's expanded tool paths already comply approximately.)

### Panel headers

Panels (multi-line surfaces with a top: contextimate's estimator, cachemire's `/cache`
ledger) share one header form:

```
[Contextimate] summary → compact → expanded
  ctrl+o: cycle view · model anthropic/claude-opus-4-8 · counts ch ÷ 2.6 (Claude 4.7+ heuristic)
```

- Line 1: `[Name]` in bold theme accent + mode pips when the panel has modes
  (active mode accent-bold, others dim, `→` dim).
- Line 2: dim hint line — keybinding, scope/profile, and the panel's methodology (once).
- `[D]` Panels brand with the **extension name** (`[Contextimate]`, `[Cachemire]`), not
  descriptive titles (`[Context Estimator]`, `Cachemire — cache & loop ledger`). One
  naming system; the descriptive part can live in the dim hint line. This renames a
  documented surface (README, tests) — approved and applied (§11.1).

### Proportion

Magnitude tables answer "how big"; panels should also answer "**of what**". Where a
total has a meaningful budget (context window), show share — a percent column and/or a
single stacked bar:

```
  Total request   64.1k tokens (32.2% / 200k ctx)
  ████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  harness 14k · session 50k · free 136k
```

`[D]` contextimate's summary gains this (one bar + per-row share of harness); details in
its conformance list. Bars use `█`/`▒`, accent for the carried part, dim for free.

## 6. Severity grammar

Anomaly thresholds tint the *quantity suffix or glyph*, not the body:

- **Tool result size** (traceline): dim below 10k ch · warning ≥ 10k ch · error ≥ 50k ch.
  Thresholds in `style.ts`, overridable via the family config convention
  (`~/.pi/agent/pi-traceline.json`).
- **Cache materiality** (cachemire, existing precedent): notices only above $0.05 or
  20k re-written tokens — silence when healthy.
- Severity colour is reserved for *exceeded thresholds and real states*. Nothing is
  tinted "for visual interest".

## 7. Wording grammar

- **Tense rule (cachemire's, family-wide):** in-flight = progressive + `~`
  (`cache breaking · re-writing ~138.2k`); resolved = past + exact
  (`cache broke · re-wrote 138.2k`).
- **Certainty ladder:** contract-backed → definite (`cache cold`); documented band →
  hedged (`cache fading`); unknown provider → `likely`. Never write definite words on
  soft evidence.
- Status one-liners are lowercase; Title Case only for panel headers and row labels.
- Causes are stated from observed evidence (payload diffs, usage), never inferred — and
  say `unknown` when unknown.

## 8. `_lib/style.ts` (to be created)

The single implementation of sections 1–6. Sketch:

```ts
// identity
export const GLYPH: { tool: "›"; econ: "◍"; section: "▸" };
export const SCALE: { cold: "○"; hit: "●"; partial: "◑"; miss: "◌" };
export const SEP = " · ";

// ink — all colour flows through here
export type Tone = "text" | "muted" | "dim" | "success" | "warning" | "error" | "running" | "accent";
export function ink(theme: Theme | undefined, tone: Tone, text: string): string; // theme-derived, raw-ANSI fallback

// layout helpers (lifted from traceline / contextimate, deduplicated)
export function rightAlignSuffix(body: string, suffix: string, width: number): string;
export function middleTruncate(line: string, width: number): string;   // moves from traceline
export function tildify(text: string): string;                          // moves from traceline (OSC-8-safe)
export function panelHeader(theme, name: string, pips?: …, hint?: string): string[];

// severity
export function sizeTone(chars: number, overrides?): Tone;             // dim | warning | error
```

`_lib/fmt.ts` grows `formatTokens(value, { exact?: boolean })`, `formatUsd`,
`formatDuration`. `_lib` keeps no `index.ts` (pi discovery skips it).

## 9. Conformance: what each extension changes

### pi-contextimate

1. Delete `compactTokenNumber`; use shared fixed-k `compactCount`. Visible change is
   small: `~0.1k` stays `~0.1k`; integer-k above 1000 gains one decimal
   (`~64k` → `~64.1k`) so precision is uniform down a column.
2. Methodology to the header hint line (once); summary/compact rows keep only
   `(9.2k ch)`; expanded section headers keep the full per-section method (that *is*
   the audit view).
3. `▸` on summary rows too (today compact-only), so sections read as the same object
   across modes.
4. Proportion: percent-of-window on the two total rows + one stacked bar under
   `Total request`; optional per-row share of harness in summary. `[D]`
5. Header becomes `[Contextimate]` + pips (naming resolved, §11.1); the pips pattern
   moves to `style.ts` for reuse.
6. Hardcoded `ORANGE` constant deleted; brand/figure/total highlights move to
   `ink(theme, "accent", …)` — the orange was an arbitrary pick and is not retained.

### pi-traceline

1. All ink through `style.ts`: `MUTED_GREY`/raw ANSI replaced with theme-derived tones
   (the bg-borrowing stays as-is — it is the model the family follows).
2. **Severity-tinted size suffix** per section 6 — makes "which outputs ballooned"
   actually pop; today every suffix is uniform grey. Suffix numbers move to fixed-k
   via the shared formatter (`133 ch` → `0.1k ch`).
3. **Repeated-preamble dimming:** when a row's leading segment (`cd X &&`, identical
   pipeline head) repeats the previous row's, render that head at L3-dim (or elide to a
   dim `⋯ &&`). Kills the wall-of-`cd` (issue #14).
4. Body ink one step down (as amended in §12): verbs neutral bold L0 with status in
   the `›` bullet (error rows tint the full discriminator set — verb, bash head,
   basename — per §12.14); bash bodies at the one L3-dim supporting grey with the
   head command word L0-bold (§12.9/§12.11); path rows (read/edit/write) dim the
   block-scoped boring prefix — common block directory or cwd — render the divergent
   tail L0-bold (§12.16), and keep read `:line-range` spans
   warning-coloured; native rows for other tools demote unstyled spans to dim
   (§12.12); the char suffix appears when the block's size column is live — any row
   ≥100 ch lights every cell in the block, an all-tiny block shows none (§12.13/
   §12.15) — and diff stats drop their zero side (§12.13). Every
   trace row opens with the dim `▏` rail so a run of rows reads as one block. Trace
   rows are unbanded by default; the old native-background slab path stays available
   behind `toolBackgrounds`.
5. Fold paginated reads of one file into one row (`read …/index.ts:1-200,201-400 · 2
   calls · 37.0k ch`) and fix doubled `Thinking…` lines — issue #14's scope, executed
   under this language.
6. `›`, `↵`, middle-truncation, tildify: unchanged in behaviour; implementation moves
   to `_lib` so the family shares it.

### pi-cachemire (applied for first package ship, #22)

1. Delete `formatTokensK`; use fixed-k `compactCount` (ledger `out 400` becomes
   `out 0.4k`). `formatUsd`/`formatDuration` move to `_lib/fmt.ts` (call sites
   unchanged).
2. `/cache` ledger adopts the panel-header grammar (`[Cachemire]` + dim profile/hint
   line; naming resolved, §11.1).
3. Status glyphs `○ ● ◑ ◌` and `◍` move to `style.SCALE`/`style.GLYPH` — promoted to
   family vocabulary, behaviour unchanged.
4. Clock/notice tones (green/yellow/grey) become theme-derived via `ink()`.
5. Inline fact order audited against section 5 (*what · size · share · cost · cause*) —
   mostly already true.

## 10. Testing

- Goldens are the visual regression net: each panel mode at 80 and 120 cols
  (contextimate already has these; add traceline one-line goldens and cachemire
  ledger/notice goldens). Regenerate with `UPDATE_GOLDENS=1 npm test`; review the diff
  like code — number-grammar migration (4.) will move many goldens at once, in one
  dedicated commit.
- `style.ts` gets direct unit tests (tone fallbacks without a theme, severity
  thresholds, right-align/truncate edge cases) — most lift from
  `tests/traceline/one-line.test.ts`.
- Contract tests are unaffected (no new pi-internal seams; `style.ts` consumes the
  public `Theme`).

## 11. Resolved questions

All resolved with Thomas, 2026-06-12:

1. **Panel naming** → extension names: `[Contextimate]`, `[Cachemire]` (descriptive
   text demoted to the dim hint line). README/test references updated in each pass.
2. **Contextimate proportion** → bar + percent (§5).
3. **"Running" tone** → ANSI-blue fallback in `style.ts` (no faithful theme role;
   `accent` would collide with brand/total highlights, `warning` overloads "fading").
4. **Family accent** → theme-`accent`-derived; the orange was arbitrary and is dropped (§3).
5. **Number grammar** → fixed k-units everywhere; no raw-integer counts (§4).

## 12. Amendments — 2026-07-01

Agreed with Thomas (the "traceline feels messy and unstructured" review): trace rows
and assistant prose competed at the same brightness, and nothing grouped a run of tool
rows into a block.

1. **Verbs are neutral.** Trace-row verbs render L0 neutral bold; the `›` bullet alone
   carries success/running. Only an error row may tint its verb (§2). Healthy columns
   stop being green.
2. **Bash bodies sit at L2.** The command text renders muted, with plumbing and the
   flatten/elision marks (`↵`, `⋯`) dim; the bold `$` anchors the column at L0. Pi's
   native bash syntax styling is dropped in one-line mode — the invocation *text*
   still comes from pi's renderer, the ink is the family's. Keeping a single
   "operative segment" bright was considered and rejected: a pipeline tail is as often
   a filter (`| tail -5`) as it is the point, so the whole body sits uniformly at L2
   and middle truncation continues to protect the tail. (Body level superseded by
   §12.9; the rejection of a bright operative *tail* stands.)
3. **The `▏` rail.** Every trace row opens with a dim `▏` (§1, §5), fusing
   consecutive rows into one visible block — the block identity the retired background
   bands were reaching for, at one character of width and zero synthesized colour.
4. **Path emphasis widens.** The dim-directory / bright-basename treatment, previously
   read-only, now applies to plain `edit` and `write` rows too, so the mutation column
   reads like the read column. Rows whose native line carries extra decoration keep
   pi's own rendering.

From the same review, contextimate:

5. **Panels end with one spacer.** A panel's body is followed by a single blank line,
   so the next chat block (typically the first user message) never abuts the panel.
   This is §5's "one blank before a group" applied to whatever follows a panel — the
   panel supplies its own tail because pi does not.
6. **Expanded tool provenance is short and dim.** An expanded tool entry renders its
   name L0 bold with provenance beside it at L3-dim, shortened to `scope · path`
   (tildified; builtins collapse to the single word `builtin`). The origin URL /
   package ref / `top-level` decorations are dropped from the label: the local
   defining path already identifies the artifact, and the path *is* the audit trail.
   Previously the full `scope · source · origin · path` chain rendered at L1 text,
   which drowned the tool names — the expanded-view half of the squint-test complaint.
7. **Tool param columns align block-wide.** Field name/type/required columns in the
   expanded tools view align across the whole block, not per tool, so the section
   reads as one table instead of a stack of differently ragged mini-tables.

Follow-up review, same date (the rail sat flush against the terminal margin, reading
as a page border rather than a thread line):

8. **The trace block nests.** Trace rows indent one 2-space gutter before the rail
   (`  ▏ › body`, six visible columns). The margin belongs to narrative — prose and
   `Thinking…` lines — and tool machinery nests geometrically beneath it, turning the
   rail from a left border of the page into a bracket around the group. Indentation is
   a stronger structural cue than ink; the two columns of width are cheap because the
   size suffix stays right-aligned and middle truncation protects the tail.

Third follow-up, same date (the "slightly different greys" review): bash rows used a
muted body sitting *between* the dim of path-row directories and the bright of
basenames — two supporting greys close enough to read as inconsistency rather than
hierarchy.

9. **One supporting grey.** The L2-muted trace-row body level dissolves (supersedes
   §12.2's body level). Bash rows speak the exact grammar of path rows: the bold `$`
   anchors at L0; the head command word — the first non-assignment token, scanning
   past a `⋯ &&` elision — stays bright the way a basename does (both promoted to
   L0-bold by §12.11), so `$ rm`,
   `$ npm`, `$ python3` scan like `read file.ts`; and everything else — arguments,
   connectors, redirects, marks — sits at the one L3-dim supporting grey shared with
   directories, plumbing, size suffixes, and the rail. Fallback rows (tools without a
   renderer) dim their argument text the same way. Same role, same ink, on every row;
   the head-vs-rest step is a real one, not a two-adjacent-greys subtlety.
10. **Ink survives the cut.** `middleTruncate` replays the active SGR state after the
    ellipsis, so a cut inside a styled span no longer leaves the tail at the terminal
    default (§12.2's "accepted quirk", fixed family-wide — required once bash bodies
    dropped to dim, where a default-ink tail would glare).

Fourth follow-up, same date (basenames read in the same white as assistant prose):
§2 always placed basenames at L0 — `text` + bold — but the implementation left them
at the terminal default, identical to message text in most themes, so the brightest
ink in a trace row was prose ink.

11. **Bold is the trace row's white.** Basenames and bash head commands render as the
    L0 discriminators they are: bold `text`, the same treatment as the verb. Plain
    prose-weight white never appears inside a trace row, so a trace block reads as
    dim apparatus + bold discriminators + status accents — and can never share ink
    with a message line.

Fifth follow-up, 2026-07-02 (full-sweep polish review): four gaps between the stated
invariants and the pixels, closed together.

12. **No plain ink in native rows.** Non-bash/path tool rows reuse pi's native
    invocation line, and only the verb was re-inked — every span the native renderer
    left unstyled rendered at the terminal default, the exact basename problem of
    §12.11 alive on `grep`/`web_search`/`fetch_content`/`mcp` rows. Unstyled spans in
    a native invocation line now demote to L3-dim; spans pi deliberately coloured
    (patterns, ranges, backticks) and bold-only spans survive untouched. §12.11's
    invariant now holds for every tool, not just the hand-rebuilt rows.

13. **A fact suffix must carry a fact.** Results under 100 ch — a `mkdir`, an `rm`,
    a one-word echo — rendered a literal `0.0k ch`: a fact suffix with no fact. The
    char suffix is omitted below 100 ch; it reappears the moment output is worth
    counting, and the severity tints (§6) are unaffected. Likewise diff stats drop
    their zero side: `+2 -0` → `+2`, `+0 -3` → `-3` — the dimmed zero was a
    half-measure, and every new-file write wore a guaranteed-noise `-0`.

14. **Errors tint the discriminators.** On a failed row only the bullet and verb
    tinted error — for bash the verb is a single `$`, one red glyph in a dim wall,
    with the head command still confidently bold-white. Failed rows now tint the
    whole discriminator set — verb, bash head command, basename — in error ink,
    still bold. Status stays confined to marker + discriminators; supporting text
    stays dim; healthy rows are untouched.

Sixth follow-up, same date (diff-only rows crashed into the size column): dropping
tiny sizes made mixed blocks ragged — a `+3` row ended flush at the right edge while
its neighbours ended in `…k ch`, so nothing lined up vertically and the column
stopped being scannable.

15. **Columns are block-scoped.** The fact floor of §12.13 applies per visual block,
    not per row: within one contiguous trace block (the rail-fused run — invisible
    connectors fuse; visible prose breaks, and so does a collapsed thinking preview,
    which renders with a blank line above it and restarts the rail), if any completed row
    clears the floor the size column is *live* and every completed row shows its
    cell, dim `0.0k ch` included — inside a live column a blank is a misalignment,
    not a calm. A block with no row above the floor (a `mkdir`/`rm` cleanup run)
    still shows nothing. Vertical alignment is scannability; the floor only trims
    noise where no column exists to break.

Seventh follow-up, same date (successive edits shared a long path prefix and the
dim-directory rule buried the divergence): in a block of edits under one `src/`, the
discriminating segments (`pages/`, `data/`, `components/`) sat inside the dimmed
directory while only basenames stayed bright — the eye had to re-read the grey to
tell rows apart.

16. **Dim the boring prefix, not the directory.** Path emphasis is block-scoped like
    the columns of §12.15: the dim zone of a path row is its longest *boring prefix*
    — the block's common directory prefix (when at least two segments deep) or the
    row's cwd prefix, whichever is longer — and everything past it, divergent
    directories included, is the discriminator and renders bold. A lone path row's
    common prefix is its whole directory, so single calls keep the basename-only
    emphasis, as do blocks that never diverge (the same file re-edited). cwd counts
    as boring by default: it is session-ambient context, not information.

Eighth follow-up, same date (the `…` wandered): middle truncation cut each row at a
content-dependent column — the tail slid forward to the nearest separator, the head
snapped back within eight columns, and each row's body budget flexed with its own
suffix width — so a block of long bash rows scattered ellipses and tail edges across
the page, and the eye had no stable seam to skip over.

17. **The cut is a column.** Truncation columns are deterministic and block-scoped.
    Within a rail-fused block every row shares one body budget — the width left
    after the block's widest fact suffix — and a truncated row cuts at exact
    columns: the head fills its share, a dim `…`, then a tail of exactly the
    reserved width ending flush where the suffix column begins. Content-dependent
    snapping is gone: a mid-token cut beside a dim ellipsis is legible, but a
    wandering ellipsis column is not. Rows that fit their budget simply end early,
    like prose.

Ninth follow-up, same date (the cwd prefix still spent thirty columns saying
nothing): §12.16 called cwd boring, yet every path row under it re-stated the full
`~/projects/<repo>/` before reaching the part that mattered, crowding the very
tails §12.17 was trying to keep aligned.

18. **cwd collapses to `./`.** A path under the row's cwd renders as a dim `./`
    followed by the cwd-relative tail — the shell's own notation for "here", two
    columns instead of thirty. Paths outside cwd keep their tildified absolute
    form; the asymmetry is itself information (in-repo vs out-of-repo). Emphasis
    then follows §12.16 with `./` counting like `~`: alone it is a trivial root
    marker (yet always a boring-prefix candidate), while `./src/` is a meaningful
    shared prefix — so a block diverging under one `src/` dims `./src/` and a block
    diverging at the repo root brightens whole relative paths. Lone rows keep their
    basename-only emphasis. The full absolute path stays one Ctrl+T away.

19. **Records of consequence.** Some bash rows change shared state beyond the
    working tree — a commit, a push, a PR merged or closed, an issue closed, a
    release or package published. Their invocation text says only what was
    *attempted*, and truncation may eat even that; the proof lives in the result,
    which one-line mode hides. So these rows earn **record facts** in the suffix,
    stated verb-first from the porcelain the tool actually reported — never from
    the command's arguments: `committed a4f21c9 · pushed main · 0.3k ch`,
    `merged PR #87 · 0.1k ch`. Rules:
    - **Output-only honesty.** A fact appears only when the command names the
      operation *and* its success porcelain appears in the output (`[main
      a4f21c9]`, `1c75c2a..50cf33f main -> main`, `Merged pull request #87`,
      `/releases/tag/v0.5.9`, `+ pkg@0.5.10`). A failed push after a good commit
      shows `committed a4f21c9` on a red row: committed, demonstrably not landed.
      `git tag` earns nothing — its success porcelain is silence.
    - **Facts chain in output order** with the family `·` separator;
      consecutive same-verb facts merge their data (`pushed main, v0.5.9`).
    - **The size cell keeps the rightmost berth** (§12.13/§12.15): records join
      *before* it, exactly as diff stats do, so the `ch` column stays aligned
      down the block.
    - **Overflow drops whole facts, oldest first** — records may take at most
      roughly a third of the row; a mangled sha is worse than none, and the full
      output stays one Ctrl+T away.
    - **The record verb is bold** — the trace row's white (§12.11): `committed`/
      `pushed`/`merged` pop from the dim wall exactly like a bash head command,
      which is what makes the cell visible at the right edge. Data and separators
      stay at the supporting grey; the size cell keeps its severity ink. Neutral
      bold even on a failed row — the fact states porcelain that *succeeded*;
      status stays on the bullet and the invocation's discriminators. (Amended:
      v1 rendered whole record cells dim, and the facts drowned in the very wall
      they were meant to punctuate.)

Tenth follow-up, same date (the "one bold head" review): in a chained invocation —
`cd X && printf 'HEAD '; git rev-parse HEAD` — only the first command word was bold,
which crowned the least informative command (usually `cd`) and hid the operative
ones; and trace bodies ran flush against the suffix column (a 1-space gap, despite
§5 specifying two) and against the terminal's right edge, so the block had no
stable right margin to scan along.

20. **Every command head is bold.** §12.9's head-word rule applies per command,
    not per invocation: the sequencing operators (`&&`, `||`, space-delimited `;`)
    and the flattened `↵` break each start a new command whose head word — the
    first non-assignment token — renders L0-bold, so
    `cd X && printf 'HEAD ' ; git rev-parse HEAD` scans as three commands rather
    than one `cd` with baggage, and a flattened script bolds each line's command
    (`set` ↵ `mkdir` ↵ `npm`). Pipes and redirects *continue* a command:
    `| head -240` is a filter, and §12.2's rejection of brightening filters
    stands. Heredoc bodies are inert — between `<<TAG` and its terminator line,
    no word is a head and no `↵` resets; those lines are data, not commands.
    Failed rows tint every head error (§12.14).

21. **The right edge is a margin, not a wall.** Trace rows render into a 2-column
    right inset mirroring the left gutter (§12.8): the block nests on both sides,
    and the suffix column never touches the terminal edge. The body↔suffix gap
    floor rises to the two spaces §5 always specified (the implementation had
    drifted to one), so a truncated tail stops crowding the facts. Block-shared
    cut columns (§12.17) are unchanged in kind — every truncated row in a block
    still ends flush at one column — that column now just breathes.

Eleventh follow-up, same date (a lone `+` drifted into the minus column): diff
cells joined their sides into one phrase and the whole suffix right-aligned, so a
plus-only `write … +18` ended flush where its neighbour's `-1` sat — signs
wandered row by row and the diff column stopped being vertically scannable.

22. **Diff stats are a table, not a phrase.** Within one visual block (§12.15's
    scope), the `+N`/`-M` cells form two sign-aligned columns: the block's widest
    added token sets the plus column, its widest removed token sets the minus
    column, and every diff cell pads to both — so every `+` shares one x and every
    `-` shares one x down the block. A dropped zero side (§12.13) stays dropped as
    *ink* but holds its column as *space*: `+18` next to a `-1` row renders
    `+18   ·` and `    -1 ·`, blank where the absent side would sit. The size cell
    after the diff pads left to the block's widest size cell, so the `·` separator
    holds one column too and §12.13/§12.15's rightmost berth is untouched. Rows
    without a diff cell are unaffected; a lone diff row pads to itself and renders
    exactly as before.

## Suggested implementation order

1. `_lib/style.ts` + `_lib/fmt.ts` additions, with tests (no visible change).
2. Traceline pass (sections 6 + conformance 1–4; issue #14 items 3/5 can ride along).
3. Contextimate pass (number grammar + methodology placement + proportion).
4. Cachemire pass (cheap once 1. exists; completed for the `0.4.0` package ship).

One PR per pass; goldens regenerated within the pass that moves them.
