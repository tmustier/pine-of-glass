# pi-cachemire

> **Status: experimental.** Included in the `pine-of-glass` package as of `0.4.0`,
> but the UX is still settling: wording, thresholds, and states may change without
> notice. Track [#6](https://github.com/tmustier/pine-of-glass/issues/6).

Explains the cache and agent-loop economics of a pi session. pi's footer *counts*
(input/output/cache read/write/cost); cachemire *explains*: when the cache will go cold,
why it broke, and what the loop actually cost.

![Cachemire turn ledger lines in the transcript and the cache clock above the editor](../../docs/img/pi-cachemire-clock.png)

## What you get

**1. A cache clock above the input box**: counts down the provider cache TTL from the
last request (Anthropic: 5m, or 1h with long retention, read from the observed
`cache_control`, not from config):

```
◍ cache 4m30s                                    (green → yellow under 60s)
◍ cache cold · next send re-writes ~142.3k (~$2.67)
◍ cache stale · history compacted · next send re-writes the new prefix
```

So you know *before* you hit Enter whether the send is cheap or re-bills the whole
prefix. OpenAI's implicit cache has no per-request TTL but does have documented
behaviour (typically evicted after ~5–10m idle, *always* removed within 1h of last
use), so it gets a three-zone band with honest wording per zone:

```
◍ cache likely warm · 3m since last call
◍ cache fading · idle 12m of 5m–1h window · next send may re-send ~109.8k (~$1.37)
◍ cache cold (idle 1h12m > 1h cap) · next send re-sends ~109.8k uncached (~$1.37)
```

Unknown providers keep pure soft language (`cache likely cold (idle 12m) · …`).

The re-write size is provider-exact, not estimated: it is `input + cacheRead +
cacheWrite` from the last assistant message's usage: the prompt-side token count of
the last request as the provider billed it. The `~` covers what the clock cannot know:
the next send adds your new message on top, and shared-prefix warmth (other sessions
on the same org with an identical harness prefix) can make the actual write smaller.

**When the clock starts.** The TTL anchor is *request start*, not response end:
Anthropic reads/refreshes/writes cache entries while processing the request input
(entries become available once the response begins), so a long thinking block burns
TTL while it streams. The clock ticking during generation is correct: after a 4m
thinking block on a 5m TTL, the prefix really does have ~1m left.

**Aborted sends don't move the clock.** The anchor a request claims at send time is
confirmed by its usage: Anthropic delivers prompt-side usage in `message_start`, so
even a mid-stream abort confirms it. A send that ends with *no* usage (a fast abort, or
an error) proves nothing about the cache, so the anchor rolls back to the last billed
request; on a first-send abort the clock simply hides, since no cache entry was ever
confirmed. If the aborted send did refresh the prefix after all, the next call resolves
green (`cache held`), the same correction path as any wrong prediction.

**Cold vs likely cold.** `cold` is contract-backed: an observed `cache_control` TTL
passed (or, for a freshly restored anthropic session, the TTL inferred by the same rule
pi-ai itself uses (`PI_CACHE_RETENTION=long` → 1h, else 5m) until the first live
observation replaces it), or OpenAI's documented 1h hard cap passed. `fading` covers
OpenAI's typical-eviction zone, and `likely` wording is reserved for providers cachemire
knows nothing about.

## One model across providers

Everything above is four provider-general rules, which is the whole mental model:

1. **Anchor**: the freshness clock starts at *request processing* (both Anthropic and
   OpenAI create/refresh entries while reading the input; "inactivity" is measured from
   last use). Generation time burns the window.
2. **Scope**: a cache entry belongs to (provider, model, byte-exact prefix). Caches are
   per-model everywhere, so **any model switch means definite cold**: the widget flips
   *before you send anything*, sized in the only currency it has, explicitly tagged:
   `cache cold · model switched · next send re-writes the full prompt (~222.9k
   claude-fable-5 tokens)`.
3. **Window**: strength varies by provider: Anthropic has a contract TTL (observed,
   else inferred), OpenAI a documented band (soft ~5m / hard 1h), everyone else is
   unknown. Wording always matches the strength: countdown / fading / likely.
4. **Currency**: token counts and $ are only ever shown in the tokenizer and price card
   that billed them. After a model switch the stored size keeps its old-model tag and
   gets no $ (which would compound the conversion error) until the first new-model usage
   re-baselines it. Exactness arrives one call later, the only honest time it can.

Thinking levels are the same pattern one notch weaker. On Anthropic a thinking-param
change breaks cache, so on a contract window the widget flips at the keystroke
(`cache stale · thinking level changed · next send re-writes the prompt`) and the
send-time notice names the wire-level change: `cause: thinking changed (thinking effort
xhigh → thinking effort low)`. How *much* breaks depends on the wire form: Anthropic
documents that system/tools survive `budget_tokens` changes, but a live adaptive-effort
change on claude-fable-5 re-wrote 100% of the prompt (read 0, re-wrote 30.0k of 30.0k),
so the survival claim only appears for budget-style payloads. Crucially, the flip keys on
the *wire*, not the keystroke: pi levels that map to the same provider effort (fable's
minimal→low, both effort "low") are byte-identical requests, live-verified as a 100%
hit, and stay silent. OpenAI's `reasoning.effort` lives outside the prompt-prefix
tokens that key its cache, so no claim is made there: the param is fingerprinted, and
only if a miss materializes does the cause name it (live on gpt-5.5, effort changes did
start 2/2 turns with `cacheRead 0`). Cycling the level back before the
next send revives the cache, and the widget follows.

OpenAI's cache is also **best-effort and per-machine**: requests route by a hash of the
first ~256 tokens (+ `prompt_cache_key`, which pi sets to the session id), stickiness
spills over under load, and "caching only works if two requests share the same prefix
and land on the same machine" (OpenAI docs). Live on gpt-5.5 (session 019eb190) this
produced a *double* break after one thinking change, and the arithmetic proves the
mechanism: the Codex backend checkpoints entries at 512-token granularity, and every
hit in the session read exactly `floor₅₁₂` of a specific earlier call's prompt total.
Mapping reads to entries shows the turn alternated between two machines (A-write,
B-write, A-hit 16,896 = floor₅₁₂(17,397), B-hit 18,432 = floor₅₁₂(18,500)): the effort
change re-keyed both machines' caches and each paid one cold write. `cacheRead 0` (not
partial) was the tell that effort participates in the cache key; a content change
alone would still have hit the unchanged ~15k early prefix. The unknown-cause hint is
window-aware for this: band windows say `best-effort cache: fresh write not yet
readable, or replica routing` instead of Anthropic's `provider-side eviction?`.

Cachemire now runs that entry arithmetic itself. Every call's prompt total is kept, and
when a later read on a band cache equals `floor₅₁₂` of one (within the 1h hard cap,
newest match wins), the cause names the entry instead of shrugging:

```
◍ cache partial · read 49.2k of 63.1k expected · re-wrote 14.0k (22% of prompt)
  · cause: read matches call #38's entry (13m24s old) · likely a different replica from the last write
```

When an idle gap *does* explain the miss, the entry refines rather than replaces it:
`evicted after idle 11m48s (typical window 5m–1h) · fell back to call #38's entry (13m
old)`. Live motivation: session 019e9758 produced a burst of breaks within seconds,
reads alternating 62,464 → 49,152 → 62,464 → 65,024, which a single cache cannot do
(eviction cannot resurrect a shorter entry between two reads of a longer one); ≥3
replica lineages were advancing independently, and each break was one replica's
first-touch. The matcher turns that hand analysis into the default diagnosis.

**2. Cache forensics**: every provider request is fingerprinted (system prompt, each
tool, each history message; `cache_control` breakpoints stripped, since pi moves the
breakpoint every call by design). When a call's `cacheRead` collapses, the diff names
the culprit: exact bytes, not vibes.

Almost every break cause is knowable at *send* time (idle gap vs TTL, compact events,
fingerprint diff), so the notice is placed when the request goes out (between your
action and the response, where the causality lives) and then updated **in place** when
the provider's usage arrives. The tense tells you which state you're reading:
progressive + `~` = in-flight expectation, past tense = exact actuals.

```
◍ cache breaking · re-writing ~138.2k (~$2.59) · cause: idle 9h50m > 5m TTL   (in flight)
◍ cache broke · re-wrote 138.2k of 139.6k prompt (99%) · $0.52 · cause: idle 9h50m > 5m TTL
◍ cache partial · read 41.2k of 138.2k expected · re-wrote 138.2k (76% of prompt) · cause: system prompt changed
◍ cache held · read 76.0k of 77.7k expected · prefix stayed warm              (prediction wrong, good news)
```

The `(99%)` is the share of this request's prompt-side tokens (input + cacheRead +
cacheWrite) that had to be re-written. `cache held` (green) appears when a predicted
break didn't happen, usually shared-prefix warmth: another session with the same
harness prefix kept the early breakpoints alive past your idle gap.

Cause ladder: compaction (from pi's compact events) → named segment mutation (model /
system / tools / history) → TTL expiry (refined by an entry match when one exists) →
entry match on band caches (`read matches call #N's entry · likely a different replica`)
→ unknown. Compaction's own summarizer call is labelled, not warned about. Notices only appear above a materiality threshold
(default: $0.05 or 20k re-written tokens); silence when healthy. An unpredicted break
(e.g. provider-side eviction) still gets a resolved-form line when usage arrives; a
send that aborts before usage resolves the notice to an explicit "outcome unknown".

**3. A turn ledger**: one line after every user turn (`turnSummaryMinCalls` raises the
bar if you want the old ≥2-calls behaviour):

```
◍ turn: 7 calls · 2m41s · read 940.1k (99.6% cached) · wrote 11.2k · out 4.2k · $0.09
◍ turn: 59 calls · 29m37s · read 9.1M (100% cached) · wrote 222.9k · out 103.5k · $17.03
```

and `/cache` for the full per-call table (live capture on an OpenAI band cache: cold
start, hit, and one honestly-attributed miss):

![Cachemire /cache ledger table](../../docs/img/pi-cachemire-ledger.png)

On an Anthropic contract cache it reads like this:

```
[Cachemire]
  cache & loop ledger · anthropic · 5m TTL · anthropic/claude-opus-4-8
  call     gap    input     read    wrote     out    cost  event
     1       —    12.1k     0.0k   138.2k    0.4k   $0.55  ○ cold start
     2     14s     1.2k   150.3k     1.8k    1.1k  $0.040  ● hit
  totals: 2 calls · input 13.3k · read 150.3k · wrote 140.0k · out 1.5k · $0.59
  caching saved ~$0.65 vs uncached $0.91 (−71%) · API-priced; notional on subscription
```

The ledger opens with the family panel header (`docs/design-language.md` §5): `[Cachemire]`
in the theme accent, with the descriptive title and provider profile on the dim hint line.
Clock and notice tones are theme-derived through the shared `ink()` helper, and the `◍` /
`○ ● ◑ ◌` glyphs come from the family vocabulary in `extensions/_lib/style.ts`.

The savings line compares actual spend against the counterfactual where every token was
billed at base input rates: the honest answer to "is caching working?".

## Honesty rules

- All token/cost numbers are provider-reported usage from assistant messages, never
  estimated. Forensic causes come from observed payload diffs, never inferred.
- Everything cachemire draws is UI-only: nothing enters LLM context, session entries,
  or exports.
- Freshness wording always matches the strength of what is known: contract TTL →
  definite, documented band → fading/cap wording, nothing → "likely". Savings are
  flagged as notional under subscription auth.
- `--continue`d sessions restore the ledger from session usage; restored rows are
  marked and excluded from savings (their pricing context is unknown).

## State & lifecycle

Working state is in-memory and dies with the process. What survives an exit is exactly
what the provider billed (usage on assistant messages in the session transcript), from
which `--continue` rebuilds the ledger (and entry matching still works across a quick
exit+resume, since prompt totals are recoverable). Request-time observations (payload
fingerprints, request-start anchors, the observed `cache_control` TTL) exist only at
the event boundary and are never persisted: restored rows say `cause unknown` rather
than reconstruct a diagnosis from vibes, and cachemire writes nothing into session
entries or exports (UI-only contract).

This trade-off fits the current goal: live legibility (repo README, plan 1). Plan 2
(post-hoc analysis of stored sessions and traces, RPC/remote runs, fleets of agent
sessions) would need those request-time observations *after* the fact, which means
persisting them to a sidecar artifact (never the session itself). Revisit then.

## Config

`~/.pi/agent/pi-cachemire.json` or `<project>/.pi/pi-cachemire.json`:

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

The lines also **persist across pi's chat rebuilds**. Ctrl+T (and compaction, tree
navigation) rebuild the chat from session messages; raw appended children, including
pi's own status lines, are dropped. Status lines are flotsam; cachemire's lines are
forensic records, so each is tracked with a durable anchor (the nearest preceding tool
row's `toolCallId`, or a message component's `role#timestamp`, plus its offset) and
re-attached in place after every rebuild. When a rebuild no longer contains the anchor
(compaction, branch navigation), the context the line annotated is gone; it is dropped
rather than re-attached somewhere misleading.
