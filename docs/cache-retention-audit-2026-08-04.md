# Cache retention audit, 4 August 2026

Corrected on 5 August 2026 after rechecking the GPT-5.6 model-family default.

## Outcome

The generated evidence matrix and runtime resolution use the same typed registry.

## Evidence reviewed

<!-- BEGIN GENERATED CACHE RETENTION: evidence-sources -->
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), reviewed 5 August 2026: GPT-5.6 minimum eligibility and legacy extended retention
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), reviewed 4 August 2026: ephemeral cache TTL contracts
- Installed Pi request builders and model records, reviewed 5 August 2026: `pi-ai/dist/api/openai-responses.js`, `openai-codex-responses.js`, `anthropic-messages.js` and the OpenAI model records
<!-- END GENERATED CACHE RETENTION: evidence-sources -->

We also checked Cachemire's request, lifecycle, lineage and rendering paths.

OpenAI states that `prompt_cache_options.ttl` applies to GPT-5.6 and later model
families. Its only supported value is `30m`, which is also the default. A cached prefix
remains eligible for reuse for at least 30 minutes. OpenAI may retain it longer. The
model-family default also applies when the client omits the field, including Pi's Codex
request shape.

## Supported evidence

<!-- BEGIN GENERATED CACHE RETENTION: policy-table -->
| Route | Retention evidence | Cachemire behaviour | Evidence source |
|---|---|---|---|
| Anthropic, live request | `cache_control` contains a 5m or 1h TTL | use the observed TTL | [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), Installed Pi request builders and model records |
| Anthropic, restored session | Pi resolves ordinary calls from `PI_CACHE_RETENTION` | infer 5m, or 1h when set to `long`, until a live payload replaces it | Installed Pi request builders and model records |
| OpenAI or OpenAI Codex, GPT-5.6 and later GPT-5 models | documented `prompt_cache_options.ttl` default | use a 30m minimum; after it ends, show that the cache state is unknown | [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), Installed Pi request builders and model records |
| Direct official OpenAI API, GPT-5 below GPT-5.6 | outgoing payload contains `prompt_cache_retention: "24h"` | record a 24h maximum, with no warmth claim before it | [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), Installed Pi request builders and model records |
<!-- END GENERATED CACHE RETENTION: policy-table -->

`in_memory` is not a supported Cachemire retention signal. Cachemire also has no
5-minute to 1-hour OpenAI band.

A minimum does not provide a maximum. Reaching 30 minutes does not prove eviction or
explain a miss. Cachemire changes the clock to `cache state unknown` at that boundary.

## Limits of provider usage

Provider usage proves how many tokens were read and written. It does not expose:

- eviction cause
- routing or replica identity
- cache entry identity

A 512-token alignment is not evidence of any of those facts. An unexplained miss must
remain unexplained.

The prior billed prompt-side token count is also not the whole next prompt. The next
request adds the new user message and other suffix content. Cachemire may use the prior
count as a labelled comparison baseline, but not as an exact next-request size.
