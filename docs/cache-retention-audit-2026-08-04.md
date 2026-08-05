# Cache retention audit, 4 August 2026

Corrected on 5 August 2026 after rechecking the GPT-5.6 model-family default.

## Outcome

Cachemire can make elapsed-time claims for 3 policy types:

- Anthropic `cache_control` with a 5-minute or 1-hour TTL, with a restored-session
  inference from `PI_CACHE_RETENTION`
- the 30-minute minimum for GPT-5.6 and later GPT-5 models on OpenAI and OpenAI Codex
- the 24-hour maximum on a direct official OpenAI GPT-5 request below GPT-5.6 whose
  outgoing payload contains `prompt_cache_retention: "24h"`

Other routes have unknown retention. Cachemire makes no idle-time claim for them.

## Evidence reviewed

We checked these sources on 4 August 2026 and rechecked OpenAI on 5 August 2026:

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- installed Pi request builders in `pi-ai/dist/api/openai-responses.js`,
  `openai-codex-responses.js` and `anthropic-messages.js`
- installed Pi model records in `pi-ai/dist/providers/data/openai.json` and
  `openai-codex.json`
- Cachemire request, lifecycle, lineage and rendering paths

OpenAI states that `prompt_cache_options.ttl` applies to GPT-5.6 and later model
families. Its only supported value is `30m`, which is also the default. A cached prefix
remains eligible for reuse for at least 30 minutes. OpenAI may retain it longer. The
model-family default also applies when the client omits the field, including Pi's Codex
request shape.

## Supported evidence

| Route | Evidence available to Cachemire | Safe runtime claim |
|---|---|---|
| Anthropic API, live request | outgoing `cache_control` contains a 5-minute or 1-hour TTL | show a TTL clock from the observed request time |
| Anthropic API, restored session | Pi resolves ordinary calls from `PI_CACHE_RETENTION` | infer 5 minutes, or 1 hour when the value is `long`, until a live payload replaces it |
| OpenAI or OpenAI Codex, GPT-5.6 and later GPT-5 models | documented model-family default | keep stale warnings off for 30 minutes; after that, say the cache state is unknown |
| Direct official OpenAI API, GPT-5 below GPT-5.6 | actual outgoing payload contains `prompt_cache_retention: "24h"` | record a 24-hour maximum; stay neutral before it and mark stale when it is reached |
| Direct official OpenAI API, GPT-5 below GPT-5.6 without that field | no observed supported retention policy | keep retention unknown |
| Other and gateway routes | no route-specific supported evidence | keep retention unknown |

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

## Guardrails

Retention resolution belongs in `extensions/pi-cachemire/retention.ts`. The route,
model, documented default and observed outgoing policy must support the claim.

`tests/cachemire/retention-evidence.test.ts` covers the evidence matrix.
`tests/contract/pi-cache-retention-seams.test.ts` detects installed Pi request-shape
drift. Unknown retention must stay silent at every elapsed time.

Run `npm run check` after a retention change. Update the source date only after checking
the linked provider documentation again.
