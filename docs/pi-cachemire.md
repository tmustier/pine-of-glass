# pi-cachemire: the cache model and its evidence

This is the deep companion to [`extensions/pi-cachemire/README.md`](../extensions/pi-cachemire/README.md): the provider-general cache model, the wire-level evidence behind each claim, and the lifecycle trade-offs. The README says what you see; this doc says why it is worded that way.

## One model across providers

Everything cachemire shows is four provider-general rules, which is the whole mental model:

1. **Anchor**: the freshness clock starts at *request processing* (both Anthropic and
   OpenAI create/refresh entries while reading the input; "inactivity" is measured from
   last use). Generation time burns the window.
2. **Scope**: a cache entry belongs to (provider, model, wire API, byte-exact prefix).
   Caches are per-model everywhere, so **any model switch means expected cold**. The
   widget flips before you send anything and leads with the consequence, sized in the
   *target* model's tokenizer: `cache cold expected · model switched · next send
   ~96.4k uncached to openai-codex (80.1k +18.4k tokenizer -2.1k dropped thinking ·
   est)`. The parenthetical starts from the source model's last billed prompt and
   explains the change with signed terms that always sum to the headline; it appears
   only when that billed anchor calibrated the estimate. Through a gateway route
   (pi-messages) the upstream request shape is not observable, so the label weakens
   to `(rough est · gateway route)` and the breakdown is withheld. One exception:
   switching *back* to a model whose own last billed call is still inside its
   freshness window says `cache may still be warm · last <model> call 2m ago · next
   send confirms`, because claiming cold there would be wrong as often as right.
3. **Window**: strength varies by provider: Anthropic has a contract TTL (observed,
   else inferred), OpenAI a documented band (soft ~5m / hard 1h), everyone else is
   unknown. Wording always matches the strength: countdown / fading / likely.
4. **Currency**: exact token counts and $ are only shown in the tokenizer and price
   card that billed them. After a model switch the old exact count is never displayed
   against the new model. The forecast above is a labelled estimate in the target
   model's tokenizer, priced from the target's own price card (tier-aware). The
   estimate walks what the target will actually receive (pi drops cross-model
   encrypted reasoning; readable summaries survive as text), and is density-calibrated
   when possible: the source model billed this same history, so its billed/estimated
   ratio corrects the shared denominators for content that tokenizes unusually (dense
   numeric logs run ~2.1 chars/token on Claude against the 2.6 default). Exact
   numbers return with the first new-model usage, which re-baselines everything.

## When the clock starts

The TTL anchor is *request start*, not response end: Anthropic reads/refreshes/writes
cache entries while processing the request input (entries become available once the
response begins), so a long thinking block burns TTL while it streams. The clock
ticking during generation is correct: after a 4m thinking block on a 5m TTL, the
prefix really does have ~1m left.

The re-write size the clock shows is provider-exact, not estimated: it is `input +
cacheRead + cacheWrite` from the last assistant message's usage: the prompt-side token
count of the last request as the provider billed it. The `~` covers what the clock
cannot know: the next send adds your new message on top, and shared-prefix warmth
(other sessions on the same org with an identical harness prefix) can make the actual
write smaller.

## Aborted sends don't move the clock

The anchor a request claims at send time is confirmed by its usage: Anthropic delivers
prompt-side usage in `message_start`, so even a mid-stream abort confirms it. A send
that ends with *no* usage (a fast abort, or an error) proves nothing about the cache,
so the anchor rolls back to the last billed request; on a first-send abort the clock
simply hides, since no cache entry was ever confirmed. If the aborted send did refresh
the prefix after all, the next call resolves green (`cache held`), the same correction
path as any wrong prediction.

## Cold vs likely cold

`cold` is contract-backed: an observed `cache_control` TTL passed (or, for a freshly
restored anthropic session, the TTL inferred by the same rule pi-ai itself uses
(`PI_CACHE_RETENTION=long` → 1h, else 5m) until the first live observation replaces
it), or OpenAI's documented 1h hard cap passed. `fading` covers OpenAI's
typical-eviction zone, and `likely` wording is reserved for providers cachemire knows
nothing about.

OpenAI's implicit cache has no per-request TTL but does have documented behaviour
(typically evicted after ~5–10m idle, *always* removed within 1h of last use), so it
gets a three-zone band with honest wording per zone:

```
◍ cache likely warm · 3m since last call
◍ cache fading · idle 12m of 5m–1h window · next send may re-send ~109.8k (~$1.37)
◍ cache cold (idle 1h12m > 1h cap) · next send re-sends ~109.8k uncached (~$1.37)
```

## Thinking levels

Thinking levels are the model-switch pattern one notch weaker. On Anthropic a
thinking-param change breaks cache, so on a contract window the widget flips at the
keystroke (`cache stale · thinking level changed · next send re-writes the prompt`)
and the send-time notice names the wire-level change: `cause: thinking changed
(thinking effort xhigh → thinking effort low)`. How *much* breaks depends on the wire
form: Anthropic documents that system/tools survive `budget_tokens` changes, but a
live adaptive-effort change on claude-fable-5 re-wrote 100% of the prompt (read 0,
re-wrote 30.0k of 30.0k), so the survival claim only appears for budget-style
payloads. Crucially, the flip keys on the *wire*, not the keystroke: pi levels that
map to the same provider effort (fable's minimal→low, both effort "low") are
byte-identical requests, live-verified as a 100% hit, and stay silent. OpenAI's
`reasoning.effort` lives outside the prompt-prefix tokens that key its cache, so no
claim is made there: the param is fingerprinted, and only if a miss materializes does
the cause name it (live on gpt-5.5, effort changes did start 2/2 turns with
`cacheRead 0`). Cycling the level back before the next send revives the cache, and the
widget follows.

## OpenAI's best-effort, per-machine cache

OpenAI's cache is best-effort and per-machine: requests route by a hash of the first
~256 tokens (+ `prompt_cache_key`, which pi sets to the session id), stickiness spills
over under load, and "caching only works if two requests share the same prefix and
land on the same machine" (OpenAI docs). Live on gpt-5.5 (session 019eb190) this
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

Cachemire runs that entry arithmetic itself. Every call's prompt total is kept, and
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

## Tree navigation and branch lineages

Pi sessions are trees, so Cachemire resolves cache lineage from the active path before
every provider request, not only after `/tree`. Each live billed request records the
session leaf it serialized, the assistant entry it produced, prompt usage, request time,
provider, model, cache window and payload fingerprint. Restoring a session rebuilds the
provider-usage subset from every branch; request-time fingerprints remain deliberately
in-memory only.

The nearest billed call anchored on the active path supplies the comparison baseline.
This is normally an assistant response on the path; selecting a user/request leaf can
also recover a prior call made from that exact leaf. Its provider-reported
`input + cacheRead + cacheWrite` is the exact provider-known prompt size for that
selected path. Cachemire then considers later requests whose session paths descend from
that response. A candidate can refresh the baseline only when it uses the same provider,
model and cache window and the baseline's system, tools, thinking parameters and message
hashes remain a prefix of the candidate payload. A
newer sibling with another model or prompt shape therefore cannot make the selected
lineage look young.

The next outgoing payload is checked against that same selected baseline. Continuing or
editing after the selected point is ordinary suffix growth, so no history exception or
one-call suppression flag is needed. A change inside the baseline still reports a
history mutation; model, system, tool and thinking changes still take precedence. The
size of the selected response and new divergent tail is not provider-known before the
next usage arrives, so Cachemire withholds that suffix estimate rather than pricing the
abandoned leaf. Provider usage then supplies the exact cached and uncached split.

Restored snapshots have provider, model, prompt size and response timestamps but no
payload fingerprints. They can establish the selected denominator and their own
response-time freshness approximation, but Cachemire does not claim that another
restored descendant refreshed them without fingerprint proof.

## The cause ladder

Every provider request is fingerprinted (system prompt, each tool, each history
message; `cache_control` breakpoints stripped, since pi moves the breakpoint every
call by design). When a call's `cacheRead` collapses, the diff names the culprit:
exact bytes, not vibes.

Causes resolve in order: compaction (from pi's compact events) → named segment
mutation (model / system / tools / history) → TTL expiry (refined by an entry match
when one exists) → entry match on band caches (`read matches call #N's entry · likely
a different replica`) → unknown. Compaction's own summarizer call is labelled, not
warned about.

Almost every break cause is knowable at *send* time (idle gap vs TTL, compact events,
fingerprint diff), so the notice is placed when the request goes out (between your
action and the response, where the causality lives) and then updated **in place** when
the provider's usage arrives. The tense tells you which state you're reading:
progressive + `~` = in-flight expectation, past tense = exact actuals. An unpredicted
break (e.g. provider-side eviction) still gets a resolved-form line when usage
arrives; a send that aborts before usage resolves the notice to an explicit "outcome
unknown".

Compaction is deliberately unsized in flight: Pi's compact event does not provide an
exact provider-token split for the new prefix. The first billed agent call afterwards
does, so the resolved notice compares its exact `cacheRead` with the last normal agent
prompt before compaction: `reused 34.9k of the last pre-compaction 72.5k prompt (48%) ·
processed 39.1k uncached`. Pi's summarizer request has a separate prompt shape and does not
reuse that prefix. The first normal agent call after compaction can instead read the
unchanged prefix from the earlier pre-compaction cache lineage. `Reused` is not a claim
about how many semantic conversation tokens Pi kept. The uncached count is the
provider-reported ordinary input plus explicit cache-write input: everything in the new
prompt that was not a cache read. It therefore carries no share of the old prompt. If
the model also changed, the
old-model prompt count and share are withheld rather than compared with usage from a
different tokenizer.

Percentages on ordinary resolved miss notices remain the share of that request's
prompt-side tokens (input + cacheRead + cacheWrite) that had to be re-written. `cache
held` (green) appears when a predicted break did not happen, usually shared-prefix
warmth: another session with the same harness prefix kept the early breakpoints alive
past your idle gap.

## State and lifecycle

Working state is in-memory and dies with the process. What survives an exit is exactly
what the provider billed (usage on assistant messages in the session transcript), from
which `--continue` rebuilds the active ledger and all-branch lineage baselines.
Request-time observations (payload fingerprints, true request-start anchors and the
observed `cache_control` TTL) exist only at the event boundary and are never persisted.
After restore, Cachemire uses response timestamps as slightly optimistic anchor
approximations, withholds compatibility claims that need a fingerprint, and restarts
replica-entry matching from live calls. Restored rows say `cause unknown` rather than reconstruct a
diagnosis from vibes. Cachemire writes nothing into session entries or exports (UI-only
contract).

Only the Pi extension instance with an interactive UI may own that process-global
working state. A nested headless `AgentSession` still loads the extension, but its
lifecycle and provider events are ignored; it cannot overwrite the interactive
ledger, cache clock or model metadata. The interactive instance releases ownership
on `session_shutdown` so the next interactive lifecycle can claim it cleanly.

This trade-off fits the current goal: live legibility (repo README, plan 1). Plan 2
(post-hoc analysis of stored sessions and traces, RPC/remote runs, fleets of agent
sessions) would need those request-time observations *after* the fact, which means
persisting them to a sidecar artifact (never the session itself). Revisit then.
