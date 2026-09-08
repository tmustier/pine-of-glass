# GPT-6 Astra cache and context audit, 8 September 2026

## Decision

Cachemire gives the exact `gpt-6-astra` ID the documented 30-minute minimum on
direct OpenAI Responses and OpenAI Codex Responses routes. It activates the minimum
only after a reported cache read or write. Other routes and GPT-6 IDs remain unknown.

Contextimate keeps its existing OpenAI heuristics. Its version rule classifies Astra as
keeping all prior reasoning, but OpenAI only explicitly documents the `all_turns`
default for GPT-5.6. Astra's effective default remains unverified.

## Evidence

OpenAI's [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
says GPT-5.6 and later models use a `30m` minimum by default and names GPT-6 Astra in
its cache-preserving configuration guidance.

Sanitized Codex probes found:

- cache reuse: the second request reported 170 uncached and 3,840 cached tokens
- token counts: Astra, Sol, Terra and Luna each reported 549 input tokens for the same prompt
- reasoning: Pi replayed Astra's encrypted carrier, but did not expose the effective
  `reasoning.context` value; this does not confirm `all_turns`

These observations do not justify changing Contextimate's estimates.

## Limits

Direct OpenAI cache writes were not tested live. The installed Pi 0.85.1 catalogue
lists a 272,000-token Astra window on direct OpenAI and Codex routes. The
[OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6-astra) lists
1,050,000. Codex's effective cap remains unverified; this change leaves Pi's catalogue alone.
