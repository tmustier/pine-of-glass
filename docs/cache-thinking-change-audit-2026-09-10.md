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
