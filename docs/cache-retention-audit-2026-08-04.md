# Cache retention audit, 4 August 2026

Corrected on 5 August 2026 after rechecking the GPT-5.6 model-family default.

## Outcome

The generated evidence matrix and runtime resolution use the same typed registry.

## Evidence reviewed

<!-- BEGIN GENERATED CACHE RETENTION: evidence-sources -->
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), reviewed 5 August 2026: GPT-5.6 minimum eligibility and legacy extended retention
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), reviewed 4 August 2026: ephemeral cache TTL contracts
- [MiniMax Anthropic-compatible caching](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache.md), reviewed 5 August 2026: M2.7 explicit 5-minute cache entries
- [Amazon Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), reviewed 5 August 2026: Claude cache points, model support and TTLs
- [Groq prompt caching](https://console.groq.com/docs/prompt-caching), reviewed 5 August 2026: GPT-OSS cache support and 2-hour inactivity expiry
- [Cerebras prompt caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching), reviewed 5 August 2026: supported models and the 1-hour maximum
- Installed Pi request builders and model records, reviewed 5 August 2026: Pi 0.83.0 provider payloads, normalized usage and generated model catalogue
<!-- END GENERATED CACHE RETENTION: evidence-sources -->

OpenAI states that `prompt_cache_options.ttl` applies to GPT-5.6 and later model
families. Its only supported value is `30m`, which is also the default. A cached prefix
remains eligible for reuse for at least 30 minutes. OpenAI may retain it longer. The
model-family default also applies when the client omits the field, including Pi's Codex
request shape.

## Supported evidence

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
