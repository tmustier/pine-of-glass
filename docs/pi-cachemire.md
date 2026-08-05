# pi-cachemire: the cache model and its evidence

This is the engineering companion to
[`extensions/pi-cachemire/README.md`](../extensions/pi-cachemire/README.md). The README
explains what users see. This guide records the evidence and lifecycle rules behind that
wording.

## Documented retention behaviour

Cachemire resolves retention from the exact route, model and observed outgoing policy.
A provider name alone is not enough. The generated policy and evidence matrix is in the
[`cache retention audit`](./cache-retention-audit-2026-08-04.md). Unmatched routes make
no idle-time or warmth claim.

The wider provider inventory and implementation plan are in
[`cache-provider-stocktake-2026-08-05.md`](./cache-provider-stocktake-2026-08-05.md).
That stocktake also records a current activation gap: general prompt usage confirms a
billed request, while only reported cache reads or writes confirm that a cache entry
exists.

## Four rules shape the UI

1. Evidence: Cachemire distinguishes a TTL, a minimum, a maximum and unknown retention.
   It does not turn a minimum lifetime into a maximum.
2. Scope: a cache entry belongs to a provider, model, wire API and byte-exact prefix.
   Model-switch checks require all 3 identity fields. A switch-back hint needs an active
   TTL or minimum. Unknown retention stays unknown until the next send reports usage.
3. Retention: an Anthropic TTL supports a countdown and expiry claim. The GPT-5.6
   minimum blocks stale claims for 30 minutes, then changes to unknown. An observed
   24-hour OpenAI maximum supports a stale claim once reached. Healthy states stay hidden.
4. Currency: exact token and cost numbers stay in the tokenizer and price card that
   billed them. A model-switch forecast is a labelled estimate in the target model's
   tokenizer. Exact values return with the first billed call on the new model.

At `before_provider_request`, Cachemire sizes recognized prompt fields from the payload
it observes. This captures Pi normalization and earlier payload transforms. Gateway
estimates remain rough because the upstream request shape is not visible.

## Anthropic clocks start at request time

An observed Anthropic TTL starts when Cachemire sees the outgoing request. Anthropic
reads, refreshes and writes cache entries while processing the input. Generation time
therefore uses some of the TTL. A long thinking block can make the warning appear while
the response is still streaming.

A known 5-minute TTL appears during its final minute. A known 1-hour TTL appears during
its final 5 minutes. After expiry, the warning remains until the next provider call
reports the outcome.

A restored Anthropic session has no persisted `cache_control`. Cachemire mirrors Pi's
ordinary-call default: `PI_CACHE_RETENTION=long` means 1 hour, otherwise 5 minutes. The
first live payload replaces that inference.

For GPT-5.6 and later GPT-5 models, OpenAI documents a 30-minute minimum. This default
applies on OpenAI and OpenAI Codex. Cachemire stays silent during the minimum. At the
boundary it reports an unknown cache state because OpenAI may retain the prefix longer.
Reaching the minimum does not classify a later miss as eviction.

For an observed 24-hour OpenAI maximum, Cachemire stays silent before the maximum and
marks the cache stale once the maximum is reached. Unknown routes remain silent at every
elapsed time.

The widget schedules its next update at a known boundary. It updates once per second
only during the final 90 seconds of a visible countdown. Healthy and unknown states do
not trigger continuous renders.

## The displayed forecast is a prior-prompt baseline

The clock starts with `input + cacheRead + cacheWrite` from the last billed assistant
message. This is the prompt-side count for that completed request. It is not the whole
next prompt.

The next request adds the new user message and other suffix content. Shared prefixes
from another session can also reduce the actual write. The `~` marks this uncertainty.
After a model switch, Cachemire uses a separate target-tokenizer estimate instead of the
old model's billed count.

## Aborted sends do not create evidence

A request start is confirmed when provider usage arrives. Anthropic reports prompt usage
in `message_start`, so a mid-stream abort can still confirm the request.

A fast abort or error with no usage proves nothing about the cache. Cachemire restores
the previous timestamp and retention policy. A first-send abort leaves no confirmed
clock to show.

## Thinking changes follow wire evidence

Cachemire fingerprints the wire form, not the Pi keystroke. Anthropic thinking changes
can invalidate message cache entries. A known Anthropic TTL therefore supports an
in-flight warning when the outgoing wire value changes. Levels that map to the same wire
value stay silent.

Other routes get no retention-based prediction. If billed usage later proves a miss,
Cachemire can report an observed payload mutation. A miss without such evidence keeps an
unknown cause.

## Usage does not reveal cache identity

Provider usage reports cache reads and writes. It does not reveal eviction cause,
routing, replica identity or cache entry identity. Matching token counts, including
512-token alignment, cannot establish those facts.

Cachemire therefore reports unexplained misses as `cause unknown`. It does not infer a
replica or an idle eviction from token arithmetic.

## Tree navigation follows the selected branch

Pi sessions are trees. Before each request, Cachemire resolves the cache lineage from
the active path. Each live billed call records its session leaf, assistant entry, prompt
usage, request time, provider, model, cache evidence and payload fingerprint.

The nearest billed call on the active path supplies the comparison baseline. Later
requests can refresh that baseline only when ancestry, provider, model, wire API and
payload fingerprints prove compatibility. A sibling with another model or prompt shape
cannot make the selected lineage look younger.

The stored prompt-side total is exact for the prior billed request. It remains only a
baseline for the next request, which adds a new suffix. Cachemire withholds a divergent
suffix estimate until provider usage makes the new request exact.

Restored snapshots retain provider usage, model identity and timestamps. GPT-5.6 and
later GPT-5 models keep their documented 30-minute minimum. Restored Anthropic routes
may use the `PI_CACHE_RETENTION` inference described above. Legacy OpenAI routes lose
request-only policy evidence, so their retention becomes unknown.

## Causes follow observed evidence

Every live request is fingerprinted across system instructions, tools, messages and
relevant parameters. Cachemire strips moving `cache_control` breakpoints before
comparison because Pi can move them between calls.

Causes resolve in this order:

1. a Pi compaction event
2. a named payload mutation, such as model, system, tools, history or thinking
3. a reached observed Anthropic TTL or observed 24-hour OpenAI maximum
4. unknown

The end of a 30-minute minimum is a state boundary, not a miss cause. Cachemire keeps
an unexplained miss unknown after that boundary.

The notice appears when a supported cause is known at send time. Provider usage updates
it in place with exact actuals. Progressive wording and `~` identify an in-flight
expectation. Past tense identifies a billed result. A send with no usage resolves to
`outcome unknown`.

A compaction warning stays unsized because Pi's event does not provide the next
provider-token split. The first normal billed call can compare its cache read with the
last normal pre-compaction prompt. `Reused` means the provider read an unchanged prefix.
It does not measure semantic conversation content retained by the compactor.

## Cross-model values do not mix

A model-switch forecast walks the content the target model will receive. It never
rescales the source model's billed count. Token density and prices do not transfer
between models.

The first billed call after a switch is classified against its own prompt. If it reads a
cached prefix, the resolved line can report that observed result. Cachemire does not use
an old-model count as the denominator.

## State stays UI-only

Working state lives in the extension process. Cachemire writes nothing to session
entries or exports.

On restore, Cachemire rebuilds its ledger and branch baselines from billed usage in
assistant messages. Payload fingerprints, request-start observations and live retention
fields are not persisted. Diagnoses that need those fields remain unknown.

Only the interactive Pi extension instance owns the process-global state. Nested
headless sessions cannot overwrite its ledger, clock or model metadata. The interactive
instance releases ownership on `session_shutdown`.
