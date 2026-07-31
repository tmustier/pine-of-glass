# The pine-of-glass design language

One visual grammar for the extension family: `pi-contextimate`, `pi-traceline`,
`pi-cachemire`, `pi-meantime`, and anything added later. This document is the contract and
`extensions/_lib` is its implementation. When a renderer and this document disagree,
one of them is wrong: decide which, then fix it.

This document states the current rules only. The reasoning behind each rule lives in
code comments next to its implementation; the history lives in git and the changelog.
Code and tests cite sections here as `§N` or `§N.M`.

## The family

The extensions answer adjacent questions about the same agent loop:

| | granularity | currency | question |
|---|---|---|---|
| contextimate | static prefix | estimated tokens | what am I carrying? |
| traceline | per tool call | exact chars | what did tools do? |
| cachemire | per model call or turn | exact provider tokens and dollars (estimated across a model switch) | what did the loop cost, and why? |
| meantime | per stream segment | exact wall-clock ms | what happened in the meantime? |

They should read as one instrument panel, not four apps that happen to share a repo.

## Principles

1. Skimmable first, auditable second. Optimise every surface for the half-second
   glance. State methodology, provenance and caveats once, in a dim place, never
   per row.
2. Quantities carry the eye. Right-align or column-align counts, in one number
   grammar, so magnitude compares down a column without reading.
3. Severity is colour, identity is glyph, content is neutral. Status lives in the
   one-character marker that opens a line. Body text stays in the neutral ink ramp.
   A wall of family output should look calm until something is wrong or big.
4. Honest tense and honest certainty. Estimates wear `~`; provider-reported numbers
   do not. In-flight statements are progressive with estimates; resolved statements
   are past tense with exacts. Match wording strength to evidence strength.
5. The theme owns the ink. All colour flows through `_lib/style.ts`, which derives
   from the active pi theme. No raw ANSI colour constants in extension code. Family
   identity comes from glyphs and layout, not from a brand colour.
6. Silence when healthy. A line appears when it informs a decision or flags an
   anomaly. No ambient chrome.

## 1. Glyphs

Every family-rendered line opens with a one-character marker in the 2-space gutter.
The marker identifies the kind of line. Its colour carries status. The body stays
neutral.

| glyph | meaning | used by |
|---|---|---|
| `›` | a tool action (one trace row) | traceline |
| `◍` | a loop-economics fact (clock, notice, ledger line) | cachemire, meantime |
| `▸` | an expandable or summarizable section header | contextimate (all modes) |
| `▏` | tool-block rail: the dim left edge of a run of trace rows | traceline |

The status scale is shared family vocabulary:

| glyph | meaning |
|---|---|
| `○` | cold / empty |
| `●` | hit / full |
| `◑` | partial |
| `◌` | miss / broken |

Auxiliary marks always render dim: `…` (truncation), `↵` (flattened newline),
`·` (U+00B7, the only inline fact separator).

Rules:

- one glyph per line, in the gutter, never inline mid-sentence
- the rail is block chrome, not a line kind: always dim, always the first visible
  mark of an indented trace block (§9.1), never a status carrier. A railed line
  still carries exactly one kind-glyph (`  ▏ › body`)
- new line kinds reuse an existing glyph when the kind matches; a new glyph is a
  design decision recorded here first. Meantime's tempo lines reuse `◍` under this
  rule: a where-did-the-time-go fact is a loop-economics fact in the time currency,
  spoken in the same instrument-panel voice as cachemire's clock and notices

## 2. Ink

Four levels, mapped to pi theme roles. Assign every piece of text a level on
purpose.

| level | role | carries | theme source |
|---|---|---|---|
| L0 | discriminator | verb or tool name, basename, bash head command, totals, panel brand | `text` + bold; brands and totals `accent` |
| L1 | content | operative values | `text` |
| L2 | secondary identity | descriptions, field types | `muted` |
| L3 | apparatus | methodology, directories, bash argument text, plumbing (`&&`, `2>/dev/null`), markers, units, causes | `dim` |

Status and severity tones apply to glyphs, quantity suffixes and native tool
metadata such as read `:line-range` spans. They never tint body prose.

| tone | meaning | theme source |
|---|---|---|
| success | completed / hit / fresh | `success` |
| warning | fading / closing / large / partial | `warning` |
| error | failed / broken / huge | `error` |
| running | in flight | no faithful theme role; `style.ts` falls back to ANSI blue (`accent` would collide with brand highlights, `warning` overloads "fading") |

A verb is L0 neutral bold and the `›` bullet alone carries success or running.
The exceptions are failure, which tints the row's discriminators (§9.2), and
record facts, which state real events rather than ambient status (§9.10).

The test of a good ink assignment is to squint. Only L0 and non-dim severity tones
should survive. If a wall of tool rows survives the squint at the same brightness
as assistant prose, the hierarchy is wrong.

## 3. Colour

- all ink goes through `_lib/style.ts`. No `\x1b[32m`, no hardcoded RGB in
  extension files. `style.ts` resolves tones against the live `Theme`, so light
  terminals and custom themes work
- the family accent is `theme.fg("accent")`. Use it sparingly: panel brands,
  highlighted token figures, total rows, the filled part of proportion bars.
  Recognizability comes from the glyph and layout grammar, which survives any theme
- family renderers do not synthesize backgrounds; trace rows are unbanded
- components that render before a `Theme` handle exists may use the raw fallbacks
  in `style.ts`; everything rendered after `session_start` has `ctx.ui.theme` and
  must use it

## 4. Numbers

One formatter family in `_lib/fmt.ts`, used by everyone.

| quantity | format | examples |
|---|---|---|
| counts | fixed k-unit, one decimal (`0.0k` to `999.9k`); one-decimal M at 1M and above | `0.1k`, `52.3k`, `9.1M` |
| chars | count + ` ch` (`formatChars`) | `0.4k ch`, `35.2k ch` |
| tokens, estimated | `~` + count + ` tokens` (the unit word may drop in columns) | `~0.1k tokens`, `~14.2k tokens` |
| tokens, provider-reported | count, no `~` | `64.1k tokens` |
| money | `$` two decimals (three below $0.10, where the third digit is significant); `~` when projected | `$0.052`, `$17.03`, `~$2.67` |
| duration | compact mixed units, no spaces | `14s`, `4m30s`, `9h50m` |
| latency, sub-10s | one-decimal seconds; the decimal is significant at first-token scale | `1.9s`, `9.6s` |
| rate | integer + ` tok/s`; `~` when estimated from streamed chars, none when derived from provider usage | `~55 tok/s`, `48 tok/s` |
| share | integer percent in parens; one decimal only for context-window usage | `(97%)`, `32.2% / 200k ctx` |

Rules:

- one unit everywhere. Counts never switch between raw integers and k-units:
  `0.1k ch` and `35.2k ch` compare at a glance; `133 ch` and `35.2k ch` do not.
  `0.0k` is acceptable noise; mixed units are not. M is the only step-up, at 1M
  and above, where k becomes unreadable (`9.1M`, not `9100.0k`)
- the `~` is semantic, not stylistic: estimated wears it, provider-reported does
  not. Never add it for symmetry or drop it to save a column
- bare counts (no unit) are allowed only directly after a labelled verb where the
  unit is unambiguous: `read 150.3k · wrote 1.8k`

## 5. Layout

- gutter: 2 spaces, the glyph, 1 space, the body
- quantities sit right: a right-aligned dim suffix with a gap of at least 2 spaces,
  or a column-aligned field. Never woven mid-sentence when the line is a row in a
  list
- inline facts are `·`-separated, in the order: what happened · how big · share ·
  cost · cause. Cause comes last and renders dim
- methodology appears once per panel: a dim line under the panel header, never on
  data rows. Data rows carry at most a raw size in parens: `(9.2k ch)`
- blank lines: one before a group, none within it
- tildify home paths; middle-truncate long lines, protecting the tail
- ink survives the cut: `middleTruncate` replays the active SGR state after the
  ellipsis, so a cut inside a styled span never leaves the tail in default ink

## 6. Severity

Anomaly thresholds tint the quantity suffix or the glyph, never the body:

- tool result size (traceline): dim below 10k ch, warning from 10k ch, error from
  50k ch. Thresholds live in `style.ts`, overridable through the family config
  convention (`~/.pi/agent/pi-<name>.json`, `<cwd>/.pi/pi-<name>.json`)
- cache materiality (cachemire): notices only above $0.05 or 20k re-written
  tokens; silence when healthy
- severity colour is reserved for exceeded thresholds and real states. Nothing is
  tinted for visual interest

## 7. Wording

- tense: in-flight statements are progressive with `~`
  (`cache breaking · re-writing ~138.2k`); resolved statements are past tense with
  exacts (`cache broke · re-wrote 138.2k`)
- a resolved post-compaction notice compares provider-exact cache reads with the last
  normal agent prompt before compaction: `cache after compaction · reused 34.9k of the
  last pre-compaction 72.5k prompt (48%) · processed 39.1k uncached`. The share uses that
  earlier prompt as its denominator. `reused` means the provider read an unchanged
  prefix from that earlier cache lineage; it does not mean the compaction summary used
  that prefix or retained that many semantic conversation tokens. The uncached count is
  ordinary input plus explicit cache-write input: everything in the new prompt that was
  not a cache read. It therefore carries no share. If the model also changed,
  withhold the prior count and share rather than compare tokenizers
- after tree navigation, the cache baseline follows the selected branch, not the
  abandoned leaf. Use the last provider-billed prompt on the selected path as the
  expected reusable prefix. A later request refreshes that baseline only when session
  ancestry and its provider, model, cache window and payload fingerprint prove
  compatibility. The
  intentional suffix divergence is therefore ordinary prefix growth, not a suppressed
  mutation; withhold a divergent-tail estimate until provider usage makes it exact
- a model switch re-prices the conversation; the wording leads with the consequence
  (the whole prompt goes uncached to the new provider) and then explains it:
  `cache cold expected · model switched · next send ~32.4k uncached to anthropic
  (20.7k +13.8k tokenizer -2.1k dropped thinking · est)`. The headline is the
  estimated first prompt in the target model's currency. The parenthetical starts
  from the source model's last billed prompt and explains the change as signed terms
  in diff-stat style (§9.7): `tokenizer` is the re-count of retained content,
  computed as the residual on display-rounded values so the terms always sum to the
  headline, and `dropped thinking` is the source-billed encrypted reasoning the
  target never receives, priced at the source's measured density. Zero terms drop
  out like a diff stat's zero side. The breakdown appears only when a billed source
  anchor calibrated the estimate inside the trusted correction bounds (a saturated
  clamp bounds the number without explaining it); otherwise the line degrades to `next send ~32.4k
  uncached to anthropic (est)`, and gateway routes stay `(rough est · gateway
  route)` with no breakdown. The send-time notice keeps the grammar in progressive
  tense: `cache breaking · sending ~32.4k uncached to anthropic (20.7k +13.8k
  tokenizer -2.1k dropped thinking · est · ~$0.41) · cause: model switched
  openai-codex/gpt-5.6-sol → anthropic/claude-fable-5`; the resolved line stays
  past tense and provider-exact (`cache broke · re-wrote 28.2k …`)
- certainty ladder: contract-backed evidence gets definite words (`cache cold`);
  a documented band gets hedged words (`cache fading`); an unknown provider gets
  `likely`. Never write definite words on soft evidence
- status one-liners are lowercase; Title Case only for panel headers and row labels
- state causes from observed evidence (payload diffs, usage), never inference,
  and say `unknown` when unknown

## 8. Panels

Panels are multi-line surfaces with a top: contextimate's estimator, cachemire's
`/cache` ledger. They share one header form:

```
[Contextimate] summary → compact → expanded
  ctrl+o: cycle view · model anthropic/claude-opus-4-8 · counts ch ÷ 2.6 (Claude 4.7+ heuristic)
```

- line 1: the extension name in bold accent, plus mode pips when the panel has
  modes (active mode accent-bold, others dim, `→` dim). Panels brand with the
  extension name (`[Contextimate]`, `[Cachemire]`), not a descriptive title;
  description belongs in the hint line
- line 2: a dim hint line carrying the keybinding, scope or profile, and the
  panel's methodology, once

Where a total has a meaningful budget (the context window), show share: a percent
column and/or one stacked bar. Bars use `█`/`▒`: accent for the carried part, dim
for free.

```
  Total request   64.1k tokens (32.2% / 200k ctx)
  ████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  harness 14k · session 50k · free 136k
```

A panel ends with one blank line, so the next chat block never abuts it. This is
§5's "one blank before a group", supplied by the panel because pi does not.

A residual is an accounting gap, not a diagnosis. Contextimate calls it
`Unattributed`, never `reasoning`, and labels it `(accounting gap)`. Provider-reported
reasoning retained by the response anchoring Pi's total gets an exact `Reasoning
context` row, including a reported zero. Exact counts accumulate only across history
matching the active provider, API and model when that route preserves prior thinking.
Returning to an earlier model can resume its matching history; current-turn policies stop
at the user boundary. Historical reasoning must fit inside the exact reported prompt total
across input, cache reads and cache writes. Provider-generated summaries
not covered by exact retained reasoning get a separate estimated `Thinking summaries`
row; opaque signatures are never sized as reasoning.
The remaining gap can still include prefix-estimation error, provider overhead, images,
opaque replay carriers and reasoning when no breakdown was reported. If Pi's context
total includes local estimates for messages after the last provider usage, the total
keeps its `~`.

In expanded audit views:

- a tool entry renders its name L0 bold with provenance beside it, dim and short:
  `scope · path` (tildified; builtins collapse to the single word `builtin`). The
  defining path is the audit trail; origin URLs and package refs add nothing
- parameter name, type and required columns align across the whole block, so the
  section reads as one table rather than a stack of ragged mini-tables

## 9. Trace rows

Traceline collapses each tool call to one line. These rules make a run of those
lines read as one calm block: dim apparatus, bold discriminators, status accents.
Nothing in a trace row shares ink with assistant prose. The full invocation and
output stay one zoom away (§9.12).

### 9.1 The block

- every trace row opens with the dim `▏` rail, and consecutive rows fuse into one
  visible block. Visible prose breaks a block, and so does a collapsed thinking
  preview; invisible connectors do not
- the block nests: 2 spaces, the rail, a space, then the standard glyph gutter
  (`  ▏ › body`, six visible columns). The margin belongs to narrative; tool
  machinery indents beneath the line that motivated it
- the right edge mirrors the left: rows render into a 2-column right inset, and
  the body-to-suffix gap is at least 2 spaces, so the suffix column never touches
  the terminal edge
- one blank line before a group; a row sits tight under the collapsed `Thinking…`
  line that motivated it, so each thought-action couplet reads as one unit

### 9.2 Status

- the `›` bullet alone carries success or running. Verbs render neutral bold, so
  healthy columns are never green
- a failed row tints its whole discriminator set (verb, bash heads, basename) in
  error ink, still bold. Supporting text stays dim; healthy rows are untouched

### 9.3 Bash ink

Bash rows speak the same grammar as path rows:

- the bold `$` anchors the row at L0
- head command words render bold, like basenames: `$ rm`, `$ npm`, `$ python3`
  scan like `read file.ts`
- everything else (arguments, connectors, redirects, marks) sits at the one dim
  supporting grey shared with directories and size suffixes. There is exactly one
  supporting grey; a second "slightly different" grey reads as inconsistency, not
  hierarchy
- bold is the trace row's white: plain prose-weight text never appears inside a
  trace row
- multiline commands flatten into the one line, with a dim `↵` marking each
  original break; the boilerplate `(timeout Ns)` suffix drops
- fallback rows (tools without a renderer) dim their argument text the same way

### 9.4 Crowns

A crown is the bold head word of one command inside a bash row. The crown rules
are validated against a corpus of 51k real invocations
(`scripts/dev/bash-corpus/`), not intuition:

- every command gets a head candidate: `&&`, `||`, `;` (attached or
  space-delimited) and flattened `↵` breaks each start a new command whose first
  non-assignment token is its head
- pipes and redirects continue a command: `| head -240` is a filter and stays
  dim. Brightening a single "operative segment" was considered and rejected: a
  pipeline tail is as often a filter as the point
- sequencing reads the shell, not the spacing: the head hunt tracks quote state,
  so a sequencer or `↵` inside an open quote is data. `python3 -c '…'` crowns
  `python3` once and nothing inside the string
- heredoc bodies are inert: no heads, no quote tracking, so an unbalanced
  apostrophe in heredoc prose cannot silence the commands after the terminator
- a head must carry a word character: a lone quote, `[` or `{` is shell
  apparatus. It renders dim and consumes the head slot, so a following filter
  cannot inherit the crown. After a `↵`, a flag token is a continuation and
  consumes the slot the same way, while a block keyword (`do`, `then`, `else`,
  `fi`, and kin) passes the crown through to the real head that follows. The
  miss is deliberately conservative: under-brightening is the family's bias
- the crown is rationed to commands that inform. Two vocabularies demote:
  preambles (`cd <dir> &&`, `set -…`) are situating throat-clearing, and
  plumbing (`echo`, `true`, `false`, `printf`, `exit`) is flow-control glue
  (`|| true`, `&& echo done`). A preamble or plumbing head renders headless
  whenever any real command in the row wears a crown; selection is row-global,
  not left-to-right. A row that is nothing but preamble and plumbing keeps its
  first operative head (plumbing before preamble), so no row goes dark.
  Classification reads through parentheses, so a subshell edge cannot smuggle
  glue past the vocabulary
- dim is not enough: a demoted preamble still spends width, and the shared
  truncation budget (§9.8) then eats the real command behind boilerplate that
  carries no signal (`set -euo pipefail ↵ cd <dir> ↵` alone runs two-thirds of a
  row). So a row's *leading preamble run* (the opening sequence of situating
  segments, `set -…` hygiene, `cd <dir>`, and bare `VAR=…`/`export`
  assignments, across `&&`, `;` and `↵` breaks) is reclaimed, not just dimmed:
  - a leading `set -…` hygiene run drops outright, the way the `(timeout Ns)`
    suffix does (§9.3): errexit/pipefail/nounset never discriminate one row from
    another, and the status bullet already carries the outcome. The drop is
    scoped to the *leading* run, so an interior `set` stays
  - the remaining situating context (`cd`, assignments) folds to a dim `⋯` when
    it repeats the previous bash row's context, whatever separator either row was
    written with. The `⋯` stands in for the whole run and its trailing separator
    (`⋯ npm test`, never `⋯ && npm test`), neither crowns nor consumes. It is
    block-scoped: a `⋯` never points across visible prose, and never lands on a
    row with no real command after it; that row keeps its context, so no row
    goes dark. A distinct context prints once, on its first appearance

### 9.5 Path rows

Read, edit and write rows dim what is boring and bolden what discriminates:

- the dim zone is the row's longest boring prefix: the block's common directory
  prefix (when at least two segments deep) or the row's cwd prefix, whichever is
  longer. Everything past it renders bold, divergent directories included. A lone
  row's boring prefix is its whole directory, so single calls keep the
  basename-only emphasis
- a path under the row's cwd collapses to a dim `./` plus the cwd-relative tail.
  Paths outside cwd keep their tildified absolute form; the asymmetry is itself
  information (in-repo against out-of-repo). `./` counts like `~` for emphasis:
  alone it is a trivial root marker, while `./src/` is a meaningful shared prefix
- Pi's compact `read docs <path>` and `read resource <path>` forms keep their
  useful classification word as dim apparatus, but the displayed path follows the
  same dim-prefix and bold-discriminator grammar as every other file read. A compact
  classification must not make one filename accent-coloured while its neighbours are
  neutral
- read `:line-range` spans stay warning-coloured, so scoped file reads remain
  visible
- edit and write rows carry their `+N -M` diff inline on the basename the same
  way, add-green / remove-red with the zero side dropped (§9.7). The magnitude
  rides the file it changed instead of drifting to a right column, and both
  qualifiers survive truncation as the protected tail (§9.8). A mutation therefore
  carries no size cell (its result is a confirmation, near-noise) and opts out of
  the block's fact columns (§9.7)

### 9.6 Native rows

Rows for other tools (`grep`, `web_search`, `fetch_content`, `mcp`, and kin)
reuse pi's native invocation line. Spans the native renderer left unstyled demote
to L3-dim; spans pi deliberately coloured (patterns, ranges, backticks) and
bold-only spans survive untouched. §9.3's "bold is the trace row's white" holds
for every tool, not just the hand-rebuilt rows.

### 9.7 Fact columns

The right-aligned suffix carries facts in columns that align down the block:

- a fact suffix must carry a fact: the char suffix is omitted below 100 ch, and
  a diff stat drops its zero side (`+2 -0` renders `+2`; `+0 -3` renders `-3`)
- columns are block-scoped: if any completed row in a block clears the floor,
  the size column is live and every completed row shows its cell, dim `0.0k ch`
  included. Inside a live column a blank is a misalignment, not a calm. A block
  with no row above the floor (a `mkdir`/`rm` cleanup run) shows nothing
- file-mutation diffs are not a suffix column: an edit/write carries `+N -M`
  inline on the basename (§9.5) and opts out of the size and diff columns, so a
  mixed read/edit block shows sizes on its reads and inline diffs on its edits,
  each row ending where its own fact does. A ragged right edge here is a legible
  asymmetry (reads flooded context, edits did not), not a misalignment. A rare
  non-mutation tool that reports a diff still right-aligns it in the suffix
- the size cell keeps the rightmost berth. A record row (§9.10) suppresses its
  size cell as noise unless the output reaches warning severity (§6): its result
  is porcelain about the event, not pulled context, but an output that balloons
  is a story of its own and re-earns the cell
- a row whose result carries an image block shows an image fact in the size
  cell's berth instead of a char count: `png 1044×646`, dim. The text note
  beside an image read is near-noise; counting only its chars claims the
  result was tiny when the model actually received the pixels. The image fact
  names what was pulled without pretending to know its token cost. It occupies
  the size cell for column alignment but does not light the block's size
  column: it is a what-fact, not a how-big-fact

### 9.8 Truncation

Truncation columns are deterministic and block-scoped. Every row in a block
shares one body budget: the width left after the block's widest fact suffix. A
truncated row cuts at exact columns: the head fills its share, a dim `…`, then a
tail of the reserved width, ending flush where the suffix column begins. Cuts are
measured in terminal columns, never characters. A wide grapheme (emoji, CJK)
straddling a cut is dropped whole and its vacated cell becomes padding, so the
row stays on the exact grid and can never overflow. Rows that fit their budget
simply end early, like prose. A mid-token cut beside a dim ellipsis is legible;
a wandering ellipsis column is not.

### 9.9 Repetition folds

Identical compact invocations within one assistant step fold into one row with a dim
count: `mcp call linear_save_issue ×22`. The visible invocation is the key, so calls
with different hidden arguments may fold; calls from separate steps never do. Folded
rows sum landed result sizes and use the worst status: error, then running, then
success. Expanded rows split folds. Reads, file mutations, image results and record
rows stay separate because their row-specific facts matter. Ctrl+T restores native
rows.

Consecutive reads use a richer fold at two granularities sharing one grammar (both
adopted against a 400-session corpus of real transcripts, per §10):

- paginated reads of one file merge their ranges:
  `read …/index.ts:1-200,201-400 · 2 calls · 37.0k ch`
- consecutive reads of sibling files (the same exact directory) fold into one
  dir row: the shared directory prints once, then the basenames follow as a
  bold list with dim commas, each wearing its own warning `:ranges` (adjacent
  same-file calls merge their ranges first):
  `read ./extensions/pi-traceline/ index.ts:1-120, path-rows.ts · 3 calls · 15.8k ch`.
  The directory cell keeps §9.5's grammar: the block-scoped boring prefix is
  dim and a divergent dir tail stays a bold discriminator
- the fold compresses only the boring: a file whose combined result reaches
  warning severity (§6) keeps its own row (itself a pagination fold when it
  was paged) and splits the run, exactly as an error row does. What ballooned
  must stay visible in the size column; what folds is genuinely routine
- runs break on anything visible between the reads (prose, a collapsed
  thinking preview, another tool) and never reorder the transcript. Ctrl+T
  restores the individual native rows
- a dir fold that overflows the block's body budget (§9.8) wraps at file
  boundaries instead of truncating: dropped basenames would make the fold
  lossier than the rows it replaced. Continuation lines keep the rail but not
  the bullet (one entity, one bullet) and indent to the directory cell's
  column; a wrapped line ends with its dim comma, so the entity visibly
  continues. The `N calls · size` suffix stays on the bullet line, keeping the
  block's fact column aligned against bullets. A lone cell longer than a line
  still middle-truncates; wrapping never cuts mid-name
- the folded row speaks the block's shared suffix grammar; its `N calls · size`
  cell counts as its fact suffix in the block's reserve (§9.8)

### 9.10 Records

Some bash rows change shared state beyond the working tree: a commit, a push, a
PR merged or closed, a release or package published. Their invocation says only
what was attempted; the proof lives in the result, which one-line mode hides.
A row whose output carries that proof graduates to a verb-led outcome row: the
record leads, stated verb-first from the success evidence the tool actually
reported. The command may identify an explicit target only when the output's
success evidence is targetless and the same row includes an explicit verification
command, such as `gh pr view 826 --json state` returning `MERGED`; the outcome
still never comes from arguments alone. The command trails as provenance behind
its `$`: `pushed main $ git push`, `merged PR #87 $ gh pr merge 87 --squash`.

- the record is the headline because, once landed, the outcome is the row's
  identity: it joins the verb-first family (`read`, `edit`, `write`, `$`), so
  the left column scans as what happened. The `$` keeps its promise that what
  follows ran in a shell, which is why a record may never sit between `$` and
  the command (`$ pushed main git push` reads as a command named `pushed`)
- the headline survives truncation: the middle cut (§9.8) lands in the command,
  never in the record
- a record row's size cell is suppressed (§9.7): the record is the row's story,
  and a confirmation's length is not. At warning severity (§6) the cell
  re-earns its berth
- a bash row with no record keeps `$ command` at the left edge: rows lead with
  an outcome exactly when there demonstrably was one
- output-first honesty: a fact appears only when the command names the operation
  and success evidence appears in the output (`[main a4f21c9]`, `main -> main`,
  `Merged pull request #87`, or a verified `MERGED` PR state). A failed push
  after a good commit still headlines `committed a4f21c9` on a red row:
  committed, demonstrably not landed. `git tag` earns nothing; its success
  porcelain is silence
- facts chain in output order with the `·` separator; consecutive same-verb
  facts merge their data (`pushed main, v0.5.9`) only when their tones agree,
  so a forced push never hides inside a routine one
- overflow drops whole facts, oldest first. Records take at most about a third
  of the row, so the command keeps its width; a mangled sha is worse than none
- records wear the ink of what they state: the cell renders success-toned bold,
  verb and datum together (`pushed main`, `released v0.5.9`), because a refname,
  tag or PR number is the event's identity. A commit sha stays dim beside its
  bold verb: a sha is copy-paste material, not news. A forced push tints
  warning; git's porcelain says it is a riskier state. The tone is per fact,
  not per row: red discriminators beside a green `committed a4f21c9` is the
  loudest and most honest rendering, exactly when state changed before a failure

Rarity keeps records on the right side of principle 3: a handful of green events
punctuate the wall; ambient green stays purged.

### 9.11 Collapsed thinking

A collapsed thinking run is exactly one display line. Every non-empty source
line from every adjacent thinking block is converted to plain inline text and
appended after `Thinking:`, separated by ` · `. Source newlines and Markdown
paragraph boundaries never become display rows. Empty or whitespace-only
thinking fragments do not render and do not break the run.

The line middle-truncates at the terminal width, preserving both its opening
context and the newest appended thought. Pi's native run label becomes that one
preview; extra labels and spacers from older label-per-block Pi versions also
disappear. Any non-thinking content entry, including text, a tool call or
another semantic block, ends the run and keeps the native boundary before the
next one-line preview. A non-empty run that cannot yield sanitized text keeps
one native label. Native `Thinking...` labels with no matching content metadata
retain the safe duplicate-label fallback.

With traceline loaded, Ctrl+T's effect is self-evident: every tool row collapses
to a trace line or expands back. So traceline suppresses pi's
`Thinking blocks: hidden/visible` status caption before it renders. The
suppression is surgical: only that exact text at the chat tail matches. Every
other status message announces an otherwise invisible action and passes through.

### 9.12 The zoom ladder

A trace line is the surface of a three-step ladder, and every deeper step
renders with pi's own machinery, so each zoom looks exactly like the view it
borrows from:

- z0, trace: the one-line row. The default whenever reasoning is hidden
- z1, expanded: pi's native tool row with full invocation and output, still
  without reasoning. Ctrl+O (pi's tools-expand keybinding) toggles it globally;
  drill mode (§9.13) pins it per row. Both write pi's own per-row `expanded`
  flag, so there is exactly one expansion state and it cannot desync
- z2, native: Ctrl+T shows reasoning and native tool rows, untouched by
  traceline

Ctrl+T is decisive over z1: when Pi's global Ctrl+O expansion is active,
Traceline first collapses that expansion, then lets Pi's native reasoning toggle run.
This guarantees that the next hidden-reasoning view is z0 rather than remaining pinned
at z1. Ctrl+O can expand the rows again whenever z1 is wanted.

An expanded row opts out of trace-block grammar: it breaks the rail block
(§9.1), leaves its neighbours' fact and truncation columns (§9.7, §9.8), and
never participates in a read fold (§9.9); a trace block that follows one starts
with its own blank line. Collapsing back restores all of it. Expansion is the
one deliberate reflow in traceline: an expanded row grows in place and the
transcript moves to make room. The zero-reflow surfaces are z0 and drill
mode's numbering.

### 9.13 Drill mode

Drill mode answers "show me that row" without leaving the transcript: the live
transcript is the picker, and every zoom target is named by a number in the
row's own gutter.

Entry and exit:

- `alt+t` (configurable via `drillKey` in the family config) or `/drill`
  enters; esc exits. Entering swaps the editor for a two-line hint bar in the
  §8 header form (`[Traceline] drill · row 1 of 37` plus one dim key-hint
  line); the editor draft is restored on exit
- the transcript does not reflow: numbering re-inks the prefix of rows already
  on screen, and one line stays one line
- the mode owns only its documented keys, all unmodified. A modifier chord it
  does not understand (option+up, option+enter, ctrl+c, …) exits the mode at
  once, from the hint bar or the pager alike, and is not consumed: pi restores
  the editor synchronously, the same keystroke lands there, and it does what
  it always does. Drill never silently eats a chord that means something
  outside it. Re-pressing the entry chord therefore re-freezes the numbering
  through its own shortcut, and a key release never exits

Numbering:

- the number cell replaces the rail at identical width: the six-column prefix
  (§9.1) becomes a right-aligned number in the first three columns, a space,
  the row's `›` bullet with its status ink, a space
- 1 is the most recent visible target, counting up into history. A folded read
  run (§9.9) is one target with one number; a multi-line dir fold wears it on
  the bullet line, and its continuation lines keep the plain rail. Numbers
  freeze on entry; rows that stream in during drill mode render as plain
  unnumbered trace rows
- an expanded row (§9.12 z1) takes its number on the blank spacer line pi
  renders above the native row, in the same cell grammar; if that line is
  missing, the row stays selectable but shows no number. Rows past 999 keep
  the rail
- the selected row's number wears accent bold; every other number is dim.
  Selection is a legitimate accent use under §3's "sparingly": exactly one
  cell wears it, and only inside an explicitly entered mode

Selection:

- digits type a number, which commits the moment no longer valid number could
  follow (`5` opens instantly when 37 targets exist; `1` waits for a second
  digit or enter). Backspace edits the buffer, enter forces the commit
- `j`/`k` and the arrow keys step through targets in transcript order; enter
  peeks the selection
- `p` toggles the selected row's expansion (§9.12 z1) in place

The peek pager:

- enter (or a committed number) opens a full-screen overlay pager. The
  transcript beneath is untouched, and esc returns to identical pixels
- the pager is a §8 panel: a `[Traceline] peek · row 3 of 37` brand line, one
  dim hint line, then the row's own trace lines as the anchor, the full
  invocation, and the complete result, each section under a dim label. A
  folded read run renders one invocation and result section per call
- the pager is the fidelity surface: everything the model saw, the reader can
  see here. The trace line may truncate and the transcript may fold, but the
  pager never shows less than the call and result the model exchanged
- the invocation section uses pi's call renderer with its real newlines when
  the tool has one. A tool without a call renderer (papercut, MCP tools, most
  extension tools) renders its complete arguments instead: the tool name, then
  one aligned `key  value` row per argument (keys dim in one left-aligned
  column, string values verbatim with wrapped continuations hanging at the
  value column, nested objects as indented JSON). The arguments are the
  invocation; a bare tool name is not
- every result block is accounted for. Text blocks render complete. An image
  block always renders its fact line, `image · png · 1044×646 · 65.6k bytes`
  (§4 grammar: what, then how big), and on a terminal whose capabilities
  support inline images it renders the pixels too, mirroring pi's own native
  tool row: the row's `showImages` setting is honoured, and kitty PNG
  conversions already made by pi's row are reused rather than redone. Any
  other block type renders its type and what metadata it carries, never a
  bare bracket
- a text result that is provably code renders as code, ink-only: the text is
  untouched. A read whose path names a code language gets pi's own syntax
  highlighter (theme-derived), a dim right-aligned line-number gutter counting
  from the call's offset, and a language cell on the result label. A wrapped
  code line's continuations keep a blank gutter cell and hang under the code's
  own indentation, so wrapping never destroys the shape of the code. A bash
  result earns the same ink, without the gutter, only when its command is one
  plain `cat`/`sed`/`head`/`tail` of a single code file with no pipes, chains
  or redirects: highlighting is a claim about what the text is (§7), and
  anything less certain stays plain
- an inline image is atomic under scrolling. The pager scrolls by line
  windowing, but a terminal image escape sequence cannot be sliced: an image
  renders its pixels only when its full cell block lies inside the viewport;
  a partially scrolled image shows its dim fact line in place (`scroll to
  view`), never a clipped or overdrawn image. Images are sized to fit the
  viewport so full visibility is always reachable
- kitty image ids allocated by the pager are deleted when it closes, the same
  bounded lifecycle as drill-mode mouse reporting: the mode cleans up every
  terminal-state side effect it created, on exit and on shutdown
- `j`/`k`, the arrows, page keys and `g`/`G` scroll; `h`/`l` and left/right
  move to the neighbouring numbered target without closing; `p` toggles
  expansion; digits jump; esc, enter or `q` closes back to drill mode

Mouse:

- the live transcript never owns mouse reporting: enabling it breaks terminal
  text selection for the whole session, so z0 stays keyboard-and-scrollback
  native. This is a hard rule, not a phasing decision
- drill mode is a bounded exception: SGR mouse reporting is enabled on entry
  and disabled on exit, on session shutdown and on process exit. The wheel
  moves the selection (wheel up walks older rows); inside the pager it
  scrolls. Every other mouse event is swallowed, never leaked to the editor.
  `"drillMouse": false` in the family config opts out

## 10. Tempo facts

Meantime decomposes the loop's wall-clock: where the time went, and why. Its lines
are loop-economics facts (`◍`, §1) in one currency, milliseconds measured at event
boundaries, and the honesty rules (§4, §7) apply with full force because time is the
surface users feel most and can verify least.

### 10.1 Measurement honesty

- every duration is an event-boundary observation from this process: request sent,
  first typed content event, stream segment starts and ends, tool execution starts
  and ends. Nothing comes from provider-reported timing (none exists), and nothing is
  reconstructed from session history: message timestamps cannot yield first-token
  latency or segment splits, so a resumed session's earlier calls are simply not
  timed. The panel hint says so once
- time to first token is measured at the harness boundary (request sent to first
  typed content event) and bundles network, queue, and prefill. It is one number on
  purpose: the split is not observable, so no split is claimed. Prefill work is
  still nameable as a cause from usage evidence (uncached prompt tokens)
- rates wear the §4 grammar: a live rate is estimated from streamed chars through a
  chars-per-token ratio and wears `~` in progressive tense; a resolved rate is
  provider output tokens over the observed stream span, exact, past tense. The live
  ratio self-calibrates: each resolved call's streamed chars over output tokens
  replaces the default for that model. Calls with silent reasoning are excluded from
  calibration and show no resolved rate: their streamed chars undercount output and
  their hidden generation has no observable start boundary
- a silent pre-text gap is `waiting`, never `thinking`, until usage confirms
  reasoning tokens (§7: no definite words on soft evidence). A resolved call whose
  usage reports reasoning tokens but whose stream carried no thinking blocks marks
  its wait as including silent reasoning rather than inventing a thinking span
- parallel tools report wall-clock (the interval union), never a sum of durations;
  overlap is noted, not double-counted. Live tool time uses the same interval union,
  excluding harness gaps before and between executions

### 10.2 Segments

A model call decomposes into wait (request to first content), thinking (streamed
thinking spans), and writing (streamed text and tool-argument spans; both are the
model emitting output tokens). After the call come the tool phase (wall-clock across
the executions that follow it) and the harness gap (call end to next request, minus
tool wall-clock): the invisible tax of pi plus extensions. Segment spans run from
typed stream events; stalls inside a segment belong to that segment. The columns do
not claim to sum to the call's total: unattributed stream stalls exist and are not
invented into a bucket.

Out-of-run time is idle (agent settled to next agent start). Idle is a first-class
bucket, not noise; it is often the session's punchline.

### 10.3 Surfaces

- the live widget is one `◍` line above the editor showing the current phase and its
  elapsed time: `waiting · 12s`, `thinking · 42s · ~55 tok/s`,
  `writing · 8s · ~48 tok/s`, `tools · 31s · 2 running`. It renders in running ink,
  turning warning once the wait passes the slow-start bar, and hides when the loop
  is idle (principle 6: pi's footer already counts elapsed time; the widget exists
  to decompose an active wait, not to be a clock)
- anomaly notices are chat lines appended at resolution: past tense, exact numbers,
  cause last and dim (§5), `cause unknown` when unknown (§7):
  `slow start · first token 14s (median 1.9s) · cause: prefill 138.2k uncached prompt tokens`
- baselines are relative and per model: the rolling median of this session's
  resolved values. Absolute thresholds lie across models and prompt sizes; a notice
  needs a minimum number of resolved samples plus an absolute floor, so short
  sessions and ordinary variance stay silent
- `/pace` renders the panel (§8): one aligned row per call (ttft, think, write,
  tools, total, out, tok/s; absent facts render `—`), a totals row, and one session <!-- agent-lint-disable-line POG007 -->
  line with a `█▒` share bar of active (accent) against idle (dim). A mixed-model
  ledger says how many models it contains and marks each model transition on its row

## 11. Changing the language

- design changes are decisions: record them here first, then implement
- goldens are the visual regression net. Regenerate with `UPDATE_GOLDENS=1
  npm test` and review the diff like code. Test design notes: docs/testing.md
- judge bash-ink rules against real usage, not intuition:
  `scripts/dev/bash-corpus/` replays 51k real invocations through the live
  pipeline and reports what wears the crown. Run it before and after a rule
  change and diff the censuses

## Appendix: old section numbers

This document was rewritten on 2026-07-04 from a layered amendment log into the
current-state rules above. Sections 1 to 7 kept their numbers. On 2026-07-10 the
tempo-facts section (meantime) took the §10 slot and "Changing the language" moved
from §10 to §11; citations of "§10 (goldens/design changes)" written before that
date mean today's §11. The changelog and
old commit messages cite the retired sections; they map as follows:

| old | new |
|---|---|
| §8 (style.ts sketch), §10 (testing) | the code and docs/testing.md |
| §9 (conformance lists), §11 (resolved questions) | folded into §1 to §8 |
| §12.1, §12.14 | §9.2 |
| §12.2, §12.9, §12.11 | §9.3 |
| §12.3, §12.8, §12.21 | §9.1 |
| §12.4, §12.16, §12.18 | §9.5 |
| §12.5, §12.6, §12.7 | §8 |
| §12.10 | §5 |
| §12.12 | §9.6 |
| §12.13, §12.15, §12.22, §12.27 | §9.7 |
| §12.17 | §9.8 |
| §12.19, §12.28 | §9.10 |
| §12.20, §12.23, §12.25, §12.26 | §9.4 |
| §12.24 | §9.11 |
