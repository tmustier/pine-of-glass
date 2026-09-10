# Thinking-change cache audit, 2026-09-10

This audit separates model capability from the wire protocol Pi 0.85.1 actually sends.
It covers direct Anthropic Claude Fable 5.1 and the configured OpenAI Codex route for
GPT-6 Astra.

## Verdict

| route | cache-safe effort change in Pi 0.85.1 | evidence | Cachemire policy |
|---|---|---|---|
| `anthropic/claude-fable-5-1` | yes | live high-to-low call read the full 13,303-token prior prefix | do not mark thinking stale or name it as a break cause |
| `openai-codex/gpt-6-astra` | no | live low-to-high call read 0 cached tokens while its low-to-low control read 5,888 | keep the changed request-level effort as a cache mutation |

These findings are route-specific. They do not establish the same behaviour for a
gateway that happens to expose either model name.

## Pi and provider contracts

Pi's installed Anthropic model catalogue marks Claude Fable 5.1 with
`supportsMidConvoEffort: true`. Its Anthropic request builder keeps the top-level
effort fixed, appends per-turn system effort markers and requests
`thinking.block_binding.prefix_mismatch_behavior: "drop_block"`. Assistant messages
retain their provider thinking level so the next request can reproduce prior turns.
This matches Anthropic's Fable 5.1-specific beta: a mid-conversation system message can
carry per-message `output_config.effort` without changing the cached prefix. Anthropic's
general rule still says changing request-level effort invalidates cache breakpoints.

The local `models.json` currently overrides the catalogue entry without that
compatibility flag. In that effective configuration Pi changes top-level
`output_config.effort` directly. The live high-to-low test still read the complete
15,103-token message-heavy prior prefix in a follow-up probe, so Cachemire treats the
exact direct Fable 5.1 route as cache-safe in this runtime as well as honouring Pi's
general compatibility flag. This observation does not extend to other models that use
request-level effort.

OpenAI's reasoning guide requires a different protocol for GPT-6 Astra: keep the
request-level `reasoning.effort` fixed and append this item before the next user
message:

```json
{
  "type": "configuration_update",
  "reasoning": { "effort": "high" }
}
```

Pi 0.85.1's OpenAI Responses and OpenAI Codex Responses request builders do not emit
that item. They set the current effort on the request-level reasoning field instead.
Cachemire needs no Astra model exception: the current payload difference remains a real
cache-key mutation, while a future append-only implementation will naturally retain
the old fingerprint as a prefix.

## Live checks

The probes used Pi's `ModelRuntime`, real provider authentication and a stable prefix
long enough to be cached.

### Claude Fable 5.1

The effective local high-to-low run included a genuine signed thinking block on the
first response:

- first call: 13,303 cache-write tokens, 0 cache-read tokens
- second call: 13,303 cache-read tokens, 585 cache-write tokens
- first response: 173 reasoning tokens

A second high-to-low probe moved the long stable prefix into the first user message and
kept the system prompt short. Its first call wrote 15,103 tokens; the follow-up read all
15,103 and wrote a 642-token suffix. This rules out a hit confined to stable system
instructions while message history was reprocessed.

Repeating with the built-in mid-conversation compatibility contract produced the same
full-prefix hit. Captured requests kept top-level effort at `high`, carried a historical
`high` system effort marker, then appended a `low` marker for the new turn.

A separate end-to-end Pi TUI run loaded the worktree extension and the effective local
model override. The model used the real Bash tool at `low`, switched to `high` through
Pi's thinking picker, then used Bash again. Cachemire showed no stale or break line. The
first 2-call turn line reported 2.5k read and 2.6k written; the 2-call turn after the
switch reported 5.2k read and 0.2k written. An independent file check confirmed both
tool mutations. This low-to-high result complements the high-to-low provider probe.

### GPT-6 Astra

Two fresh-session runs used the same stable prefix:

- low-to-low control: second call read 5,888 cached tokens and sent 169 uncached input
  tokens
- low-to-high change: second call read 0 cached tokens and sent 6,057 uncached input
  tokens

Captured Pi payloads changed request-level reasoning effort and contained no
`configuration_update` item.

## Addendum (same day): the hook position is not the wire

The Astra result above describes stock Pi. With `@howaboua/pi-codex-conversion`
3.0.31 active (its 3.0.26 release keeps request-level effort fixed and appends
OpenAI's `configuration_update` item on effort changes), the same low-to-high change
on `openai-codex/gpt-6-astra` kept reading the prior prefix: usage showed cache reads
above 98% of the prompt. Cachemire nevertheless saw a changed request-level effort
at its `before_provider_request` hook and warned about a break that never came.

Pi's extension runner (`dist/core/extensions/runner.js`) runs
`before_provider_request` per extension in load order and threads each replacement
payload only into later handlers; an extension-registered provider then transforms
the request after every hook. Whatever Cachemire reads at its hook is therefore the
payload at that position, not proof of the wire form. Inspecting further down the
chain is not available to an extension, and pinning Cachemire to another extension's
internals would tie it to one setup.

Cachemire now lets the bill outrank the payload. The static contract (Pi's
`supportsMidConvoEffort` flag or the verified direct Fable 5.1 route) sets the
expectation until an effort-to-effort change on a route is billed; from then on the
most recent billed verdict on that exact provider, API and model decides, for the
rest of the process. A hit on an effort the route has never billed records that the
route keeps its prefix; a miss the payload attributed to thinking, with no closed
retention window to blame, records that it breaks. Both directions stay observable:
the first hit against an expected break says so once, and a miss still names the wire
change. The contract suite pins the runner's hook order so a change there surfaces as
a failing test.

Live acceptance, same day, real `pi` 0.85.1 TUI in an isolated HOME with real tool
calls on `openai-codex/gpt-6-astra` and a ~10.5k-token prompt:

- Cachemire loaded before `pi-codex-conversion` (the live order): `low → high` hit,
  `cache held · read 10.4k of 10.5k expected · effort low → high kept the prefix warm
  on this route` printed once; `high → medium` hit silently; the `/cache` rows name
  both changes
- Cachemire loaded after it: same result on one run. On another run `high → medium`
  billed a genuine 100% miss which Cachemire reported as `cause: unknown` (its hook
  saw an append-only `configuration_update`, so thinking was not attributable) and
  left the held verdict alone; a repeat of that order hit throughout
- stock Pi, no conversion extension: `low → high` and `high → medium` each missed
  and were named `thinking changed`; `medium → high` then read 10.6k of 10.8k back.
  That hit is the `high` entry from two calls earlier, still within retention, not
  effort neutrality: it is why a hit counts as evidence only on an effort the route
  has never billed before

## Sources

- OpenAI, [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning),
  section "Change reasoning mid-conversation", accessed 2026-09-10
- OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
  section "Keep changing content after the breakpoint", accessed 2026-09-10
- Anthropic, [Effort](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta),
  section "Change effort mid-conversation", accessed 2026-09-10
- Anthropic,
  [Mid-conversation system messages and tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages),
  accessed 2026-09-10
- installed `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 0.85.1
