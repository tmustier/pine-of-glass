# Cache retention audit, 4 August 2026

## Outcome

Cachemire can make elapsed-time claims for 2 policy types:

- Anthropic `cache_control` with a 5-minute or 1-hour TTL, with a restored-session
  inference from `PI_CACHE_RETENTION`
- the 24-hour maximum on a direct official OpenAI GPT-5 request below GPT-5.6 whose
  outgoing payload contains `prompt_cache_retention: "24h"`

All other routes have unknown retention. This includes GPT-5.6 and later, OpenAI
Codex OAuth, direct OpenAI requests without that field, and gateway routes.
Cachemire makes no idle-time or warmth claim for them.

## Evidence reviewed

We checked these sources on 4 August 2026:

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- installed Pi request builders in `pi-ai/dist/api/openai-responses.js`,
  `openai-codex-responses.js` and `anthropic-messages.js`
- installed Pi model records in `pi-ai/dist/providers/data/openai.json` and
  `openai-codex.json`
- Cachemire request, lifecycle, lineage and rendering paths

## Supported evidence

| Route | Evidence available to Cachemire | Safe runtime claim |
|---|---|---|
| Anthropic API, live request | outgoing `cache_control` contains a 5-minute or 1-hour TTL | show a TTL clock from the observed request time |
| Anthropic API, restored session | Pi resolves ordinary calls from `PI_CACHE_RETENTION` | infer 5 minutes, or 1 hour when the value is `long`, until a live payload replaces it |
| Direct official OpenAI API, GPT-5 below GPT-5.6 | actual outgoing payload contains `prompt_cache_retention: "24h"` | record a 24-hour maximum; stay neutral before it and mark stale when it is reached |
| Direct official OpenAI API, GPT-5 below GPT-5.6 without that field | no observed supported retention policy | keep retention unknown |
| Direct official OpenAI API for GPT-5.6 and later | the documentation does not provide a maximum that Cachemire can use as a freshness clock | keep retention unknown |
| OpenAI Codex OAuth | separate ChatGPT backend request shape with a cache key but no public API retention field | keep retention unknown |
| Other and gateway routes | no route-specific observed retention contract | keep retention unknown |

`in_memory` is not a supported Cachemire retention signal. Cachemire also has no
5-minute to 1-hour OpenAI band.

OpenAI documents a minimum for some GPT-5.6 breakpoint writes. A minimum does not
provide a maximum, prove that a read refreshed every breakpoint, or support an
idle-time warmth claim.

## Limits of provider usage

Provider usage proves how many tokens were read and written. It does not expose:

- eviction cause
- routing or replica identity
- cache entry identity

A 512-token alignment is not evidence of any of those facts. An unexplained miss
must remain unexplained.

The prior billed prompt-side token count is also not the whole next prompt. The next
request adds the new user message and other suffix content. Cachemire may use the prior
count as a labelled comparison baseline, but not as an exact next-request size.

## Guardrails

Retention resolution belongs in `extensions/pi-cachemire/retention.ts`. The route,
model and outgoing payload must all support the claim.

`tests/cachemire/retention-evidence.test.ts` covers the evidence matrix.
`tests/contract/pi-cache-retention-seams.test.ts` detects installed Pi request-shape
drift. Unknown retention must stay silent at every elapsed time.

Run `npm run check` after a retention change. Update the source date only after checking
the linked provider documentation again.
