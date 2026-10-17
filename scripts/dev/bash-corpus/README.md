# bash-corpus: measure the crown grammar against real sessions

Traceline's bash head-bolding rules (design language §9.4) are judged
against real usage, not intuition: this rig harvests every bash tool invocation from
local pi session logs and replays it through the *live* ink pipeline
(`fitBashLines`), then reports what wears the crown.

## Recipe

```bash
# 1. Harvest (~1 min over a few GB of session logs; reads ~/.pi/agent/sessions)
node scripts/dev/bash-corpus/extract.mjs

# 2. Census: crown totals, per-row histogram, top-40 crowned words
node scripts/dev/bash-corpus/report.ts

# 3. Eyeball: deterministic sample of rendered rows (real ANSI)
node scripts/dev/bash-corpus/report.ts --samples 25 --seed 11
```

Comparing a rule change: run the report before and after the edit with distinct
`--census` (and optionally `--dump`) paths, then diff the two censuses; `--dump`
writes per-row crown lists so row-level regressions can be joined and inspected.

```bash
node scripts/dev/bash-corpus/report.ts --census out/census-before.json --dump out/crowns-before.jsonl
# ... edit extensions/pi-traceline/bash-crowns.ts ...
node scripts/dev/bash-corpus/report.ts --census out/census-after.json --dump out/crowns-after.jsonl
```

## What to look for

- **Crowns per row** should stay low and tight; a healthy wall averaged ~2.4 after
  the §9.4 pass (down from 3.30 under the crown-everything rule).
- **The top-40 crowned words should read as a command census** (`git`, `python3`,
  `rg`, `gh`, `tmux`, ...). Glue in the top ranks (`echo`, `true`, `cd`, `set`,
  `done`, `-H`, `const`, tokens with stuck punctuation like `true)`) is the smell
  that motivated the corpus review in the first place.
- **Zero-crown rows** should stay near zero (§9.4: no row goes dark).

## Records

Traceline's records (design language §9.10) are judged against real *results*, not
just commands: a record is only as good as the porcelain it reads.

```bash
# 1. Harvest git/gh/npm calls with their results (~30 s over ~20 GB of session logs)
node scripts/dev/bash-corpus/extract-results.mjs

# 2. Census: rows per record and evidence source, with examples
node scripts/dev/bash-corpus/records.ts --samples 3
```

Adding an entry: write it in `extensions/pi-traceline/vocabulary.ts` with examples
copied from `out/results.jsonl` (real output, positive and near miss), then run the
census before and after. An entry whose examples do not hold stops traceline loading,
with the entry and example named.

Comparing a vocabulary change: run `records.ts` with distinct `--census` and
`--dump` paths before and after the edit, then join the dumps on `row`. Read every
record lost (was it a false positive, or a shape the new rule missed?) and sample
every record gained for false hits. A new entry should stay rare: a handful of
records per wall, not one per row.

## Drafting entries with a model

`draft-vocabulary.ts` drafts an entry for one command from your own results, then
checks the draft the way traceline will. Nothing is installed: read the draft, then
add it to `~/.pi/agent/pi-traceline.json`, a project's `.pi/pi-traceline.json`, or
`vocabulary.ts`.

```bash
# Harvest every bash call, not only git, gh and npm, to draft for other tools
node scripts/dev/bash-corpus/extract-results.mjs --all --out scripts/dev/bash-corpus/out/all.jsonl

# Commands that run often and that no entry covers (reads and checks left out)
node scripts/dev/bash-corpus/draft-vocabulary.ts --list --results scripts/dev/bash-corpus/out/all.jsonl

# Draft one, with openai-codex/gpt-6-luna by default; writes out/drafts/<command>.json
node scripts/dev/bash-corpus/draft-vocabulary.ts --command "gh pr ready" [--model provider/id] [--results …]

# Check a draft, yours or the model's, without a model
node scripts/dev/bash-corpus/draft-vocabulary.ts --check out/drafts/gh.pr.ready.json
```

A draft passes only when:

- it parses and every example yields exactly its records, as traceline requires
- every example is copied from a real result: the same command, the same error
  status, and output that is whole lines of that result. A model that edits an
  example, or invents one, fails here

The model sees up to 24 results for the command, the shortest command of each
output shape, failures included, each cut to whole lines. A failed check goes back
to the model with its problems, up to three attempts; the last rejected draft is
kept beside the output as `*.rejected.json`. The model may also decline a command
that changes no named state (`gh release view`).

A passing draft comes with its replay: how many real results it fires on, how many
of those failed, its most common records, and results that run the command but earn
nothing. That is the review: check that the records are news, that failed rows
earn a record only when the change happened before the failure, and that the
wording is verb-first with a short name (`marked ready PR #62`).

The model reads tool results from your sessions. They went to a model when the
session ran, but they can hold secrets; draft with a provider you would show them to.

## Caveats

- Real rows flatten pi's *rendered* invocation text; the rig flattens the raw
  command string, which matches it modulo pi's own line wrapping. Good enough for
  census work; not a golden.
- The corpus is your local session history: private. `out/` is gitignored; never
  commit it. `out/results.jsonl` holds raw command output, so treat it like the
  session logs it came from.
- Crown detection parses rendered ANSI under a marker theme, so the same report
  runs unchanged against any renderer version.
