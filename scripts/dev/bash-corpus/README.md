# bash-corpus: measure the crown grammar against real sessions

Traceline's bash head-bolding rules (design language §9.4) are judged
against real usage, not intuition: this rig harvests every bash tool invocation from
local pi session logs and replays it through the *live* ink pipeline
(`internals.inkBashRow`), then reports what wears the crown.

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
# ... edit extensions/pi-traceline/index.ts ...
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

## Caveats

- Real rows flatten pi's *rendered* invocation text; the rig flattens the raw
  command string, which matches it modulo pi's own line wrapping. Good enough for
  census work; not a golden.
- The corpus is your local session history: private. `out/` is gitignored; never
  commit it.
- Crown detection parses rendered ANSI under a marker theme, so the same report
  runs unchanged against any renderer version.
