# pi-contextimate context accounting

## User-facing goal

`pi-contextimate` should explain what is filling the model context window, broken down into the pieces a human can act on:

- system prompt / harness instructions
- AGENTS.md context files
- skills block
- active tool definitions
- active-branch session material: tool outputs, visible messages/tool calls, and residual other/reasoning

The output is an inspector, not a billing ledger. The section rows should be close enough to explain why a session is large and which component is responsible.

Related note: [`pi-contextimate-codex-context-accounting.md`](./pi-contextimate-codex-context-accounting.md) compares this policy with upstream OpenAI Codex active-context accounting, especially after interruption and compaction.

## Key distinction

Do **not** treat local object size as context size.

For normal text sections, the denominator should be provider/model-aware. `chars / 4` is still the fallback for unknown providers, but Claude 4.7+ Pi-shaped context is closer to `chars / 2.6–2.75`. For tool schemas, raw text size is not enough: count a provider-shaped numerator, not the literal pretty-printed JSON schema shown in expanded mode.

## What Pi sends

For OpenAI Codex / Responses, Pi's path is:

1. `agent-loop` builds the LLM context with:
   - `systemPrompt`
   - converted `messages`
   - active `tools`
2. `openai-codex-responses` sends:
   - `instructions: context.systemPrompt`
   - `input: convertResponsesMessages(...)`
   - `tools: convertResponsesTools(...)`
3. `convertResponsesTools` sends each tool as:

```json
{
  "type": "function",
  "name": "tool_name",
  "description": "...",
  "parameters": { "type": "object", "properties": { "...": "..." } },
  "strict": null
}
```

Expanded inspector JSON is for readability only and should not be counted as if it were the provider payload.

## Provider facts

### OpenAI

OpenAI's token-counting docs say the Responses input-token endpoint accepts the same payload as `responses.create`, including tools, and returns the exact count. They also say:

- local tokenizers work for plain text
- images/files are not supported locally
- **tools and schemas add tokens that are hard to count locally**
- use the token-count endpoint for exact counts

OpenAI Cookbook/tiktoken examples for function/tool token counting do not count raw JSON. They use a model-specific internal-ish formula over function name/description, property names/types/descriptions, enum values, and fixed constants. That formula lineage is older than the current Responses token-count endpoint, but it is the public explanation for the kind of local, no-network approximation pi-contextimate uses.

### Anthropic

Anthropic's token counting endpoint similarly accepts system prompts, messages, tools, images, and PDFs. Their docs also note special handling for thinking: previous assistant thinking blocks do not count as input tokens, while current assistant thinking does.

## Empirical RCA from 2026-06-02

Fresh `gpt-5.5`, thinking off, prompt `hi`:

```text
Inspector before fix: Total harness ~37.2k tokens
Provider/lab usage:   ~19.0k input tokens
```

Captured Codex request payload:

```text
instructions: 57.7k chars
input:        one tiny user message
full tools:   23 tools, 48.1k minified JSON chars
```

Controlled probes:

```text
no tools:             provider input  7,627
builtin tools:        provider input 11,939
builtin + subagent:   provider input 14,170
full minus subagent:  provider input 16,747
full default tools:   provider input 18,978
```

Using `o200k_base` on raw minified tool JSON overestimates the full tool set:

```text
full tools raw JSON: ~10.8k tokenizer tokens
provider tool delta: ~5.9k tokens
```

The old inspector was worse because it counted pretty-printed JSON:

```text
full tools pretty JSON: 91.5k chars -> ~22.9k chars/4 tokens
actual provider delta:  ~5.9k tokens
```

Root cause: tool schemas are converted into a provider-specific internal function representation, not charged against context as raw pretty JSON.

## Extension policy

- Pick denominators from the active model/provider, so `/model` or Ctrl+P changes estimates immediately.
- Keep built-in provider defaults in one auditable table in `extensions/pi-contextimate/index.ts` (`BUILT_IN_HEURISTIC_RULES`).
- Keep the header lightweight; show accounting provenance on each row instead of a global accounting line.
- Unknown providers fall back to `chars / 4`.
- Text rows show their denominator inline, e.g. `~3k tokens (10.0k chars/4)`.
- Tool rows show the provider-shaped numerator and estimator inline, e.g. `~6k tokens (47.9k chars · OpenAI-style local formula)` or `~14k tokens (48.2k chars/2.6 · Anthropic tool payload)`.
- Compact/expanded modes add method lines under `Tools`, including the formula/provenance for OpenAI-style local estimates, so the UI does not depend on clickable terminal links for calculation backup.
- Text sections use text denominators; session visible buckets use session denominators; tool schemas use a provider-shaped tool numerator plus either a denominator or a special estimator.
- Tool numerator character counts must use minified provider-shaped JSON, not pretty JSON.
- Tool sections must never use pretty-printed expanded JSON length as the count source.
- Keep expanded mode readable with pretty JSON, but make clear counts use provider/model-aware estimates.
- Show Pi's current context usage separately as `Total request` after a response exists.
- Render token counts as whole-token or whole-`k` values (`~600 tokens`, `~6k tokens`), not `x.xk tokens`; decimal-place token counts imply false precision. Character counts may remain compact (`1.6k chars`) because they are just a size cue.
- Future exact mode: optionally call provider token-count endpoints using the actual outgoing payload, then subtract baselines to isolate sections. This should be opt-in or cached because it adds network/API work to startup.

## Practical OpenAI-style tool heuristic

Use the OpenAI Cookbook/tiktoken-style approach for function tools. This is the calculation backing the OpenAI-Codex tools row in summary mode. The row's character count is the size of the minified provider-shaped `tools` payload; the token count is produced by the formula below, not by dividing that JSON string by a denominator.

Provenance and limits:

- OpenAI's current [function-calling docs](https://developers.openai.com/api/docs/guides/function-calling#token-usage) say callable function definitions count against context and are billed as input tokens.
- OpenAI's current [token-counting docs](https://developers.openai.com/api/docs/guides/token-counting) say tools/schemas are hard to count locally and recommend `responses.input_tokens.count` for exact counts.
- The older [Cookbook/tiktoken token-counting example](https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken) is still the public source for a local function/tool schema-summary formula.
- pi-contextimate uses the local formula at startup because exact endpoints add API calls, may not be available for Codex/OAuth-backed providers, and do not help Anthropic/Gemini/etc. without separate provider-specific count calls.

Formula:

- per function constant
- `name:description`
- per top-level property constant
- `propertyName:type:description`
- enum constants and values
- final tools constant

Because the extension does not load a tokenizer, approximate tokenization for these text fragments with `chars / 4`. In the 2026-06-02 probe, this put the full default tool set within a few percent of the provider-reported tool contribution.

Current constants in `estimateOpenAIFunctionToolTokens`:

```text
function init:       +7 per function
property section:   +3 if properties exist
property key:       +3 per top-level property
enum init:          -3 when enum values exist
enum item:          +3 per enum value
function end:       +12 once when any tools exist
text fragments:     chars / 4 for name:description, propertyName:type:description, enum values
```

This is a schema-summary formula, not a raw JSON denominator. Therefore the tool row says `OpenAI-style local formula` instead of `openai-cookbook ÷5.5`. Compact/expanded modes print the formula and point to this section (`docs/pi-contextimate.md#practical-openai-style-tool-heuristic`) so the calculation backup is visible even when a terminal strips hyperlink escape sequences.

## Follow-up tokenizer/provider experiment from 2026-06-02

A second experiment checked whether the `opus-4-8` vs `opus-4-5` startup gap was caused by Anthropic's tokenizer/accounting, and whether simple `chars / n` fallbacks are acceptable by provider.

### Questions tested

1. Do we know which payload text/schema chars are being counted?
2. Is `chars / 4` a reasonable fallback for OpenAI / OpenAI-Codex?
3. For Anthropic Claude, is the rough split `chars / 3` for Claude 4.6 and older, and `chars / 2` for Claude 4.7 and newer?

### Payload format certainty

Pi's provider adapters give high confidence about the request-shaped numerator:

- OpenAI / OpenAI-Codex Responses tools are sent as compact function definitions with `type`, `name`, `description`, `parameters`, and `strict`.
- Anthropic tools are sent as `name`, `description`, `eager_input_streaming`, and `input_schema` containing only `{ type, properties, required }`; Anthropic OAuth also canonicalizes built-in tool names to Claude Code casing and adds a small Claude Code identity system block.

The remaining uncertainty is not “which local object should be counted”; it is how each provider's internal tokenizer/accounting treats that request-shaped text/schema payload.

### Anthropic exact-count results

Using Anthropic's official `messages/count_tokens` endpoint against the same captured Pi payload:

```text
model                full request input_tokens
claude-opus-4-5      29,258
claude-opus-4-6      29,259
claude-opus-4-7      40,758
claude-opus-4-8      40,368
```

This reproduced the observed `~29k` vs `~40k` gap without a live generation. A live `claude-opus-4-8`, thinking-off, `hi` run reported:

```text
input=2, cacheWrite=40,383, output=69, total=40,454
```

So almost all of the startup number was Anthropic prompt-cache creation for the static prefix/tools. The count endpoint returned `40,368`, matching live accounting within 15 input tokens.

Section counts were measured by subtracting a minimal `messages=[hi]` baseline from separate count calls for each section.

```text
Claude 4.5 / 4.6 real Pi sections
section                         chars     tokens   chars/token
System prompt                   11,182    ~2,735   ~4.09
Global AGENTS.md                17,782    ~4,613   ~3.86
Repo AGENTS.md                  12,811    ~3,172   ~4.04
Skills block                    15,652    ~4,266   ~3.67
Anthropic tool payload          48,237    ~14,371  ~3.36
```

```text
Claude 4.7 / 4.8 real Pi sections
section                         chars     tokens   chars/token
System prompt                   11,182    3,873    2.89
Global AGENTS.md                17,782    6,640    2.68
Repo AGENTS.md                  12,811    4,673    2.74
Skills block                    15,652    5,909    2.65
Anthropic tool payload          48,237    19.1k-19.5k  ~2.47-2.52
```

Synthetic section probes at 512 / 2,048 / 8,192 chars showed strong content-shape dependence:

```text
Claude 4.5 / 4.6 chars/token
plain repetitive prose  ~7.0
markdown-ish prompt     ~3.36
json-ish schema text    ~4.63

Claude 4.7 / 4.8 chars/token
plain repetitive prose  ~4.0
markdown-ish prompt     ~2.42
json-ish schema text    ~3.05
```

Findings:

- The Claude 4.7+ tokenizer/accounting change explains the full observed `opus-4-8` vs `opus-4-5` gap.
- For real Pi startup material, Claude 4.5/4.6 are closer to `chars / 3.5` overall, not `chars / 3`.
- For real Pi startup material, Claude 4.7/4.8 are closer to `chars / 2.6` overall, not `chars / 2`.
- `chars / 2` is a deliberately conservative high estimate for Claude 4.7+, but it will overstate normal Pi prefix size.

### OpenAI-Codex live-usage results

The public OpenAI `responses/input_tokens` endpoint was tried with the active `openai-codex` auth path and returned `401` with missing API scopes. Guessed ChatGPT backend count URLs returned `403`. Therefore OpenAI-Codex exact counting was not available during this experiment.

Instead, live `gpt-5.5` runs were used with synthetic system prompts, no tools, no context files, no skills, no prompt templates, no themes, and thinking off. After subtracting a tiny baseline, text-section results were:

```text
OpenAI-Codex gpt-5.5 text sections
shape                  chars/token
plain repetitive prose ~7.2
markdown-ish prompt    ~4.0
json-ish schema text   ~4.8
```

For Pi-like markdown/system text, `chars / 4` is a good conservative fallback.

Tool-schema probes used the same environment and subtracted a no-tools baseline. The numerator was the minified OpenAI/Codex provider-shaped `tools` JSON payload.

```text
OpenAI-Codex gpt-5.5 tool deltas
case              tool chars   token delta   chars/token
read only             682          147       4.6
4 builtins          2,897          476       6.1
default 23 tools   48,126        8,792       5.5
```

For OpenAI-Codex tools, raw `chars / 4` is too high. A better fallback is minified provider-shaped tool payload `chars / 5.5`, or the OpenAI-style local formula currently used by the extension.

### Heuristic policy after this experiment

Prefer exact count endpoints when available and cheap enough to cache. Fallbacks should be provider- and payload-shape-aware:

```text
Provider / model family             text fallback       session fallback     tool fallback
Anthropic Claude <= 4.6             chars / 3.8         chars / 3.5          Anthropic tool payload chars / 3.3
Anthropic Claude >= 4.7             chars / 2.6         chars / 2.6          Anthropic tool payload chars / 2.6
OpenAI API Responses                chars / 4           chars / 4            OpenAI tool payload chars / 5.5
OpenAI-Codex gpt-5.5                chars / 4           chars / 4            OpenAI-style local formula
OpenAI-chat-style / Mistral         chars / 4           chars / 4            Chat tool payload chars / 5.5
Gemini / Vertex / Bedrock           chars / 4           chars / 4            provider-shaped tool payload chars / 4
Other providers                     chars / 4           chars / 4            OpenAI Responses-shaped fallback chars / 4
```

These are approximate section-inspector estimates, not billing guarantees.

## Transcript/session heuristic evaluation from 2026-06-02

A local transcript evaluation compared the current session heuristic against a single blanket denominator (`chars / 4`) on available JSONL sessions.

Scope:

```text
JSONL files scanned:              285
files with provider usage:        275
single-model files:               219
unique/evaluable transcripts:     194
assistant turns evaluated:     16,479
```

Method:

- Include only transcripts where all recorded `model_change` entries resolve to one provider/model.
- For each assistant turn, reconstruct the replayed branch before that turn with `buildSessionContext(...)` and `convertToLlm(...)`.
- Compare recorded provider input (`usage.input + usage.cacheRead + usage.cacheWrite`) with:
  - current provider-aware session heuristic
  - blanket `chars / 4`
- Fit one static intercept per transcript. This is necessary because historical JSONLs do not store the exact startup system prompt/tool payload for that run. Therefore this evaluates session replay growth, not static prefix/tool-schema accuracy.
- De-duplicate exact duplicate JSONL files by hash before reporting aggregate numbers.

Results:

```text
Model                       transcripts / turns   current heuristic           blanket chars/4
openai-codex/gpt-5.5        170 / 15,910          same as chars/4             same
claude-opus-4-7               7 /    328          median MAE ~1.1k, MAPE 2.1% median MAE ~1.3k, MAPE 4.7%
claude-opus-4-8              16 /    238          median MAE ~243, MAPE 0.6% median MAE ~1.0k, MAPE 2.8%
Anthropic overall            24 /    569          median MAE ~415, MAPE 1.4% median MAE ~1.2k, MAPE 4.1%
```

Wins/losses by transcript:

```text
openai-codex/gpt-5.5        current 0  / chars4 0 / equal 170
claude-opus-4-7             current 7  / chars4 0
claude-opus-4-8             current 13 / chars4 3
anthropic overall           current 20 / chars4 4
all evaluated transcripts   current 20 / chars4 4 / equal 170
```

Interpretation:

- OpenAI-Codex session replay currently uses `chars / 4`, so there is no difference from the blanket denominator for session rows.
- Claude 4.7+/4.8 session replay is materially better with `chars / 2.6` than with `chars / 4`.
- The few Claude 4.8 cases where `chars / 4` wins are tiny 2–4 turn sessions where the difference is only tens of tokens; they are not strong evidence against the `2.6` default.
- A single denominator would regress Anthropic session estimates.

Static-prefix sanity checks from the same pass:

```text
Claude 4.8 live startup
actual provider input: ~40.4k tokens
current inspector:     ~40k tokens
blanket chars/4:       ~26k tokens  (bad undercount)

OpenAI-Codex live startup
actual provider input: ~19.0k tokens
current inspector:     ~20k tokens
blanket chars/4:       ~26k tokens  (bad overcount, mostly tool schemas)
```

Artifacts from this run were written to `/tmp/pi_context_heuristic_eval.js`, `/tmp/pi_context_heuristic_eval_results.json`, and `/tmp/pi_context_heuristic_eval_results_dedup.json`. They are temporary local artifacts; rerun the experiment from the documented method rather than treating `/tmp` as durable storage.

## OpenAI-style local formula evaluation from 2026-06-02

The transcript evaluation above does not test the OpenAI-style local formula because JSONL transcripts do not contain the active tool schema payload. The local formula must be checked with live/captured startup payloads.

Current controlled OpenAI-Codex probe, with context files, skills, prompt templates, and themes disabled:

```text
active tools:                 23
minified tool JSON chars: 47,916
local heuristic estimate: 5,950 tokens
raw chars/4 estimate:     11,979 tokens
chars/5.5 estimate:        8,712 tokens

with-tools provider input: 8,327 tokens
no-tools provider input:     641 tokens
observed input delta:     7,686 tokens
```

The observed with-tools/no-tools delta includes both provider tool schemas and extra tool snippets/guidelines in the system prompt. In this probe the system instructions grew by `8,356 chars`, or about `~2,089 tokens` at `chars / 4`. Combining that text estimate with the local schema estimate gives:

```text
5,950 heuristic tool-schema tokens + ~2,089 tool-snippet text tokens = ~8,039 tokens
```

That is close to the observed `7,686` token delta and much better than counting the minified tool JSON as raw `chars / 4` (`~11,979` tokens). This is why the tool row reports an OpenAI-style local formula rather than a simple denominator.

Artifact from this probe: `/tmp/pi_cookbook_eval_result.json`.

## User configuration

The extension reads optional JSON config from these paths, in order:

1. `~/.pi/agent/pi-contextimate.json`
2. `<cwd>/.pi/pi-contextimate.json`
3. legacy fallback: `~/.pi/agent/prefix-inspector.json`
4. legacy fallback: `<cwd>/.pi/prefix-inspector.json`
5. any colon-separated paths in `PI_CONTEXTIMATE_CONFIG`
6. legacy fallback: any colon-separated paths in `PI_PREFIX_INSPECTOR_CONFIG`

Later files override scalar/default fields; `rules` are appended and later matching rules win because they are applied last. This keeps the built-in provider-aware defaults as the base while allowing project or user overrides.

Example:

```json
{
  "defaults": {
    "textDenominator": 4,
    "sessionDenominator": 4,
    "toolDenominator": 4,
    "toolNumerator": "openai-responses"
  },
  "rules": [
    {
      "label": "Custom Claude 4.8 calibration",
      "match": { "provider": "anthropic", "model": "*4-8*" },
      "textDenominator": 2.6,
      "sessionDenominator": 2.6,
      "toolDenominator": 2.6,
      "toolNumerator": "anthropic"
    },
    {
      "label": "My proxy uses chat function tools",
      "match": { "provider": "my-proxy", "api": "openai-completions" },
      "textDenominator": 4,
      "sessionDenominator": 4,
      "toolDenominator": 5.5,
      "toolNumerator": "openai-chat"
    }
  ]
}
```

Rule `match` values support exact strings, `*`/`?` globs, or JavaScript regex strings such as `"/claude.*4-8/i"`.

Built-in tool numerator shapes:

- `openai-cookbook` — OpenAI-style local function-token formula, currently the OpenAI-Codex default. The key name is retained for compatibility with existing configs.
- `openai-responses` / `openai-codex-responses` — `{ type, name, description, parameters, strict }` per tool.
- `openai-chat` / `openai-completions` / `mistral` — Chat Completions-style `{ type, function: { ... } }` per tool.
- `anthropic` — `{ name, description, input_schema }` per tool.
- `gemini` / `google` / `vertex` — `{ functionDeclarations: [...] }`.
- `bedrock` — `{ toolSpec: { name, description, inputSchema: { json } } }` per tool.
- `raw-schema` — direct readable schema fallback.

Users can define custom numerator shapes under `toolShapes`. A custom `template` is applied once per active tool and the minified JSON array is used as the numerator. Optional `url` or `referenceUrl` fields are retained as best-effort hyperlink metadata for renderers that preserve OSC-8 links, but visible labels/method lines should stand on their own because some Pi terminal render paths strip those escapes. Supported placeholders are `$name`, `$description`, `$schema`/`$parameters`, `$source`, `$parameterKeys`, `$promptGuidelines`, and `$strict`; string interpolation also supports `{{name}}`, `{{description}}`, and `{{source}}`.

```json
{
  "toolShapes": {
    "my-provider-tools": {
      "label": "My provider tool payload",
      "denominator": 4.8,
      "url": "https://example.com/my-provider-token-accounting",
      "template": {
        "kind": "function",
        "fn": {
          "name": "$name",
          "description": "$description",
          "schema": "$schema"
        }
      }
    }
  },
  "rules": [
    {
      "label": "My provider calibration",
      "match": { "provider": "my-provider" },
      "textDenominator": 4,
      "sessionDenominator": 4,
      "toolNumerator": "my-provider-tools"
    }
  ]
}
```

## Current session total policy

For the startup/reload inspector, use Pi's own current-context estimate as the top-line total when it is available. This avoids doing an extra provider token-count API call at startup and aligns the inspector with the footer/context-pressure number Pi already shows.

Pi computes `ctx.getContextUsage()` from the current branch roughly as:

```text
current context tokens = latest trusted assistant usage total
                       + local estimate for messages after that assistant
```

The trusted assistant usage is the latest non-aborted, non-error assistant message with provider usage. Pi converts it with:

```text
usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
```

The trailing local estimate is `chars / 4` over messages after that assistant. In the normal idle-after-response state there are usually no trailing messages, so the value is just the latest provider-reported request+response total. The trailing estimate mainly matters between a new user/tool message and the next assistant response, or after abort/error/partial states.

After compaction, Pi deliberately does not trust pre-compaction assistant usage. If there is no post-compaction assistant response yet, `ctx.getContextUsage()` can return `tokens: null`. In that case pi-contextimate should fall back to its provider/model heuristic rather than showing the session total as unknown.

### Session split policy

Use the Pi/current-context total as the anchor, then split only the locally countable pieces. Do not estimate hidden thinking from encrypted/signature payload character length.

```text
Total session: x tokens
  of which approx. using provider-shaped chars / denominator
  Tool outputs:        y tokens
  Messages:            z tokens
  Other / reasoning:   x - y - z tokens
```

Where:

- `x` is Pi current-context total minus pi-contextimate's harness/static-prefix estimate, when Pi has a current total.
- `y` is estimated from provider-shaped tool output content chars.
- `z` is estimated from visible user/assistant message text and tool-call structure.
- `Other / reasoning` is a residual bucket. It includes opaque reasoning/signature replay, provider overhead, images/weird blocks, and any estimation error. It is not computed from encrypted reasoning chars.

If Pi's current total is unavailable after compaction, use the provider/model fallback estimate for `x` and keep the same split labels. In that fallback state, make clear the whole session total is heuristic.

## Rerunning or adapting the experiment

Use a throwaway session directory and do not print, commit, or publish credential-bearing payloads. The following is enough for a fresh agent to reproduce the experiment or adapt it to another provider.

### 1. Capture the actual provider payload

Create a temporary capture extension:

```ts
// /tmp/pi-payload-capture-env.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function payloadCapture(pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event) => {
    const base = process.env.PI_PAYLOAD_CAPTURE_PATH || "/tmp/pi-payload";
    writeFileSync(`${base}.json`, JSON.stringify(event.payload, null, 2));
    writeFileSync(`${base}.min.json`, JSON.stringify(event.payload));
    return event.payload;
  });
}
```

Capture one minimal run:

```bash
rm -rf /tmp/pi-prefix-probe-sessions
PI_PAYLOAD_CAPTURE_PATH=/tmp/pi-prefix-probe \
  pi -p \
  --model anthropic/claude-opus-4-8 \
  --thinking off \
  --session-dir /tmp/pi-prefix-probe-sessions \
  --extension /tmp/pi-payload-capture-env.ts \
  hi
```

Inspect only sizes/keys; do not print or publish full provider payloads from a real authenticated session:

```bash
python3 - <<'PY'
import json
p=json.load(open('/tmp/pi-prefix-probe.min.json'))
print(p.keys())
print('system chars', len(json.dumps(p.get('system'), separators=(',', ':'))))
print('message chars', len(json.dumps(p.get('messages'), separators=(',', ':'))))
print('tool chars', len(json.dumps(p.get('tools'), separators=(',', ':'))))
PY
```

### 2. Anthropic exact counts

Use `messages/count_tokens` with the same model and request-shaped payload. Section tokens are isolated by subtracting a minimal baseline:

```text
baseline = count({ model, messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } })
section  = count({ model, messages: [hi], system: [section], thinking: disabled }) - baseline
tools    = count({ model, messages: [hi], tools, thinking: disabled }) - baseline
full     = count({ model, messages, system, tools, thinking })
```

Use whichever Anthropic authentication path is appropriate for your environment and keep it out of logs. For OAuth-style Claude Code requests, the request may also need the provider-specific beta/app headers used by that client. Do not print tokens or publish authenticated payloads.

### 3. OpenAI / OpenAI-Codex counts

For OpenAI API-key-backed Responses models, try the official endpoint with the exact Responses payload:

```text
POST /v1/responses/input_tokens
body: { model, instructions, input, tools, ... }
```

For OpenAI-Codex OAuth, the public endpoint may fail with insufficient scopes. If no exact count endpoint is available, run controlled live probes instead:

````bash
python3 - <<'PY' >/tmp/pi-prefix-sample.txt
block = """# Context section

- Source: AGENTS.md
- Rule: keep edits precise and quote paths clearly.

```ts
export function estimateTokens(chars: number) { return Math.ceil(chars / 4); }
```

"""
print((block * 80)[:8192], end="")
PY

pi -p \
  --model openai-codex/gpt-5.5 \
  --thinking off \
  --session-dir /tmp/pi-codex-probe-sessions \
  --no-tools \
  --no-context-files \
  --no-skills \
  --no-extensions \
  --extension /tmp/pi-payload-capture-env.ts \
  --no-prompt-templates \
  --no-themes \
  --system-prompt "$(cat /tmp/pi-prefix-sample.txt)" \
  'Reply exactly OK.'
````

Read the saved session JSONL and subtract a tiny baseline run with the same flags and a one-character system prompt. For tool probes, hold the system prompt constant and vary `--tools` / `--no-tools`; subtract the no-tools baseline.

### 4. Adapting to another provider

1. Capture the provider payload with `before_provider_request`.
2. Identify the provider-shaped numerator for each section: system/instructions, messages, and tools.
3. If the provider has a count endpoint, use it and subtract a baseline.
4. If not, run live no-op generations with varied synthetic sizes and subtract baselines.
5. Record chars/token separately for normal text and tool schemas; tool schemas often need a different denominator.
