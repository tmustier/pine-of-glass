# pi-cachemire

> **Status: experimental.** Cachemire has been part of the `pine-of-glass`
> package since `0.4.0`. Its wording, thresholds and states may change without
> notice. Follow [Cachemire tracking issue 6](https://github.com/tmustier/pine-of-glass/issues/6)
> for updates.

Use Cachemire to understand the cache and agent-loop costs of a pi session.
pi's footer counts input, output, cache reads, cache writes and cost. Cachemire
explains when the cache will go cold, why it broke and what the loop cost.

![Turn ledger lines in the transcript, a resolved break notice naming its cause (thinking changed), and the cache clock above the editor](../../docs/img/pi-cachemire-clock.png)

## Check cache freshness before you send

A cache clock above the input box counts down the provider's cache freshness from
the last request. Check it before you press Enter to see whether the next send will
be cheap or will re-bill the whole prefix.

For Anthropic, the clock shows a contract-TTL countdown. It reads the observed
`cache_control`, not config. For OpenAI, it shows a documented three-zone band. For
unknown providers, it uses softer wording. The promised re-write size uses
provider-exact usage, with one exception: after a model switch it is an estimate in
the new model's tokenizer, and says so. The pre-send clock estimates canonical history;
at send time Cachemire re-sizes recognized system, tool and message fields from the
provider payload it observes, including pi normalization and earlier payload transforms.
Gateway estimates stay rough because an upstream rewrite can still change them.

```
◍ cache 4m30s                                    (green → yellow under 60s)
◍ cache fading · idle 12m of 5m–1h window · next send may re-send ~109.8k (~$1.37)
◍ cache cold · next send re-writes ~142.3k (~$2.67)
```

## Find out why the cache broke

Cachemire fingerprints every request, including the system prompt, each tool and
each history message. If a call's `cacheRead` collapses, the break notice names the
cause from exact byte-level differences.

The notice appears at send time, where Cachemire can tie it to the request. It
updates in place when usage arrives. Progressive wording and `~` show an in-flight
expectation. Past-tense wording shows exact actuals.

Healthy caches stay quiet. Notices appear only above a materiality threshold. The
default threshold is $0.05 or 20k re-written tokens.

```
◍ cache breaking · re-writing ~138.2k (~$2.59) · cause: idle 9h50m > 5m TTL   (in flight)
◍ cache after compaction · reused 34.9k of the last pre-compaction 72.5k prompt (48%) · processed 39.1k uncached
◍ cache broke · re-wrote 138.2k of 139.6k prompt (99%) · $0.52 · cause: idle 9h50m > 5m TTL
◍ cache partial · read 41.2k of 138.2k expected · re-wrote 138.2k (76% of prompt) · cause: system prompt changed
◍ cache held · read 76.0k of 77.7k expected · prefix stayed warm              (prediction wrong, good news)
```

Tree navigation follows the selected branch's cache lineage. Cachemire anchors each
live billed request to its session path, then chooses the last provider-billed prompt on
the active path instead of pricing the abandoned leaf. Only descendants with a
compatible provider, model, cache window and payload fingerprint can refresh that
baseline. Continuing
with a divergent suffix is ordinary prefix growth, so it needs no warning suppression;
the next response supplies the exact cached and uncached split.

A compaction prediction stays unsized because the new prefix is not provider-known
until the next response. The resolved line uses exact provider usage. `Reused` means
the first normal agent call after compaction read an unchanged prefix from the last
normal pre-compaction prompt. The separate summarizer request does not reuse that
prefix, and this is not a count of semantic conversation tokens retained by the
compactor. The percentage therefore uses the last pre-compaction prompt as its
denominator. The processed count is ordinary input plus explicit cache-write input:
everything in the new prompt that was not a cache read. It carries no percentage. If the
model also changed, Cachemire withholds the prior count and share rather than
compare values from different tokenizers.

## See the cost of each turn

Cachemire prints a turn ledger line after every user turn. Run `/cache` to see the
full per-call table.

The example below is a live capture on an OpenAI band cache. It shows a cold start,
two hits and then a miss. The notice names a thinking-level change as the cause
because it re-keyed the cache.

```
◍ turn: 7 calls · 2m41s · read 940.1k (99.6% cached) · wrote 11.2k · out 4.2k · $0.09
```

![Cachemire /cache ledger table](../../docs/img/pi-cachemire-ledger.png)

The savings line compares actual spend with the cost if every token had been billed
at base input rates. Use it to answer the question: "Is caching working?"

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

## Use Cachemire

You do not need to press anything. The clock ticks above the editor, notices appear
automatically and the turn line follows each turn. Run `/cache` to print the per-call
ledger table.

Config lives at `~/.pi/agent/pi-cachemire.json` or `<project>/.pi/pi-cachemire.json`.
Set `turnSummaryMinCalls` higher if you only want a ledger line for multi-call turns.

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

## Understand reporting and data handling

Cachemire follows these rules:

- Token and cost numbers come from provider-reported usage in assistant messages.
  The one estimate is the model-switch forecast, which is always labelled `est`.
  Forensic causes come from observed payload diffs. Cachemire does not infer them.
- Everything Cachemire draws is UI-only. It does not enter LLM context, session
  entries or exports.
- Freshness wording reflects how much is known. A contract TTL gets a definite
  countdown. A documented band gets fading or cap wording. When nothing is known,
  Cachemire says "likely". Under subscription auth, it marks savings as notional.
- Sessions restored with `--continue` rebuild the active ledger and all-branch cache
  baselines from session usage. Cachemire marks restored rows and excludes them from
  savings because their pricing context is unknown. Payload fingerprints are not
  persisted. Restored branches use the parent session entry as the request-time anchor
  when available, and fall back to response time; live requests replace that approximation
  with observed request timing and payload compatibility evidence.

## Understand the model behind the wording

Cachemire uses 4 provider-general rules:

- The freshness **anchor** is request processing. Generation time uses up the window.
- The cache **scope** is the provider, model, wire API and byte-exact prefix. Warmth
  checks require all 3 identity fields to match. A model switch therefore means the
  cache is expected cold before you send anything, and the
  widget forecasts the prompt in the *target* model's currency (est-marked). Switching
  back to a model whose own cache may still be warm says so instead.
- The **window** has different strengths for each provider. Anthropic has a contract
  TTL, OpenAI has a documented band and the window is unknown for other providers.
  The wording
  reflects that strength.
- The **currency** rule shows exact tokens and $ only in the tokenizer and price card
  that billed them; cross-model sizes are explicit estimates in the target currency.

Read [`docs/pi-cachemire.md`](../../docs/pi-cachemire.md) for the full model and its
evidence. It covers clock-anchor and aborted-send semantics, thinking-level cache
keys verified on the wire, OpenAI's per-machine replica arithmetic (512-token entry
matching), the cause ladder and the state and lifecycle trade-offs.

## Compare Cachemire with the other extensions

| | granularity | currency | question |
|---|---|---|---|
| contextimate | static prefix | estimated tokens | what am I carrying? |
| traceline | per tool call | exact chars | what did tools do? |
| **cachemire** | per model call / turn | exact provider tokens & $ (est across a model switch) | what did the loop cost, and why? |

The ledger starts with the family panel header (`[Cachemire]` in the theme accent).
The shared `ink()` helper provides theme-derived tones. The `◍` / `○ ● ◑ ◌` glyphs
come from the family vocabulary. Read
[`docs/design-language.md`](../../docs/design-language.md) for details.

## Keep scrollback lines across chat rebuilds

Cachemire appends scrollback lines directly to pi's chat container, which it finds
structurally like Traceline. The lines persist across pi's chat rebuilds.

Each line has a durable anchor. Cachemire re-attaches it in place after Ctrl+T,
compaction or tree navigation rebuilds the chat. If a rebuild no longer contains the
anchor, Cachemire drops the line instead of attaching it somewhere misleading.

If this internal seam drifts, Cachemire falls back to plain `notify` lines. The
contract test suite names the break. Cachemire does not modify anything in pi's
`node_modules`, so it survives `pi update`.
