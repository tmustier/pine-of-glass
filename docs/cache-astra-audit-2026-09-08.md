# GPT-6 Astra cache and context audit, 8 September 2026

## Decision

Cachemire treats the exact `gpt-6-astra` model ID like GPT-5.6+ on direct OpenAI
Responses and OpenAI Codex Responses routes: a confirmed cache read or write starts the
documented 30-minute minimum. Gateway, Azure, Chat Completions and other GPT-6 family
IDs remain unknown. The reviewed sources did not establish a dated Astra model ID, so
no dated suffix is inferred.

Contextimate keeps its existing OpenAI heuristic numbers. Astra uses the existing
OpenAI or Codex profile selected by route and the documented keep-all reasoning rule;
the probe did not justify a tokenizer-number change.

## Official source claims

OpenAI's [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
states that GPT-5.6 and later models have a 1,024-token cacheable minimum and a cache
lifetime of at least 30 minutes after the latest write or reuse. The only supported
`prompt_cache_options.ttl` value is `30m`, which is also the default. The guide names
GPT-6 Astra when describing cache-preserving configuration updates.

OpenAI's [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls)
documents reasoning-context preservation. The
[GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra)
lists a 1,050,000-token context window, a 922,000-token input limit and a 128,000-token
maximum output.

These are provider contracts. They do not prove that Pi sends an explicit TTL or
reasoning-context value on every route, or that a particular live cache entry remains
available beyond the minimum.

## Sanitized Codex observations

A parallel read-only audit ran sanitized OpenAI Codex probes:

- Astra's first long-prompt response reported `input 3994`, `cacheRead 0`,
  `cacheWrite 0`. The second reported `input 170`, `cacheRead 3840`, for 4,010 prompt
  tokens in total. This confirms a live Codex cache read, not an exposed write event.
- One tokenizer comparison used the same 2,477-character system text and 31-character
  user text. Astra, Sol, Terra and Luna each reported 549 input tokens. This narrow
  equality does not justify a new Astra heuristic.
- A two-turn Astra reasoning probe reported 27 reasoning tokens on the first response.
  Pi preserved the encrypted reasoning carrier, and prompt input rose from 570 to 628
  tokens on the next response.

Pi does not expose the effective `reasoning.context` field for that Codex request. The
carrier and token increase are compatible with retained reasoning, but do not
conclusively verify that the live service applied `all_turns`.

## Unverified and route-specific limits

Direct OpenAI API cache writes were not live verified. Cachemire therefore relies on the
official GPT-5.6+ contract and activates Astra's minimum only after normalized read or
write usage confirms an entry.

The installed Pi 0.85.1 direct OpenAI and Codex model records both expose
`gpt-6-astra`, but set `contextWindow` to 272,000 and `maxTokens` to 128,000. The
official model page lists the larger 1,050,000-token window and 922,000-token input
limit. The effective Codex route cap is uncertain. This audit makes no Pi core or model
catalogue change.
