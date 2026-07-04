# pi-cachemire

> **Status: experimental.** Included in the `pine-of-glass` package as of `0.4.0`,
> but the UX is still settling: wording, thresholds, and states may change without
> notice. Track [#6](https://github.com/tmustier/pine-of-glass/issues/6).

Explains the cache and agent-loop economics of a pi session. pi's footer *counts*
(input/output/cache read/write/cost); cachemire *explains*: when the cache will go
cold, why it broke, and what the loop actually cost.

![Turn ledger lines in the transcript, a resolved break notice naming its cause (thinking changed), and the cache clock above the editor](../../docs/img/pi-cachemire-clock.png)

**A cache clock above the input box** counts down provider cache freshness from the
last request, so you know *before* you hit Enter whether the send is cheap or re-bills
the whole prefix. Anthropic gets a contract-TTL countdown (read from the observed
`cache_control`, not from config), OpenAI a documented three-zone band, unknown
providers soft wording; the promised re-write size is provider-exact usage, never an
estimate:

```
◍ cache 4m30s                                    (green → yellow under 60s)
◍ cache fading · idle 12m of 5m–1h window · next send may re-send ~109.8k (~$1.37)
◍ cache cold · next send re-writes ~142.3k (~$2.67)
```

**Break notices name the culprit.** Every request is fingerprinted (system prompt,
each tool, each history message), so when a call's `cacheRead` collapses, the notice
says why: exact bytes, not vibes. It appears at send time, where the causality lives,
and updates in place when usage arrives (progressive + `~` = in-flight expectation,
past tense = exact actuals). Silence when healthy: notices only appear above a
materiality threshold (default $0.05 or 20k re-written tokens):

```
◍ cache breaking · re-writing ~138.2k (~$2.59) · cause: idle 9h50m > 5m TTL   (in flight)
◍ cache broke · re-wrote 138.2k of 139.6k prompt (99%) · $0.52 · cause: idle 9h50m > 5m TTL
◍ cache partial · read 41.2k of 138.2k expected · re-wrote 138.2k (76% of prompt) · cause: system prompt changed
◍ cache held · read 76.0k of 77.7k expected · prefix stayed warm              (prediction wrong, good news)
```

**A turn ledger** prints one line after every user turn, and `/cache` renders the full
per-call table (below: live capture on an OpenAI band cache: a cold start, two hits,
then a miss with a named cause after a thinking-level change re-keyed the cache):

```
◍ turn: 7 calls · 2m41s · read 940.1k (99.6% cached) · wrote 11.2k · out 4.2k · $0.09
```

![Cachemire /cache ledger table](../../docs/img/pi-cachemire-ledger.png)

The savings line compares actual spend against the counterfactual where every token
was billed at base input rates: the honest answer to "is caching working?".

## Install

Install from npm:

```bash
pi install npm:pine-of-glass
```

Try it for one run without installing:

```bash
pi -e npm:pine-of-glass
```

For local development from a clone:

```bash
pi -e ./extensions/pi-cachemire
```

## Use

Nothing to press: the clock ticks above the editor, notices arrive on their own, the
turn line follows each turn. `/cache` prints the per-call ledger table.

Config lives at `~/.pi/agent/pi-cachemire.json` or `<project>/.pi/pi-cachemire.json`
(`turnSummaryMinCalls` raises the bar if you want a ledger line only for multi-call
turns):

```json
{
  "widget": true,
  "turnSummary": true,
  "turnSummaryMinCalls": 1,
  "missWarnings": true,
  "missWarnUsd": 0.05,
  "missWarnTokens": 20000
}
```

Honesty rules:

- All token/cost numbers are provider-reported usage from assistant messages, never
  estimated. Forensic causes come from observed payload diffs, never inferred.
- Everything cachemire draws is UI-only: nothing enters LLM context, session entries,
  or exports.
- Freshness wording always matches the strength of what is known: contract TTL →
  definite countdown, documented band → fading/cap wording, nothing → "likely".
  Savings are flagged as notional under subscription auth.
- `--continue`d sessions restore the ledger from session usage; restored rows are
  marked and excluded from savings (their pricing context is unknown).

## The model behind the wording

Everything above is four provider-general rules: the freshness **anchor** is request
processing (generation time burns the window); the cache **scope** is (provider,
model, byte-exact prefix), so any model switch means definite cold before you send
anything; the **window**'s strength varies by provider (Anthropic contract TTL, OpenAI
documented band, otherwise unknown) and the wording always matches that strength; and
the **currency** rule shows tokens and $ only in the tokenizer and price card that
billed them.

[`docs/pi-cachemire.md`](../../docs/pi-cachemire.md) carries the full model and its
evidence: clock-anchor and aborted-send semantics, thinking-level cache keys verified
on the wire, OpenAI's per-machine replica arithmetic (512-token entry matching), the
cause ladder, and the state/lifecycle trade-offs.

## How it sits in the family

| | granularity | currency | question |
|---|---|---|---|
| contextimate | static prefix | estimated tokens | what am I carrying? |
| traceline | per tool call | exact chars | what did tools do? |
| **cachemire** | per model call / turn | exact provider tokens & $ | what did the loop cost, and why? |

The ledger opens with the family panel header (`[Cachemire]` in the theme accent);
tones are theme-derived through the shared `ink()` helper, and the `◍` / `○ ● ◑ ◌`
glyphs come from the family vocabulary (see
[`docs/design-language.md`](../../docs/design-language.md)).

Scrollback lines are appended to pi's chat container directly (found structurally,
like traceline) and **persist across pi's chat rebuilds**: each line is tracked with a
durable anchor and re-attached in place after Ctrl+T, compaction, or tree navigation
rebuilds the chat; when a rebuild no longer contains the anchor, the line is dropped
rather than re-attached somewhere misleading. If the internal seam ever drifts,
cachemire degrades to plain `notify` lines and the contract test suite names the
break. Nothing in pi's `node_modules` is modified, so it survives `pi update`.
