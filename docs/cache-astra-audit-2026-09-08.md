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

A sanitized Codex probe produced a cache read on its second long-prompt request. A
separate two-turn probe preserved Astra's encrypted reasoning carrier and reported
reasoning usage, but Pi does not expose the effective `reasoning.context` value. This
does not conclusively verify `all_turns`.

A small tokenizer comparison did not justify changing Contextimate's estimates.

## Limits

Direct OpenAI cache writes were not tested live. The installed Pi 0.85.1 catalogue
lists Astra on both direct OpenAI and Codex routes, with a smaller context window than
OpenAI's model page. This change does not alter Pi's catalogue or infer route limits.
