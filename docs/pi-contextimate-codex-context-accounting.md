# Codex context-accounting comparison for pi-contextimate

This note captures how upstream OpenAI Codex estimates active context usage, especially around interruption and compaction, so `pi-contextimate` can compare its own policy against Codex without mixing the two models.

Source snapshot used for this note: `openai/codex` commit [`0c5ccd18abda96efaed9e94e26ffe22def5e28ed`](https://github.com/openai/codex/tree/0c5ccd18abda96efaed9e94e26ffe22def5e28ed).

## Executive summary

Codex keeps two token-usage concepts:

- `total_token_usage`: accumulated session spend.
- `last_token_usage`: Codex's active-context number, used by the CLI/TUI context-window indicator.

For normal completed model turns, `last_token_usage.total_tokens` comes from provider usage on `response.completed`. When local history has grown after that last successful response, Codex adds an estimate for every item after the most recent model-generated item.

For compaction, Codex does **not** wait for a later assistant response to get a fresh provider usage number. After installing compacted history it recomputes a local estimate and writes that estimate into `last_token_usage.total_tokens`.

Pi currently differs: after compaction, if there is no post-compaction assistant usage yet, Pi can report context usage as `null`/unknown and let the inspector fall back to heuristics.

## Latest active-context estimate

Codex's active-context estimator is:

```text
active_context_tokens = latest_provider_last_token_usage.total_tokens
                      + estimated_tokens_of_items_after_last_model_generated_item
```

There is one extra branch: if the server has not indicated that past reasoning is included, Codex also adds estimated tokens for non-last encrypted reasoning items.

Important boundary: `items_after_last_model_generated_item()` starts after the newest model-generated item. Model-generated items include assistant messages, reasoning, function/tool calls, shell calls, web/search/image calls, compaction items, and context-compaction items. Tool outputs and new user messages after that boundary are estimated locally.

Source:

- [`ContextManager::items_after_last_model_generated_item`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L303-L310)
- [`ContextManager::get_total_token_usage`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L314-L331)
- [`ContextManager::get_total_token_usage_breakdown`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L334-L358)

## Text and item token heuristic

Plain text uses a four-bytes-per-token heuristic:

```text
approx_token_count(text) = ceil(text.length / 4)
approx_tokens_from_byte_count(bytes) = ceil(bytes / 4)
```

For full history items:

```text
estimate_item_token_count(item) = ceil(model_visible_bytes(item) / 4)
```

Source:

- [`approx_token_count`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/utils/string/src/truncate.rs#L71-L83)
- [`estimate_item_token_count`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L516-L518)

## What Codex means by “model-visible bytes”

“Model-visible bytes” is Codex's local proxy for what counts toward context, not simply local object size and not necessarily human-visible text.

For ordinary `ResponseItem`s, Codex starts with `serde_json::to_string(item).len()` and then adjusts special payloads:

1. Inline image data URLs: subtract raw base64 payload bytes and add an image-cost estimate.
2. Encrypted function-output content items: subtract the encrypted string length and add a smaller decoded-size estimate.
3. Encrypted reasoning / compaction blocks: do not use serialized JSON length; estimate from encrypted payload length.

Source: [`estimate_response_item_model_visible_bytes`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L543-L570).

### Encrypted reasoning / compaction blocks

For these items:

- `ResponseItem::Reasoning { encrypted_content: Some(...) }`
- `ResponseItem::Compaction { encrypted_content }`
- `ResponseItem::ContextCompaction { encrypted_content: Some(...) }`

Codex estimates:

```text
model_visible_bytes = max(0, floor(encrypted_content.length * 3 / 4) - 650)
tokens              = ceil(model_visible_bytes / 4)
```

So yes: this is effectively an estimate for opaque encrypted thinking / compaction payloads that are carried client-side and replayed into later requests. It is not counting visible reasoning-summary text; it is estimating the model-visible cost of the encrypted carry-forward blob.

Source:

- [`estimate_reasoning_length`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L504-L509)
- reasoning/compaction branch in [`estimate_response_item_model_visible_bytes`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L543-L555)

### Encrypted function outputs

Encrypted function-output content uses a different adjustment:

```text
replacement_bytes = ceil(encrypted_content.length * 9 / 16)
```

Source:

- [`estimate_encrypted_function_output_length`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L512-L513)
- [`encrypted_function_output_estimate_adjustment`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L692-L714)

### Images

For non-`original` image detail, Codex replaces the base64 image payload with a fixed byte estimate:

```text
RESIZED_IMAGE_BYTES_ESTIMATE = 7,373 bytes
≈ 1,844 tokens with ceil(bytes / 4)
```

For `detail: "original"`, Codex attempts to decode dimensions and estimates a 32px patch count capped at 10,000 patches, then converts patches to bytes with the same four-bytes-per-token helper.

Source:

- image constants and comment: [`history.rs#L521-L533`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L521-L533)
- original-detail patch estimate: [`history.rs#L609-L642`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L609-L642)

## Post-compaction estimate

After compaction, Codex replaces the in-memory history and then calls `recompute_token_usage()`.

That recompute does:

```text
post_compaction_context_tokens = ceil(base_instructions.length / 4)
                               + sum(estimate_item_token_count(item) for item in compacted_history)
```

Then it stores:

```text
last_token_usage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: post_compaction_context_tokens
}
```

Source:

- [`ContextManager::estimate_token_count_with_base_instructions`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/context_manager/history.rs#L149-L162)
- [`Session::recompute_token_usage`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/session/mod.rs#L2970-L3005)
- local compaction calls recompute after replacement: [`compact.rs#L292-L294`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact.rs#L292-L294)
- remote compaction calls recompute after replacement: [`compact_remote.rs#L261-L263`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote.rs#L261-L263)
- remote compaction v2 calls recompute after replacement: [`compact_remote_v2.rs#L275-L277`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote_v2.rs#L275-L277)

## What is in compacted history

### Local summarization compaction

Local compaction builds replacement history from:

1. retained recent user messages, capped by `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` using `chars / 4`;
2. a user-role summary message;
3. optionally re-injected initial context before the last real user message.

Source:

- token cap: [`compact.rs#L47-L49`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact.rs#L47-L49)
- replacement history builder: [`compact.rs#L474-L538`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact.rs#L474-L538)

### Remote compaction v2

Remote compaction v2 constructs a compact request by appending `ResponseItem::CompactionTrigger` to the prompt input. The compacted history it installs is:

1. retained `user` / `developer` / `system` messages from the prompt input;
2. filtered through `should_keep_compacted_history_item`;
3. truncated newest-first to `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` approximate text tokens;
4. appended with the returned `ResponseItem::Compaction { encrypted_content }`.

The returned encrypted compaction item is exactly the kind of opaque payload covered by the encrypted-block estimate above.

Source:

- retained cap: [`compact_remote_v2.rs#L48-L50`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote_v2.rs#L48-L50)
- request appends `CompactionTrigger`: [`compact_remote_v2.rs#L209-L217`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote_v2.rs#L209-L217)
- compacted-history shape: [`compact_remote_v2.rs#L409-L421`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote_v2.rs#L409-L421)
- newest-first retained-message truncation: [`compact_remote_v2.rs#L433-L456`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote_v2.rs#L433-L456)

## Remote-compaction failure diagnostics

When remote compaction fails, Codex logs both:

- `last_api_response_total_tokens`
- `all_history_items_model_visible_bytes`
- `estimated_tokens_of_items_added_since_last_successful_api_response`
- `estimated_bytes_of_items_added_since_last_successful_api_response`
- `failing_compaction_request_model_visible_bytes`

The failing request byte estimate is:

```text
instructions.length + sum(model_visible_bytes(input_item))
```

Source: [`compact_remote.rs#L335-L373`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote.rs#L335-L373).

Before remote compaction, Codex also tries to trim trailing Codex-generated history while the full estimate exceeds the context window. It only removes trailing Codex-generated items, not arbitrary user history.

Source: [`trim_function_call_history_to_fit_context_window`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/compact_remote.rs#L376-L402).

## Interruption behavior

If a turn is interrupted before `response.completed`, Codex does not have fresh provider token usage for the partial turn. It records a model-visible interrupted-turn marker and emits `TurnAborted`, but it does not synthesize a new provider-like `TokenCount` from the partial response.

Any later active-context calculation therefore falls back to the previous `last_token_usage.total_tokens` plus the local post-model tail estimate described above.

Source:

- interrupted-turn marker: [`tasks/mod.rs#L87-L106`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/tasks/mod.rs#L87-L106)
- abort records marker and emits `TurnAborted`: [`tasks/mod.rs#L811-L864`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/tasks/mod.rs#L811-L864)
- provider usage is recorded on `ResponseEvent::Completed`: [`turn.rs#L2000-L2014`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/core/src/session/turn.rs#L2000-L2014)

## TUI/status implication

Codex's UI uses `last_token_usage`, not accumulated `total_token_usage`, for context-window percentage.

Source:

- TUI token model: [`tui/src/token_usage.rs#L37-L50`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/tui/src/token_usage.rs#L37-L50)
- status card uses `last_token_usage`: [`status/card.rs#L327-L337`](https://github.com/openai/codex/blob/0c5ccd18abda96efaed9e94e26ffe22def5e28ed/codex-rs/tui/src/status/card.rs#L327-L337)

## Comparison policy for pi-contextimate

Recommended interpretation for `pi-contextimate`:

1. Keep Pi's top-line current-context usage as source of truth when `ctx.getContextUsage()` returns tokens.
2. Keep Pi's post-compaction `null`/unknown behavior explicit; do not silently pretend a provider usage exists.
3. Use Codex's method only as a comparison or optional Codex-native fallback after compaction:
   - base instructions `chars / 4`;
   - provider-shaped Responses items via serialized JSON bytes;
   - special estimates for encrypted reasoning / compaction blocks if Pi is actually replaying Codex-native encrypted items.
4. Do **not** estimate hidden thinking from arbitrary local encrypted/signature string length unless that string is actually a provider-native item being replayed into the model. Otherwise keep Pi's current residual bucket:

```text
Other / reasoning = Pi current-context total - locally countable visible pieces
```

That residual is safer because it absorbs opaque reasoning replay, provider overhead, images/weird blocks, and estimation error without claiming the encrypted chars are themselves the true context payload.
