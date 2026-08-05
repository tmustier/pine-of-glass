# pi-cachemire

> **Status: experimental.** Cachemire has been part of the `pine-of-glass`
> package since `0.4.0`. Its wording, thresholds and states may change without
> notice. Follow [Cachemire tracking issue 6](https://github.com/tmustier/pine-of-glass/issues/6)
> for updates.

Use Cachemire to understand the cache and agent-loop costs of a pi session.
Pi's footer counts input, output, cache reads, cache writes and cost. Cachemire
shows observed cache outcomes, names supported causes and warns at known retention
boundaries.

![Turn ledger lines in the transcript, a resolved break notice naming its cause (thinking changed), and the cache clock above the editor](../../docs/img/pi-cachemire-clock.png)

## Get warned before the cache expires

Cachemire stays hidden while the cache is healthy or its retention is unknown. It
appears above the input box only at a supported retention boundary, or when a change
such as compaction or a model switch puts the next send at risk.

<!-- BEGIN GENERATED CACHE RETENTION: policy-table -->
| Route | Retention evidence | Cachemire behaviour | Evidence source |
|---|---|---|---|
| Direct Anthropic | live `cache_control`, or Pi's restored-session retention default | activate the observed or inferred TTL after a cache read or write | [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), Installed Pi request builders and model records |
| OpenAI or OpenAI Codex, GPT-5.6 and later GPT-5 models | documented `prompt_cache_options.ttl` default | after a cache read or write, use the 30m minimum; then show that the cache state is unknown | [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), Installed Pi request builders and model records |
| Direct official OpenAI API, GPT-5 below GPT-5.6 | outgoing payload contains `prompt_cache_retention: "24h"` | after a cache read, record a 24h maximum with no warmth claim before it | [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), Installed Pi request builders and model records |
| MiniMax M2.7, global and China routes | outgoing 5-minute `cache_control` on an M2.7 model | activate the 5-minute TTL after a cache read or write | [MiniMax Anthropic-compatible caching](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache.md), Installed Pi request builders and model records |
| Amazon Bedrock, documented Claude 4.5 and 4.6 models | outgoing `cachePoint` with a model-supported TTL | activate the 5-minute or 1-hour TTL after a cache read or write | [Amazon Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), Installed Pi request builders and model records |
| Groq GPT-OSS models | automatic cache read on a documented GPT-OSS model | start or refresh the 2-hour inactivity TTL after a cache read | [Groq prompt caching](https://console.groq.com/docs/prompt-caching), Installed Pi request builders and model records |
| Cerebras GPT-OSS 120B and GLM 4.7 | automatic cache read on a documented model | after a cache read, record a 1-hour maximum with no prior warmth claim | [Cerebras prompt caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching), Installed Pi request builders and model records |
<!-- END GENERATED CACHE RETENTION: policy-table -->

The table is generated from Cachemire's runtime policy registry. A minimum is not an
expiry, and unknown retention never earns an elapsed-time claim. Cachemire does not use
`in_memory` or an undocumented 5-minute to 1-hour OpenAI band as retention evidence.

The `~` re-write count starts from the prior billed prompt-side usage. It is not the
whole next prompt, which adds your new message and other suffix content. After a model
switch, Cachemire estimates canonical history in the new model's tokenizer and keeps
that estimate through send. A new message or gateway rewrite can make the eventual
provider count differ.

<!-- BEGIN GENERATED CACHE RETENTION: clock-examples -->
```text
◍ cache expires in 30s · next send may re-write ~109.8k (~$1.37)
◍ cache state unknown · 30m retention minimum reached · next send may re-send ~109.8k uncached (~$1.37)
◍ cache stale · 24h retention maximum reached · next send may re-send ~109.8k uncached (~$1.37)
◍ cache stale · TTL expired · next send may re-write ~109.8k (~$1.37)
◍ cache stale after compaction · next send may re-write changed history
```
<!-- END GENERATED CACHE RETENTION: clock-examples -->

## Find out why the cache broke

Cachemire fingerprints every request, including the system prompt, each tool and
each history message. If a call's `cacheRead` collapses, the break notice names a cause
only when payload or retention evidence supports it. Otherwise it reports the cause as
unknown. Provider usage does not reveal eviction, routing, replica or cache entry
identity.

The notice appears at send time, where Cachemire can tie it to the request. It
updates in place when usage arrives. Progressive wording and `~` show an in-flight
expectation. Past-tense wording shows exact actuals.

Healthy caches stay quiet. Notices appear only above a materiality threshold. The
default threshold is $0.05 or 20k re-written tokens.

```
◍ cache breaking · re-writing ~138.2k (~$2.59) · cause: 5m TTL reached after 9h50m idle   (in flight)
◍ cache after compaction · reused 34.9k of the last pre-compaction 72.5k prompt (48%) · processed 39.1k uncached
◍ cache broke · re-wrote 138.2k of 139.6k prompt (99%) · $0.52 · cause: 5m TTL reached after 9h50m idle
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

The example below is a live capture. It shows a cold start, 2 hits and then an observed
miss. The notice names a thinking-level change only when the request fingerprint supports
that cause.

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

You do not need to press anything. Warnings appear above the editor when the cache needs
attention, notices appear automatically and the turn line follows each turn. Run `/cache`
to print the per-call ledger table.

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
- Freshness wording follows the generated policy table above. Unknown retention stays
  silent. Under subscription auth, Cachemire marks savings as notional.
- Sessions restored with `--continue` rebuild the active ledger and all-branch cache
  baselines from session usage. Cachemire marks restored rows and excludes them from
  savings because their pricing context is unknown. Model-level policies resolve through
  the same registry; request-only payload evidence does not survive restore.

## Understand the model behind the wording

Cachemire uses 4 rules:

- **Evidence** distinguishes a TTL, a minimum, a maximum and unknown retention.
- **Scope** ties a cache entry to the provider, model, wire API and byte-exact prefix.
  Switch-back warmth needs exact identity and an active TTL or minimum. Unknown
  retention waits for billed usage.
- **Retention** follows the generated policy table. It makes no elapsed-time claim for
  unknown routes.
- **Currency** keeps exact tokens and cost in the tokenizer and price card that billed
  them. Cross-model sizes are labelled estimates in the target currency. A prior billed
  prompt count is a baseline, not the whole next prompt.

Read the [retention audit](../../docs/cache-retention-audit-2026-08-04.md) for policy
evidence and [`docs/pi-cachemire.md`](../../docs/pi-cachemire.md) for lifecycle semantics.

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
