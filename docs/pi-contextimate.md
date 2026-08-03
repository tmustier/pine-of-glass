# How pi-contextimate counts context

`[Contextimate]` explains what fills the context window. Estimated numbers carry a `~`. `Total request` is exact unless Pi has added a local estimate for trailing messages.

Provider profiles live in `extensions/pi-contextimate/model-heuristics.ts`. Session accounting lives in `extensions/pi-contextimate/session-accounting.ts`.

## Count what the provider sees

Local object size is not context size. Pi's provider adapters reshape everything before sending: for example, OpenAI Responses tools go out as compact `{ type, name, description, parameters, strict }` objects, Anthropic tools as `{ name, description, input_schema }`. Counting anything else, above all pretty-printed or debug JSON, produces confident nonsense.

The founding measurement (2026-06-02, fresh `gpt-5.5`, prompt `hi`):

- the provider reported ~19.0k input tokens
- the inspector's first version, counting pretty-printed schema JSON at chars ÷ 4, claimed ~37.2k
- for the 23 default tools alone, the provider's measured cost was ~5.9k tokens; the raw minified schema JSON through the `o200k_base` tokenizer gave ~10.8k, and pretty-printed JSON at chars ÷ 4 gave ~22.9k

Providers convert tool schemas into an internal function representation, so no raw JSON count reproduces their number. Hence the policy:

- text sections count provider-visible text with a per-model divisor
- tool sections count the minified provider-shaped payload, the same JSON Pi's adapter sends
- OpenAI-style tools use a schema-summary formula instead of a divisor (below)
- unknown providers fall back to chars ÷ 4

## Text divisors by model

Divisors were measured with Anthropic's `messages/count_tokens` endpoint and controlled live probes, against the same payloads Pi sends (2026-06-02).

The decisive finding: Claude 4.7 changed tokenizer accounting. The identical captured Pi request counts 29,258 input tokens on `claude-opus-4-5` and 40,758 on `claude-opus-4-7`, and the count endpoint matched live accounting within 15 tokens. Against real Pi startup material this puts Claude 4.5/4.6 near chars ÷ 3.5 to 3.8 and Claude 4.7/4.8 near chars ÷ 2.6. OpenAI-Codex markdown-ish system text measured close to chars ÷ 4.

The same payload produced effectively the same count on Claude Opus 4.8, Fable 5 and Opus 5. Contextimate applies the Claude 4.7+ text ratio to those models, including explicit Radius and OpenRouter relays. Tool payload counting still follows the route.

Divisors depend on content shape: repetitive prose tokenizes around chars ÷ 7, JSON-ish text heavier, markdown heavier still. The shipped values are calibrated to Pi-shaped material (system prompts, AGENTS.md, skill index), not universal constants.

The session divisors were validated by replaying 194 local session transcripts (16,479 assistant turns) against recorded provider usage: chars ÷ 2.6 beat a blanket chars ÷ 4 on 20 of 24 Anthropic transcripts, with median error 0.6 to 2.1% against 2.8 to 4.7%. OpenAI-Codex session material sits at chars ÷ 4, so the blanket value is already right there. `pi-contextimate-evaluate-transcripts` re-runs this evaluation.

## Tool schemas

Raw size fails in both directions: minified JSON at chars ÷ 4 overcounts OpenAI schemas by roughly 2x, and no single divisor tracks schema shape (enums, nesting, description length).

For OpenAI-style function tools the extension uses the OpenAI Cookbook-style local formula: fixed constants per function, per property level, per property and per enum value, plus schema text fragments (`name:description`, `propertyName:type:description`, enum values) estimated at chars ÷ 6.6. OpenAI's [token-counting docs](https://developers.openai.com/api/docs/guides/token-counting) say tools are hard to count locally and recommend their count endpoint; the [Cookbook formula](https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken) is the public local approximation, and the extension stays local to avoid startup network calls (which are also unavailable on Codex OAuth auth).

A synthetic schema ablation (2026-06-03: 20 schema shapes from empty to deeply nested, singletons and mixed subsets, constants fitted on two thirds of singletons only) validated it on held-out cases:

```text
method                         held-out MAPE
recursive formula, text ÷ 6.6       9.1%
fitted raw divisor (÷ 7.215)       13.1%
raw minified chars ÷ 5.5           33.2%
raw minified chars ÷ 4             78.4%
```

Two changes made the formula win: counting nested-object and array-item properties recursively, and moving text fragments from chars ÷ 4 to chars ÷ 6.6.

Anthropic tool payloads measured near their text divisors (÷ 3.36 on Claude 4.5/4.6, ÷ 2.5 on Claude 4.7+), so they use plain divisors of 3.3 and 2.6 on the Anthropic-shaped payload. Chat-style and plain Responses tools use ÷ 5.5 (measured on OpenAI-Codex live probes); Gemini and Bedrock use ÷ 4 until someone measures them.

In the UI, a formula-counted tools row says `OpenAI formula · schema text ÷ 6.6` and its character count is a payload-size cue only: it is not what gets divided. Divisor-counted rows say things like `÷ 2.6 · Anthropic tool payload`. Each tool's own row is counted on that tool's own shaped payload or formula subtotal, and the schema tree is just the readable rendering of it.

## Session rows and the total

`Total request` starts with Pi's context total. On Codex GPT-5.3 to GPT-5.5, Contextimate adds earlier reasoning that OpenAI omitted. It uses Pi's stored token count only when the response has an encrypted reasoning item from the same provider, API and model. GPT-5.6 already includes these tokens. Ordinary OpenAI and Azure totals are unchanged.

The session split stays simple:

```text
Tool outputs:        y       estimated from tool output
Messages:            z       estimated from messages and tool calls
Other / reasoning:   x-y-z   everything else
Total session:       x       request total minus the estimated static prefix
```

Contextimate does not estimate reasoning from summary text or encrypted data size. The correction changes the total only; it does not add a special label. Pi's native context display and compaction are unchanged.

After compaction, Pi deliberately reports usage as unknown until the next assistant response arrives. The panel then falls back to its heuristic estimate and labels the whole total as heuristic.

Upstream Codex ([`openai/codex` at `0c5ccd1`](https://github.com/openai/codex/tree/0c5ccd18abda96efaed9e94e26ffe22def5e28ed)) chooses differently: after compaction it writes a purely local estimate into its active-context number (base instructions at chars ÷ 4, per-item serialized-JSON byte estimates, special cases for encrypted reasoning blobs, encrypted tool outputs and images). Contextimate does not copy this, because a provider-usage field that sometimes holds local guesses can no longer be trusted as provider usage. Pi's explicit unknown plus a labelled heuristic keeps the two sources honest. The full annotated comparison, with line-level citations to the Codex source, is in git history (`docs/pi-contextimate-codex-context-accounting.md`).

## Configuration

The extension reads optional JSON config from, in order:

1. `~/.pi/agent/pi-contextimate.json`
2. `<cwd>/.pi/pi-contextimate.json`
3. any colon-separated paths in `PI_CONTEXTIMATE_CONFIG`

Later files override scalar fields, `profiles` merge by name, and `rules` append (later matching rules win). A profile is a reusable counting recipe; a rule selects a profile by provider, model or API, and can override any field inline:

```json
{
  "profiles": {
    "openai-like": {
      "label": "OpenAI-like chars/4 profile",
      "textDenominator": 4,
      "sessionDenominator": 4,
      "toolDenominator": 5.5,
      "toolNumerator": "openai-responses"
    }
  },
  "defaults": { "profile": "openai-like" },
  "rules": [
    {
      "profile": "openai-like",
      "label": "My proxy uses chat function tools",
      "match": { "provider": "my-proxy", "api": "openai-completions" },
      "toolNumerator": "openai-chat"
    }
  ]
}
```

`match` values take exact strings, `*`/`?` globs, or regex strings like `"/claude.*4-8/i"`. Built-in rules cannot be disabled, but a later matching custom rule shadows their values.

`toolNumerator` picks the payload shape to count:

- `openai-cookbook`: the local formula above (the OpenAI-Codex default; the name is kept for config compatibility)
- `openai-responses` / `openai-codex-responses`: Responses-style function objects
- `openai-chat` / `openai-completions` / `mistral`: Chat Completions-style `{ type, function }` objects
- `anthropic`: `{ name, description, input_schema }`
- `gemini` / `google` / `vertex`: `{ functionDeclarations: [...] }`
- `bedrock`: `{ toolSpec: ... }`
- `raw-schema`: the unshaped schema, as a fallback

Unknown names fall back to the Responses shape. Custom `toolShapes` templates and the legacy `prefix-inspector.json` config paths were removed in 0.4.0: a configurable approximation cannot beat measuring the real payload.

## Recalibrating for a new provider or model

1. Capture what Pi actually sends: `pi-contextimate-probe-prefix`.
2. Get provider-exact counts and suggested divisors from the captured payload: `pi-contextimate-check-provider-tokens` (Anthropic counts are free; OpenAI probes cost a fraction of a cent).
3. Paste the suggested values into a `rules` entry, with the closest built-in `toolNumerator` shape.

If the provider has no count endpoint, run controlled live probes instead: hold everything else constant, vary one section, and subtract a minimal baseline from the recorded usage. Record chars per token separately for prose and for tool schemas; they usually differ. [`scripts/contextimate/README.md`](../scripts/contextimate/README.md) documents the scripts, credentials and safety notes (captured payloads can contain sensitive prompt data; keep them local).
