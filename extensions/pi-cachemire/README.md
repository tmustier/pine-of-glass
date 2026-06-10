# pi-cachemire

Explains the cache and agent-loop economics of a pi session. pi's footer *counts*
(input/output/cache read/write/cost); cachemire *explains* — when the cache will go cold,
why it broke, and what the loop actually cost.

## What you get

**1. A cache clock above the input box** — counts down the provider cache TTL from the
last request (Anthropic: 5m, or 1h with long retention — read from the observed
`cache_control`, not from config):

```
◍ cache 4m30s                                    (green → yellow under 60s)
◍ cache cold · next send re-writes ~142.3k (~$2.67)
```

So you know *before* you hit Enter whether the send is cheap or re-bills the whole
prefix. Providers without a TTL contract (OpenAI's implicit caching) get soft wording:
`cache likely warm · 3m since last call`.

**2. Cache forensics** — every provider request is fingerprinted (system prompt, each
tool, each history message; `cache_control` breakpoints stripped, since pi moves the
breakpoint every call by design). When a call's `cacheRead` collapses, the diff names
the culprit — exact bytes, not vibes:

```
◍ cache broke · re-wrote 138.2k ($0.52) · cause: idle 6m42s > 5m TTL
◍ cache broke · re-wrote 138.2k ($0.52) · cause: tools changed (+12 added)
◍ cache partial · read 41.2k of 138.2k · cause: system prompt changed
```

Cause ladder: compaction (from pi's compact events) → named segment mutation (model /
system / tools / history) → TTL expiry → unknown. Compaction's own summarizer call is
labelled, not warned about. Warnings only appear above a materiality threshold
(default: $0.05 or 20k re-written tokens) — silence when healthy.

**3. A turn ledger** — one line after any user turn that took ≥2 model calls:

```
◍ turn: 7 calls · 2m41s · read 940.1k (99.6% cached) · wrote 11.2k · out 4.2k · $0.09
```

and `/cache` for the full per-call table:

```
◍ Cachemire — cache & loop ledger   anthropic · 5m TTL · anthropic/claude-opus-4-8
   call     gap    input     read    wrote     out    cost  event
      1       —    12.1k        0   138.2k     400   $0.55  ○ cold start
      2     14s     1.2k   150.3k     1.8k    1.1k   $0.04  ● hit
   totals: 2 calls · input 13.3k · read 150.3k · wrote 140.0k · out 1.5k · $0.59
   caching saved ~$0.65 vs uncached $0.91 (−71%) · API-priced; notional on subscription
```

The savings line compares actual spend against the counterfactual where every token was
billed at base input rates — the honest answer to "is caching working?".

## Honesty rules

- All token/cost numbers are provider-reported usage from assistant messages — never
  estimated. Forensic causes come from observed payload diffs — never inferred.
- Everything cachemire draws is UI-only: nothing enters LLM context, session entries,
  or exports.
- TTL state is labelled "likely" where the provider gives no contract. Savings are
  flagged as notional under subscription auth.
- `--continue`d sessions restore the ledger from session usage; restored rows are
  marked and excluded from savings (their pricing context is unknown).

## Config

`~/.pi/agent/pi-cachemire.json` or `<project>/.pi/pi-cachemire.json`:

```json
{
  "widget": true,
  "turnSummary": true,
  "turnSummaryMinCalls": 2,
  "missWarnings": true,
  "missWarnUsd": 0.05,
  "missWarnTokens": 20000
}
```

## How it sits in the family

| | granularity | currency | question |
|---|---|---|---|
| contextimate | static prefix | estimated tokens | what am I carrying? |
| traceline | per tool call | exact chars | what did tools do? |
| **cachemire** | per model call / turn | exact provider tokens & $ | what did the loop cost, and why? |

Scrollback lines are appended to pi's chat container directly (found structurally, like
traceline); if that internal seam ever drifts, cachemire degrades to plain `notify`
lines and the contract test suite names the break. Nothing in pi's `node_modules` is
modified, so this survives `pi update`.
