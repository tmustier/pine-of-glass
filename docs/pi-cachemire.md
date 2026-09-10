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

The wider provider inventory and implementation record are in
[`cache-provider-stocktake-2026-08-05.md`](./cache-provider-stocktake-2026-08-05.md).
The [`GPT-6 Astra audit`](./cache-astra-audit-2026-09-08.md) records the newer model's
official contract, sanitized Codex observations and unresolved route limits. Cachemire
keeps an observed request policy pending until reported cache reads or writes confirm
that an entry exists. The
[`thinking-change audit`](./cache-thinking-change-audit-2026-09-10.md) records how
Pi 0.85.1 handles Claude Fable 5.1 and GPT-6 Astra effort changes.

## Moonshot and Together usage

Moonshot and some Together responses report cache reads in top-level
`usage.cached_tokens`. Pi 0.85.1 accounts for these reads natively, including cache-field
precedence and cost. Cachemire uses that normalized usage without a provider wrapper.
`tests/contract/pi-cache-retention-seams.test.ts` pins this behaviour with streamed
response fixtures. Cache reads alone do not provide retention evidence.

## Four rules shape the UI

1. Evidence: Cachemire distinguishes a TTL, a minimum, a maximum, a bounded
   minimum-to-maximum window and unknown retention. It does not turn a minimum lifetime
   into a maximum or a maximum into a prior warmth guarantee.
2. Scope: a cache entry belongs to a provider, model, wire API and byte-exact prefix.
   Model-switch checks require all 3 identity fields. A switch-back hint needs an active
   TTL or minimum, including the minimum phase of a bounded window. Unknown retention
   stays unknown until the next send reports usage.
3. Retention: Anthropic-compatible, MiniMax, Bedrock and Groq TTLs support countdowns
   and expiry claims. The GPT-5.6+ and GPT-6 Astra minimum blocks stale claims for 30
   minutes, then changes to unknown. An OpenAI maximum supports a stale claim only when
   reached. Cerebras's bounded window is warm before 5 minutes, unknown until 1 hour,
   then stale. Healthy
   states stay hidden.
4. Currency: exact token and cost numbers stay in the tokenizer and price card that
   billed them. A model-switch forecast is a labelled estimate in the target model's
   tokenizer. Exact values return with the first billed call on the new model.

## Confirmed clocks start at request time

The outgoing request supplies the clock anchor, but Cachemire does not activate its
window until normalized usage reports the required cache read or write. Generation time
therefore uses some of the TTL before the confirmed clock becomes visible.

A known 5-minute TTL appears during its final minute. A known 1-hour TTL appears during
its final 5 minutes. After expiry, the warning remains until the next provider call
reports the outcome.

A restored Anthropic session has no persisted `cache_control`. When persisted usage
contains a cache read or write, Cachemire mirrors Pi's ordinary-call default:
`PI_CACHE_RETENTION=long` means 1 hour, otherwise 5 minutes. The first confirmed live
payload replaces that inference.

For GPT-5.6+ models and GPT-6 Astra, OpenAI documents a 30-minute minimum. This default
applies on direct OpenAI Responses and OpenAI Codex routes. Cachemire stays silent during
the minimum. At the boundary it reports an unknown cache state because OpenAI may retain
the prefix longer.
Reaching the minimum does not classify a later miss as eviction.

For an observed 24-hour OpenAI maximum, Cachemire waits for a cache read, stays silent
before the maximum, and marks the cache stale once the maximum is reached. MiniMax M2.7
uses a confirmed 5-minute TTL. Documented Bedrock Claude models use their observed
5-minute or 1-hour cache point. Groq GPT-OSS uses a 2-hour inactivity TTL after a read.
Cerebras activates a bounded window after a read for every model on its direct
OpenAI Completions route. Cachemire can claim warmth before the guaranteed 5-minute
minimum, reports an unknown state from that boundary, and marks the cache stale only
when the 1-hour maximum is reached. Unknown routes remain silent at every elapsed time.

The widget schedules its next update at a known boundary. It updates once per second
only during the final 90 seconds of a visible countdown. Healthy and unknown states do
not trigger continuous renders.

## The displayed forecast is a prior-prompt baseline

The clock starts with `input + cacheRead + cacheWrite` from the last billed assistant
message. This is the prompt-side count for that completed request. It is not the whole
next prompt.

The next request adds the new user message and other suffix content. Shared prefixes
from another session can also reduce the actual write. The `~` marks this uncertainty.
After a model switch, Cachemire estimates canonical history in the target tokenizer
and keeps that estimate through send. A new user message or provider wrapper can make
the eventual billed count differ.

## Aborted sends do not create evidence

A request start is confirmed when Cachemire receives provider usage with cache evidence.

An abort or error with no usage proves nothing about the cache. Cachemire restores
the previous timestamp and retention policy. A first-send abort leaves no confirmed
clock to show.

## Thinking changes follow wire evidence

Cachemire fingerprints the wire form, not the Pi keystroke. Direct Anthropic Claude
Fable 5.1 preserves the prior cached prefix across effort changes. Pi's declared
`supportsMidConvoEffort` capability is the general form of that contract. Cachemire
therefore keeps the clock and notices silent for those routes even when the outgoing
effort value changes. Other Anthropic thinking changes can invalidate message cache
entries. A known Anthropic TTL therefore supports an in-flight warning when their
outgoing wire value changes. Levels that map to the same wire value stay silent.

GPT-6 Astra preserves the prefix only when the client appends a
`configuration_update` input item and leaves request-level `reasoning.effort`
unchanged. Pi 0.85.1 changes the request-level value instead, on both OpenAI Responses
implementations, so Cachemire continues to classify that observed difference as a
thinking mutation. A later Pi implementation of the append-only protocol will compare
as ordinary prefix growth without a model-name exception.

Unknown routes get no retention-based prediction. If billed usage later proves a miss,
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

Restored snapshots retain provider usage, model identity and timestamps. Only a
persisted cache read or supported write activates a recovered window. Exact model and API
checks recover GPT-5.6+, GPT-6 Astra, Anthropic, MiniMax, Groq and Cerebras policies. Bedrock and
legacy OpenAI routes lose request-only policy evidence, so their retention becomes
unknown.

## Causes follow observed evidence

Every live request is fingerprinted across system instructions, tools, messages and
relevant parameters. Cachemire excludes moving Anthropic `cache_control` and Bedrock
`cachePoint` markers from the comparison.

Causes resolve in this order:

1. a Pi compaction event
2. a named payload mutation, such as model, system, tools, history or thinking
3. a reached active TTL or retention maximum
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

Working state and rendered output live in the extension process. Cachemire adds no custom
session entries or exports. Pi normalizes and persists provider usage through its
normal session lifecycle.

On hot reload, Cachemire reattaches the process-live payload fingerprints to their
persisted provider calls. Tool-schema and other prefix changes introduced by the reload
therefore remain diagnosable. On process restart or session resume, Cachemire rebuilds
its ledger and branch baselines from billed usage in assistant messages. Payload
fingerprints, request-start observations and live retention fields are not persisted;
diagnoses that need those fields remain unknown.

Only the interactive Pi extension instance owns the process-global state. Nested
headless sessions cannot overwrite its ledger, clock or model metadata. The interactive
instance releases ownership on `session_shutdown`.
