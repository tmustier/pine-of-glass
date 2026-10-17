# How pi-contextimate counts context

`[Contextimate]` is an inspector, not a billing ledger. Its job is to explain why a session is large and which component is responsible, accurately enough to act on. Every heuristic number carries a `~`. `Total request` drops the marker only when Pi's current total comes entirely from the latest trusted provider usage; local estimates for trailing messages keep it.

This note records the counting policy, the evidence behind it, and the user configuration. Live provider profiles are in `extensions/_lib/heuristics.ts`, tool formulas are in `extensions/_lib/tool-payloads.ts`, and active-path accounting is in `extensions/pi-contextimate/session-accounting.ts`. This note explains why they hold the values they do; it does not duplicate them.

The [tokenizer coverage audit](./contextimate-tokenizer-coverage-audit-2026-08-05.md) maps Pi's complete model catalog to provider count endpoints, public tokenizers and realistic calibration methods.

## Count what the provider sees

Local object size is not context size. Pi's provider adapters reshape everything before sending: for example, OpenAI Responses tools go out as compact `{ type, name, description, parameters, strict }` objects, Anthropic tools as `{ name, description, input_schema }`. Counting anything else, above all pretty-printed or debug JSON, produces confident nonsense.

The founding measurement (2026-06-02, fresh `gpt-5.5`, prompt `hi`):

- the provider reported ~19.0k input tokens
- the inspector's first version, counting pretty-printed schema JSON at chars ÷ 4, claimed ~37.2k
- for the 23 default tools alone, the provider's measured cost was ~5.9k tokens; the raw minified schema JSON through the `o200k_base` tokenizer gave ~10.8k, and pretty-printed JSON at chars ÷ 4 gave ~22.9k

Providers convert tool schemas into an internal function representation, so no raw JSON count reproduces their number. Hence the policy:

- text sections use the identified model family's divisor
- the wire API selects the tool payload shape independently
- OpenAI-style tools use a schema-summary formula instead of a divisor (below)
- unidentified model families fall back to chars ÷ 4

## Text divisors by model

Divisors were measured with Anthropic's `messages/count_tokens` endpoint and controlled live probes, against the same payloads Pi sends (2026-06-02).

The decisive finding: Claude 4.7 changed tokenizer accounting. The identical captured Pi request counts 29,258 input tokens on `claude-opus-4-5` and 40,758 on `claude-opus-4-7`, and the count endpoint matched live accounting within 15 tokens. Against real Pi startup material this puts Claude 4.5/4.6 near chars ÷ 3.5 to 3.8 and Claude 4.7/4.8 near chars ÷ 2.6. Claude 5-generation ids (`claude-fable-5`, `claude-opus-5`) keep the post-4.7 accounting and get the same ÷ 2.6 rule; a live fable-5 request measured well below the generic anthropic ÷ 3.5 default. OpenAI text is recalibrated below.

A follow-up count on 3 August 2026 established the Claude 4.7+ family boundary. One byte-identical Pi payload counted 17,382 tokens on both `claude-fable-5` and `claude-opus-4-8`; `claude-opus-5` differed by only 4 once-per-tool-block overhead tokens and had the same 16,116-token system count. Contextimate therefore applies the Claude 4.7+ text profile to Fable 5 and Opus 5, including explicit Radius and OpenRouter relays whose model ids identify that downstream tokenizer. Bedrock Claude uses the same model-family text ratio while retaining its own provider payload shape and unmeasured tool divisor.

Divisors depend on content shape: repetitive prose tokenizes around chars ÷ 7, JSON-ish text heavier, markdown heavier still. The shipped values are calibrated to Pi-shaped material (system prompts, AGENTS.md, skill index), not universal constants.

The session divisors were validated by replaying 194 local session transcripts (16,479 assistant turns) against recorded provider usage: chars ÷ 2.6 beat a blanket chars ÷ 4 on 20 of 24 Anthropic transcripts, with median error 0.6 to 2.1% against 2.8 to 4.7%. OpenAI-Codex session material sits at chars ÷ 4, so the blanket value is already right there. `pi-contextimate-evaluate-transcripts` replays those original baselines, not the current estimator.

A second study on 5 August 2026 covered Gemini, Kimi, GLM, Cohere, Grok, DeepSeek and Qwen. It counted 54,719 characters of public instructions and 33,590 characters of TypeScript and tests. Gemini used the official `countTokens` endpoint. Local checks used pinned official tokenizer artifacts. xAI checks used exact token IDs and bytes from `TokenizeText`.

| Visible-text profile | Text divisor | Session divisor |
|---|---:|---:|
| OpenAI (Codex, Responses and Azure) | 4.4 | 4.0 |
| Kimi K2 through K3 | 4.1 | 3.8 |
| GLM 4.5 variants, 4.6 variants and standard 4.7 | 4.0 | 3.9 |
| GLM 4.7-Flash, 5, 5.1 and 5.2 | 4.0 | 3.9 |
| Command R/R+ 08-2024 | 4.0 | 3.4 |
| North Mini Code | 4.2 | 3.9 |
| Grok 4.20 variants, 4.3 and Build 0.1 | 4.2 | 3.9 |
| Grok 4.5 | 4.1 | 3.6 |
| Gemini 2.x and 3.x exact counted models | 3.9 | 3.4 |
| DeepSeek V3, R1 and V4 | 4.0 | 3.6 |
| Qwen 2.5 and 3 | 4.0 | 3.8 |
| Qwen 3.5 | 3.9 | 3.5 |

A third study on 28 September 2026 measured OpenAI directly. It sent the same payloads to GPT-5.5, GPT-5.6 Sol and Luna, and GPT-6 Sol and Luna through Codex, adding one piece of content at a time to a fixed baseline. Every model gave identical counts, and system text counted exactly as `o200k_base` plus a fixed 14-token wrapper, so GPT-6 did not change the tokenizer. Across 96 local AGENTS.md and CLAUDE.md files, `o200k_base` gives a median of 4.4 characters per token (pooled 4.3), so OpenAI text uses ÷ 4.4 instead of ÷ 4. The session divisor stays ÷ 4 because tool output is denser than instructions.

These profiles cover visible text only. Dynamic aliases and unverified variants keep the generic estimate or fallback. The [tokenizer coverage audit](./contextimate-tokenizer-coverage-audit-2026-08-05.md) records the evidence and family boundaries.

## Tool schemas

OpenAI does not send tool JSON to the model as-is. It renders each function as a TypeScript-style declaration, which keeps names, descriptions and types but drops most of the JSON syntax. Its [token-counting docs](https://developers.openai.com/api/docs/guides/token-counting) recommend the count endpoint for tools, but that needs an API key and a network call at startup, and Codex OAuth has no count endpoint.

Contextimate therefore estimates each OpenAI tool locally in two steps (`openai-cookbook`, a name kept for config compatibility):

1. **Render.** It writes the tool as OpenAI does: descriptions become `//` comments, properties become `name?: type,` lines, `enum`, `const`, `anyOf` and `oneOf` become unions, local `$ref`s are inlined, and defaults, titles and examples become comments. The provider also keeps keywords that have no TypeScript form, such as `format`, `pattern` or `minimum`, so the render appends them as a JSON comment.
2. **Count.** It splits the render with the `o200k_base` pre-tokenizer pattern, counting each piece as one token plus one per 9 characters. On the rendered text this is within about 3% of the real tokenizer, with no vocabulary to ship.

The tools total adds a fixed 16 tokens for the tool block.

The render rules come from OpenAI's open-source [Harmony renderer](https://github.com/openai/harmony/blob/main/src/encoding.rs) and 41 single-feature live probes. The estimator was checked on 28 September 2026 against 424 tools, each sent alone through Codex, where the prompt minus a no-tool baseline gives its exact cost. The set covered 21 Pi and extension tools, all 368 MCP tools in the local cache (22 servers), and 35 synthetic schemas that are mostly structure: long option lists, nullable fields, `$ref`, nested arrays and constraints. Counts were identical on GPT-5.5, GPT-5.6 and GPT-6, and tool costs add exactly.

```text
method                                 realistic tool sets     single tools     structure-heavy
                                       median (p90) error      median error     single, median
cookbook-style formula (before #132)   34.6% (49.9%)
max(chars ÷ 8, (chars − 190) ÷ 4.5)     4.5% (15.1%)            9%               19%
render + o200k piece count              2.3% (7.7%)             3%                7%
render + exact o200k_base (ceiling)     1.5% (6.4%)             1%                2%
```

Realistic tool sets are random draws of 10 to 40 real tools. The piece-count constant (9) was chosen on the MCP tools alone. The largest remaining misses are a few very large MCP schemas, schema-valued `additionalProperties` and `allOf`; these appear only 9 times across the 389 real tools.

Claude tool payloads measured near their text divisors (÷ 3.36 on Claude 4.5/4.6, ÷ 2.5 on the Claude 4.7+ family), so they use divisors of 3.3 and 2.6. Direct OpenAI Responses and Azure routes use the same OpenAI render as Codex; they were not probed separately. Models that merely share Anthropic, OpenAI Chat or Responses wire formats use the matching payload shape with the fallback ÷ 4, not the upstream tokenizer. Unmeasured Gemini and Bedrock tool payloads also use ÷ 4.

In the UI, a render-counted tools row says `· OpenAI tool render`, and its character count is the rendered text. Divisor-counted rows say things like `÷ 2.6 · Anthropic tool payload`. Each tool's own row is counted on that tool's own shaped payload or render, and the schema tree is just the readable rendering of it.

## Session rows and the total

`Total request` uses Pi's own `ctx.getContextUsage()`: the latest trusted provider-reported total plus a small local estimate for anything after it. It needs no network call and matches Pi's footer number. Contextimate scans the same active message path: the total has no `~` when the latest trusted assistant usage is last, and keeps `~` when one or more trailing messages make Pi add a local estimate.

The session split anchors on that total and claims only what it can count:

```text
Tool outputs:        y         measured from prompt growth where proven, otherwise estimated from chars
Messages:            z         estimated from visible message text and tool-call structure
Thinking summaries:  s         estimated from summaries not covered by exact retained reasoning
Reasoning context:   r         exact reported reasoning retained in the anchored request
Unattributed:        x-y-z-s-r remaining accounting gap
Total session:       x         Pi's total minus the harness (measured where proven, otherwise estimated)
```

### Measured tool outputs

Every trusted response records its exact prompt size: uncached input plus cache reads and writes. Between two consecutive responses, the prompt grows by exactly what was appended: the earlier response as replayed, plus the tool results that followed it. Contextimate subtracts the earlier response's exact output tokens and attributes the rest to those tool results. It excludes reasoning from that subtraction when the response has no replay carrier, because the provider did not send it back.

A step is measured only when all of these hold:

- both responses come from the anchor model, so the count is in the anchor model's tokens
- only tool results sit between them; a user or custom message makes the step unmeasured
- the later request's cache read reaches within 2,048 tokens of the earlier prompt, which proves the earlier prompt was reused unchanged; Codex caches in blocks and often stops a few hundred tokens short, while a harness change breaks the cache far earlier
- the growth is at least the replayed response

Unmeasured tool results keep the chars ÷ session divisor estimate. The row detail says `measured` when every tool result is measured and names the measured share of characters when only some are. The measured figure includes the provider's per-item framing, about 11 tokens per tool result on Codex.

The first real case was a binary file dumped by `head`: 28.1k characters that cost 22.8k tokens, not the 7.0k that chars ÷ 4 claimed. Replaying the last 400 local sessions on 28 September 2026, the Unattributed share of the session fell from a median of 8.3% (90th percentile 20.8%) to 0.0% (1.1%) on 116 Codex sessions, and from 9.9% (29.8%) to 2.4% (4.7%) on 19 Claude sessions. Of within-turn tool steps, 98.9% on Codex and 99.2% on Claude passed the cache check.

### Measured harness

The first request's prompt is the harness plus whatever preceded the first response, usually one user message. Contextimate uses it as `Total harness` when both of these hold:

- every later trusted response up to the anchor comes from the anchor model and passes the same cache check against the one before it, and no compaction summary sits on the active path
- the preceding messages estimate at 4,096 tokens or fewer, so subtracting them as an estimate cannot swamp the measurement

The section rows stay estimates. The total's detail reads `(measured · rows ~17.2k · ~7% ctx)`, so the gap between the measured total and the sum of the rows stays visible. A cache miss anywhere in the chain, typically after an idle pause, returns the harness to its estimate: the miss is also what a resumed session with a rebuilt system prompt looks like, and the two cannot be told apart. In the replay above, about a third of Codex sessions had such a miss. A harness change made after the anchor, such as a reload or a tool toggle, shows in the rows at once and in the measured total after the next response.

The `thinking` text saved by Pi can be a provider-generated summary, not the model's full internal reasoning. Contextimate never estimates reasoning from that text or from an opaque signature. `Reasoning context` sums exact `usage.reasoning` values retained by the request anchoring Pi's total. The current response's reasoning appears as output. Earlier responses appear as input only when Pi replays their signed carrier under the provider's retention policy.

Pi reports the next prompt as one total split across uncached input, cache reads and cache writes. It does not identify historical reasoning within those buckets. Contextimate therefore checks that historical reasoning fits inside their exact sum. If it does not fit, the history stays `Unattributed`. A reported zero remains exact.

Retention depends on the model and serving route. Contextimate attributes history only where it can identify the effective policy. Anthropic's [thinking block preservation policy](https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-block-preservation-by-model) keeps all prior thinking turns for Claude Opus 4.5 and later Opus models, Sonnet 4.6 and later Sonnet models, Fable 5, Mythos 5 and Mythos Preview. Contextimate sums every reported same-model reasoning count on the active path for those models, including supported relays that preserve Anthropic usage. Pi's current Bedrock adapter does not report `usage.reasoning`, so Bedrock reasoning remains unattributed. Earlier Claude families keep only reasoning from the current assistant turn because the API strips older blocks. Compaction naturally removes reasoning that is no longer on Pi's active message path.

OpenAI's [reasoning context policy](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls) defaults GPT-5.6 models to `all_turns` and earlier models to `current_turn`. Contextimate's version rule also applies `all_turns` to Astra, although Astra's effective default remains unverified. Codex tests confirmed `current_turn` for GPT-5.5. An Astra probe preserved encrypted reasoning but did not expose the effective `reasoning.context` value, so it did not confirm `all_turns`. Contextimate bounds historical attribution by the exact prompt total. Direct OpenAI and Azure Responses tests remain pending.

Other providers' historical reasoning stays unattributed until their retention is measured. The current response's exact reported reasoning still appears.

Summaries not covered by exact retained reasoning are estimated separately as `Thinking summaries`. This includes Claude thinking that Pi converts to ordinary text after a model change, and a current block whose session usage has no reasoning breakdown. Opaque carriers and redacted signatures are never converted from bytes or characters into supposed token counts. Missing provider breakdowns remain part of `Unattributed` rather than becoming estimated reasoning.

`Unattributed` is the remaining accounting gap, not a diagnosis. It can absorb static-prefix estimation error when the harness is not measured, estimation error in messages and unmeasured tool outputs, provider overhead, images, opaque replay carriers and reasoning when the provider supplies no breakdown. In particular, a large gap does not claim that the model used that many reasoning tokens.

After compaction, Pi deliberately reports usage as unknown until the next assistant response arrives. The panel then falls back to its heuristic estimate and labels the whole total as heuristic.

After a model switch, Pi's exact count is still in the *previous* model's tokenizer while the window belongs to the new one. Mixing the two would produce a made-up percentage. The panel names the currency instead: `Total request` keeps the exact count but its detail becomes `(pre-switch usage · gpt-5.6-sol tokens)`, that total's window share and context bar are withheld, and the session split falls back to the heuristic. The first post-switch response re-baselines everything.

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

`toolNumerator` picks the payload format to count:

- `openai-cookbook`: the OpenAI render above, which ignores `toolDenominator` (the OpenAI default; the name is kept for config compatibility)
- `openai-responses` / `openai-codex-responses`: Responses-style function objects
- `openai-chat` / `openai-completions` / `mistral`: Chat Completions-style `{ type, function }` objects
- `anthropic`: `{ name, description, input_schema }`
- `gemini` / `google` / `vertex`: `{ functionDeclarations: [...] }`
- `bedrock`: `{ toolSpec: ... }`
- `raw-schema`: the unshaped schema, as a fallback

Unknown names fall back to the Responses format. Custom `toolShapes` templates and the legacy `prefix-inspector.json` config paths were removed in 0.4.0: a configurable approximation cannot beat measuring the real payload.

## Recalibrating for a new provider or model

1. Capture what Pi actually sends: `pi-contextimate-probe-prefix`.
2. Get provider counts and suggested divisors from the captured payload: `pi-contextimate-check-provider-tokens`.
3. Paste the suggested values into a `rules` entry, with the closest built-in `toolNumerator` format.

If the provider has no count endpoint, run controlled live probes instead: hold everything else constant, vary one section, and subtract a minimal baseline from the recorded usage. Record chars per token separately for prose and for tool schemas; they usually differ. [`scripts/contextimate/README.md`](../scripts/contextimate/README.md) documents the scripts, credentials and safety notes (captured payloads can contain sensitive prompt data; keep them local).
