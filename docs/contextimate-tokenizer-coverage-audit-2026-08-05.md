# Contextimate tokenizer coverage audit

Date: 5 August 2026

## Decision

Contextimate can cover far more than OpenAI and Anthropic without adding runtime dependencies.

The practical route is a layered evidence model:

1. use billed provider usage after a request
2. use a full-request provider count endpoint for calibration where one exists
3. use a message-only or text-only endpoint for the sections it covers
4. use a public local tokenizer to measure raw text and open-model chat templates
5. use controlled live probes to measure provider-added tool and message overhead
6. ship a model-family estimate only after recording that evidence
7. show unknown for routes that do not identify a model before inference

Do not bundle dozens of tokenizers into the extension. Current tokenizer artifacts range from about 3 MB to more than 30 MB. Many also need native, WebAssembly or Python libraries. A tokenizer alone still misses provider chat templates, tool-schema conversion, hidden instructions and multimodal accounting.

The highest-value next step is to extend the existing manual provider checker. It can calibrate Gemini, Bedrock, Kimi and GLM directly. It can also use OpenAI's new input-token endpoint. DeepSeek, Qwen, MiniMax, Mistral and open model families need local tokenizer runs plus controlled provider probes.

## Scope

This audit covers Pi 0.83.0 and `@earendil-works/pi-ai` 0.83.0.

Pi's generated catalog contains 1,153 entries in 37 static provider catalogs. The catalog was generated on 29 July 2026. Radius is a further built-in provider with a dynamic catalog. The active Radius catalog contained 36 models during this audit.

The inventory also has 3 unbounded surfaces:

- `models.json` can add any model served through a supported API
- provider extensions can add any model and API
- llama.cpp discovers whichever GGUF models the user has loaded

The installed Cursor extension added 210 model entries during this audit. These are not part of Pi's built-in catalog.

A flat list of 1,153 entries would hide the important distinction. Most entries are aliases, regional routes or serving variants. They collapse into about 40 model and tokenizer families, plus several opaque routers.

Primary local sources:

- Pi provider catalog: `node_modules/@earendil-works/pi-ai/dist/providers/data/`
- catalog manifest: `node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json`
- provider registry: `node_modules/@earendil-works/pi-ai/dist/providers/all.js`
- current profiles: `extensions/_lib/heuristics.ts`
- provider payload shapes: `extensions/_lib/tool-payloads.ts`
- manual checker: `scripts/contextimate/check-provider-tokens.mjs`

## Pi model inventory

The model count includes aliases and serving variants. It does not represent unique tokenizers.

| Provider catalog | Models | Pi API shape |
|---|---:|---|
| amazon-bedrock | 114 | Bedrock Converse |
| ant-ling | 3 | OpenAI Chat Completions |
| anthropic | 15 | Anthropic Messages |
| azure-openai-responses | 38 | Azure OpenAI Responses |
| cerebras | 3 | OpenAI Chat Completions |
| cloudflare-ai-gateway | 43 | Anthropic Messages, OpenAI Chat and OpenAI Responses |
| cloudflare-workers-ai | 13 | OpenAI Chat Completions |
| deepseek | 2 | OpenAI Chat Completions |
| fireworks | 16 | Anthropic Messages and OpenAI Chat |
| github-copilot | 29 | Anthropic Messages, OpenAI Chat and OpenAI Responses |
| google | 24 | Google Generative AI |
| google-vertex | 12 | Google Vertex |
| groq | 7 | OpenAI Chat Completions |
| huggingface | 51 | OpenAI Chat Completions |
| kimi-coding | 4 | Anthropic Messages |
| minimax | 3 | Anthropic Messages |
| minimax-cn | 3 | Anthropic Messages |
| mistral | 30 | Mistral Conversations |
| moonshotai | 10 | OpenAI Chat Completions |
| moonshotai-cn | 10 | OpenAI Chat Completions |
| nvidia | 30 | OpenAI Chat Completions |
| openai | 38 | OpenAI Responses |
| openai-codex | 7 | OpenAI Codex Responses |
| opencode | 59 | Anthropic Messages, Google Generative AI, OpenAI Chat and OpenAI Responses |
| opencode-go | 16 | Anthropic Messages, OpenAI Chat and OpenAI Responses |
| openrouter | 303 | OpenAI Chat Completions |
| qwen-token-plan | 15 | OpenAI Chat Completions |
| qwen-token-plan-cn | 15 | OpenAI Chat Completions |
| together | 17 | OpenAI Chat Completions |
| vercel-ai-gateway | 193 | Anthropic Messages |
| xai | 3 | OpenAI Chat and OpenAI Responses |
| xiaomi | 6 | OpenAI Chat Completions |
| xiaomi-token-plan-ams | 3 | OpenAI Chat Completions |
| xiaomi-token-plan-cn | 3 | OpenAI Chat Completions |
| xiaomi-token-plan-sgp | 3 | OpenAI Chat Completions |
| zai | 6 | OpenAI Chat Completions |
| zai-coding-cn | 6 | OpenAI Chat Completions |
| Total | 1,153 | 37 static catalogs |

### Underlying model families

The catalog contains these identifiable families:

- Anthropic Claude
- OpenAI GPT, Codex and o-series
- OpenAI gpt-oss
- Google Gemini and Deep Research
- Google Gemma
- Meta Llama
- DeepSeek
- Alibaba Qwen
- Moonshot Kimi
- MiniMax
- Zhipu GLM
- Mistral, Mixtral, Codestral, Devstral, Magistral, Ministral, Pixtral and Voxtral
- xAI Grok
- Xiaomi MiMo
- NVIDIA Nemotron and Cosmos
- Amazon Nova
- IBM Granite
- InclusionAI Ling and Ring
- StepFun Step
- ByteDance Seed
- Cohere Command and North
- AI21 Jamba
- Poolside Laguna
- Aion
- Arcee Trinity and Virtuoso
- Inception Mercury
- Kwai KAT-Coder
- Meituan LongCat
- Meta Muse
- Nex N2
- Writer Palmyra
- Thinking Machines Inkling
- Upstage Solar
- Reka
- Relace
- Sakana Fugu
- Tencent HY
- Interfaze
- Cursor Composer

The catalog also contains opaque selectors such as `auto`, `free`, `fusion`, `big-pickle`, `mai-code-1-flash-picker` and Cursor `default`. These do not identify one tokenizer.

## Current Contextimate behaviour

Contextimate currently has useful payload-shape support, but limited tokenizer-family support.

It has measured profiles for:

- Claude 4.5 and 4.6
- Claude 4.7 and later
- OpenAI Codex and Responses

It has unmeasured or generic profiles for:

- Gemini and Vertex at characters divided by 4
- Bedrock at characters divided by 4, except Claude text
- Mistral and every OpenAI Chat compatible route at characters divided by 4
- unknown routes at characters divided by 4

The present matcher also shows why provider and tokenizer identity must be separate.

`api: "openai-completions"` selects the OpenAI-chat-style profile. That gives the right outer payload shape for DeepSeek, GLM, Kimi, Qwen and many relays. It does not establish their text tokenizer or hidden tool representation.

`api: "anthropic-messages"` selects the generic Anthropic profile when no more specific rule matches. This affects Kimi Coding, MiniMax, Fireworks and all 193 Vercel catalog entries. Those routes accept Anthropic-shaped input, but the downstream models do not necessarily use Claude's tokenizer. The current `3.5` and `3.3` divisors are therefore unsupported for many of these entries.

The next design should resolve 3 independent facts:

- serving route, for endpoint and credential behaviour
- wire API shape, for the payload Contextimate counts
- downstream tokenizer family and revision, for token density

## Evidence levels

Use these labels in code, tests and documentation.

| Level | Meaning | Suitable claim |
|---|---|---|
| Billed usage | The provider reported usage for the completed request | authoritative for that completed request |
| Full-request provider preflight | The provider counted the same semantic request before inference | strongest startup and calibration source; billed usage remains final |
| Narrow provider count | The endpoint accepts messages or raw text but omits some request fields | exact only for the accepted fields |
| Local rendered request | An official tokenizer and chat renderer processed a pinned open model revision | exact for that local renderer, not automatically for a hosted relay |
| Local raw text | An official tokenizer processed visible text | exact text tokens only |
| Controlled live probe | Usage differences isolate one section against a baseline | measured estimate for that route and model |
| Calibrated heuristic | A ratio or formula fitted to representative Pi payloads | estimate, always marked with `~` |
| Unknown | The route does not reveal the model or tokenizer | no token-density or context-window claim |

## Provider count endpoints

### Full-request provider preflight

| Provider | Endpoint | Request coverage | Important limits |
|---|---|---|---|
| Anthropic | `POST /v1/messages/count_tokens` | messages, system prompt, tools and supported content blocks | provider count can differ slightly from later live usage; existing Contextimate probes were within 15 tokens |
| OpenAI | `POST /v1/responses/input_tokens` | Responses input, instructions, tools, tool choice, reasoning and other request controls | direct OpenAI platform API only; Codex OAuth and OpenAI-compatible relays do not document support |
| Google Gemini Developer API | `POST /v1beta/models/{model}:countTokens` | full `GenerateContentRequest`, including contents, system instruction, tools, cache reference and multimodal parts | use direct REST for parity; the count body needs a transformation from Pi's Google SDK parameters; Google does not promise equality with billing in all cases |
| Google Vertex AI | `POST .../publishers/google/models/{model}:countTokens` | native contents, system instruction, tools, generation config and multimodal parts | the count body needs a transformation from Pi's Google SDK parameters; count against the exact publisher model and location |
| Amazon Bedrock | `CountTokens` | InvokeModel body or Converse messages, system prompt, tool config and additional model request fields | AWS says the result matches the charged count; support is model-specific and some cross-region Claude models need the Bedrock Mantle count endpoint |

Useful sources:

- [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [OpenAI Responses input-token count](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
- [Gemini countTokens reference](https://ai.google.dev/api/tokens)
- [Vertex AI countTokens reference](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/count-tokens)
- [Bedrock CountTokens guide](https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html)
- [Bedrock Converse count request](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseTokensRequest.html)

### Narrow provider count endpoints

| Provider | Endpoint | Covers | Does not prove |
|---|---|---|---|
| Kimi API Platform | `POST /v1/tokenizers/estimate-token-count` | system, user, assistant and tool messages; text, image and video message parts | the published schema has no top-level tool definitions or assistant tool-call field, so it cannot measure Pi's static function schema block or every session turn |
| Z.AI | `POST /api/paas/v4/tokenizer` | system, user and assistant messages, multimodal user content and up to 128 function tools | the schema does not define tool-result messages and omits an assistant tool-call property despite saying assistants can include calls; the model enum lists only GLM 4.5, GLM 4.6 and GLM 4.6V |
| Cohere | `POST /v1/tokenize` | one text string for a named model | chat-template, tools or provider-added prompt overhead; capability-probe the current model ID |
| xAI | `TokenizeText` in the official xAI SDK | one text string for an accepted Grok model | chat-template, tools or modern hosted request overhead; the public example uses Grok 3, so capability-probe current Grok IDs |

Useful sources:

- [Kimi estimate tokens](https://platform.kimi.ai/docs/api/estimate)
- [Z.AI tokenizer reference](https://docs.z.ai/api-reference/tools/tokenizer.md)
- [Cohere tokenize](https://docs.cohere.com/reference/tokenize)
- [xAI Python SDK tokenizer example](https://github.com/xai-org/xai-sdk-python/blob/main/examples/sync/tokenizer.py)

The Kimi endpoint is a real opportunity. It supports current `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6` and `kimi-k2.5` model IDs. It can calibrate system and message text. Tool definitions still need a controlled generation probe or a local template.

## Family coverage matrix

### High-priority families

| Family | Pi examples | Public local tokenizer | Best route for Contextimate |
|---|---|---|---|
| Claude | `claude-opus-5`, `claude-fable-5` | no supported public local tokenizer | keep Anthropic preflight and measured family profiles; use model-ID matching through relays only when the route preserves Claude accounting |
| OpenAI GPT and o-series | `gpt-5.6-sol`, `o3` | `tiktoken` covers published tokenizer mappings, but tools and Responses overhead need the provider endpoint | move the manual checker to `/v1/responses/input_tokens`; keep Codex OAuth on observed usage and controlled live probes |
| Gemini | `gemini-2.5-pro`, `gemini-3.6-flash` | Google now ships an experimental Python local tokenizer for a limited allowlist | add Developer API and Vertex preflight adapters; use a separate model-generation profile for offline estimates |
| Gemma | `gemma-3-27b-it`, `gemma-4-31b-it` | official SentencePiece or tokenizer JSON artifacts | use the hosted Google count endpoint when direct; use the exact Gemma processor and chat template for open deployments |
| DeepSeek | `deepseek-v3.2`, `deepseek-v4-pro` | official Hugging Face tokenizer JSON artifacts | no verified native count endpoint; run the pinned tokenizer for text, then calibrate tools and chat overhead from live usage |
| GLM | `glm-4.7`, `glm-5.2` | official Hugging Face tokenizer JSON artifacts | use Z.AI preflight for the documented GLM 4.x static prefix; split GLM 5 because it has a newer tokenizer; probe unsupported endpoint model IDs |
| Kimi | `kimi-k2.7-code`, `kimi-k3` | official tiktoken rank files and custom tokenizer code | use Kimi estimate for messages; use local tokenizer and controlled tool probes; resolve Kimi Coding aliases to a concrete model first |
| MiniMax | `minimax-m2.7`, `minimax-m3` | official tokenizer JSON artifacts | no verified count endpoint; split M1 from M2 and later; measure provider tool overhead through live probes |
| Qwen | `qwen3-coder`, `qwen3.6-plus` | official tokenizer JSON artifacts | split Qwen 2.5, Qwen 3, and Qwen 3.5 or later; treat Qwen 3.7 and 3.8 aliases as unknown until an official revision is identified |
| MiMo | `mimo-v2.5`, `mimo-v2.5-pro` | official artifacts based on different Qwen generations | map each MiMo generation to its pinned artifact; do not infer from the Xiaomi route alone |
| Mistral family | `codestral-latest`, `devstral-2512`, `mistral-large` | official `mistral-common` tokenizers and request renderer | use model-specific tokenizer revisions locally; measure hosted native Conversations usage because no current preflight endpoint was found |
| Llama | `llama-3.3-70b`, `llama-4-scout` | official Meta tokenizer artifacts | split Llama 3 and Llama 4; render the exact chat template for local or pinned deployments; calibrate relays from usage |
| Grok | `grok-4.5`, `grok-build-0.1` | xAI exposes a text tokenizer service; Grok-1 open artifacts do not prove Grok 4 compatibility | capability-probe the selected current ID, then use text counting for section calibration and postflight usage for the request total |
| Amazon Nova | `nova-2-lite`, `nova-premier` | no general local tokenizer contract | use Bedrock CountTokens on direct Bedrock routes when the selected model appears on AWS's supported list |
| NVIDIA Nemotron | `nemotron-3-super`, `nemotron-3-ultra` | model-specific Hugging Face tokenizer and templates | resolve each checkpoint; Nemotron is not one tokenizer family; calibrate NIM and relays from usage |

Local tokenizer sources:

- [Google experimental local tokenizer](https://github.com/googleapis/python-genai/blob/main/google/genai/local_tokenizer.py)
- [Gemma PyTorch tokenizer](https://github.com/google/gemma_pytorch/tree/main/tokenizer)
- [DeepSeek V3 tokenizer](https://huggingface.co/deepseek-ai/DeepSeek-V3/blob/main/tokenizer.json)
- [DeepSeek V4 Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro)
- [GLM 4.7](https://huggingface.co/zai-org/GLM-4.7)
- [GLM 5](https://huggingface.co/zai-org/GLM-5)
- [Kimi K2.7 Code](https://huggingface.co/moonshotai/Kimi-K2.7-Code)
- [MiniMax M3](https://huggingface.co/MiniMaxAI/MiniMax-M3)
- [Qwen 2.5](https://huggingface.co/Qwen/Qwen2.5-72B-Instruct)
- [Qwen 3](https://huggingface.co/Qwen/Qwen3-235B-A22B)
- [Qwen 3.5](https://huggingface.co/Qwen/Qwen3.5-397B-A17B)
- [MiMo V2.5](https://huggingface.co/XiaomiMiMo/MiMo-V2.5)
- [Mistral common](https://github.com/mistralai/mistral-common)
- [Meta Llama tokenizer source](https://github.com/meta-llama/llama-models)
- [Nemotron 3 Nano](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16)

### Open and long-tail families

| Family | Best available route | Confidence for a hosted Pi request |
|---|---|---|
| OpenAI gpt-oss | use the official Harmony renderer and tokenizer for the complete open-model prompt | high for a pinned Harmony deployment, medium for relays |
| IBM Granite | use the official tokenizer JSON and tool-aware chat template | high for a pinned checkpoint, medium for relays |
| AI21 Jamba | use the official `ai21-tokenizer`, then measure chat and tool overhead | high for text, medium to low for hosted requests |
| Cohere Command | use Cohere `/v1/tokenize` for text, then a live request for chat and tools | high for text, low for full preflight |
| InclusionAI Ling and Ring | use exact Hugging Face artifacts; split Ling 1, Ling 2 and Ling 3 | high for text, medium to low for relays |
| StepFun Step | use a model-matched public artifact where available | high for text when the revision matches, medium to low for relays |
| ByteDance Seed | use the Seed OSS artifact only for a matching Seed OSS model | low for proprietary Seed 1.6 and 2 aliases |
| Arcee Trinity and Virtuoso | use the exact model artifact; they do not share one Arcee tokenizer | medium |
| Poolside Laguna | controlled provider probe | low without a published model-matched contract |
| Aion, Mercury and Nex N2 | controlled provider probe | low |
| KAT-Coder and LongCat | exact public artifact where the hosted ID matches, then live calibration | medium |
| Meta Muse and Writer Palmyra | controlled provider probe | low |
| Inkling, Relace and Interfaze | controlled provider probe | low |
| Upstage Solar, Reka and Sakana Fugu | exact public artifact where the ID matches, then live calibration | medium |
| Tencent HY and NVIDIA Cosmos | exact public artifact where the ID matches, then live calibration | medium |
| Cursor Composer | observed usage and a calibrated route-specific estimate | low because the tokenizer contract is proprietary |

Useful sources:

- [OpenAI Harmony](https://github.com/openai/harmony)
- [IBM Granite 4 models](https://github.com/ibm-granite/granite-4.0-language-models)
- [AI21 tokenizer](https://github.com/AI21Labs/ai21-tokenizer)
- [Ling 2.6 Flash](https://huggingface.co/inclusionAI/Ling-2.6-flash)
- [Seed OSS 36B](https://huggingface.co/ByteDance-Seed/Seed-OSS-36B-Instruct)

## Relay and alias rules

A relay provider must not select the tokenizer profile by itself.

| Route | Safe preflight decision |
|---|---|
| OpenRouter explicit model ID | identify the likely downstream family from the model ID; keep the result estimated until returned usage confirms it |
| OpenRouter `auto`, `free` or `fusion` | unknown before routing |
| Vercel AI Gateway explicit namespaced ID | identify the likely family; do not apply Claude density merely because Pi uses Anthropic Messages on the wire |
| GitHub Copilot explicit model | identify the family from the model ID; use trusted usage after the request |
| GitHub Copilot picker aliases | unknown before selection |
| Radius explicit model | identify the family from the model ID; use returned provider and model metadata when available |
| Radius `auto` | unknown before routing |
| OpenCode explicit model | identify the family from the model ID; treat `big-pickle` and similar aliases as unknown |
| Kimi Coding product aliases | map only when the catalog gives a concrete model; the product route itself is not a tokenizer contract |
| Qwen, Z.AI and Xiaomi token plans | use the concrete selected model; a subscription plan is not a tokenizer family |
| Cloudflare, Together, Fireworks, Groq, Cerebras, NVIDIA NIM and Hugging Face relays | use a model-matched local profile, then reconcile with returned usage |
| llama.cpp | read the loaded model metadata and use its exact tokenizer or server tokenization facility where available |

Fast, slow, batch, free and regional suffixes usually preserve the named model family. They can still change the serving backend or chat template. Keep the same family profile but record the route separately.

## Why local tokenizers are insufficient on their own

A raw tokenizer counts strings. Pi sends structured requests.

A whole-request count can also include:

- role and turn delimiters
- assistant generation prefixes
- system or developer role conversion
- hidden tool-use instructions
- tool names, descriptions and JSON Schema conversion
- tool call IDs and result wrappers
- reasoning-mode controls
- image, audio, video and file tokens
- provider safety or routing instructions
- model-specific chat-template changes

Some open-model packages solve much of this. OpenAI Harmony, `mistral-common` and Hugging Face `apply_chat_template` can render tools and messages before tokenization. They are exact only for the pinned local renderer. A hosted provider may use a different template or inject more text.

This is why Contextimate should keep separate text, session and tool calibrations.

## Runtime and dependency options

### Keep the extension dependency-free

This remains the best default.

Reasons:

- tokenizer artifacts add several megabytes per family
- SentencePiece and Hugging Face tokenizers need native or WebAssembly runtimes
- Kimi uses custom tokenizer code and a tiktoken rank file
- Gemma 4 needs a large processor and tool-aware template
- a bundled tokenizer still cannot reproduce proprietary provider overhead
- startup network calls would add latency, quota use and privacy risk

### Add optional development helpers

Use optional helpers for calibration, outside the extension runtime:

- Python `transformers`, `tokenizers` and `sentencepiece`
- Google `LocalTokenizer`
- `mistral-common`
- OpenAI Harmony
- model-specific Hugging Face tokenizers and processors

Pin the repository revision and hash the tokenizer files. Record the model ID, route, API shape and chat-template revision with every result.

### Consider an external counter command later

A configurable external command could support local deployments without adding package dependencies. It should return structured JSON and declare its coverage:

```json
{
  "tokens": 12345,
  "coverage": "local-rendered-request",
  "model": "Qwen/Qwen3-235B-A22B",
  "revision": "<commit>",
  "tokenizer": "<artifact hash>"
}
```

This should be opt-in. Contextimate must not label the result provider-exact.

## Recommended implementation sequence

### Phase 1: separate route, API shape and tokenizer family

Add a shared model-family resolver in `extensions/_lib`.

It should return:

- route provider
- Pi API shape
- downstream family
- tokenizer generation when known
- whether the model ID is concrete or routed
- evidence source and date

Keep tool payload shaping separate from text token density. This fixes the current Anthropic-compatible and OpenAI-compatible conflation.

### Phase 2: extend the manual provider checker

Add captured payload detection and request builders for:

- OpenAI Chat Completions
- Google Generative AI
- Google Vertex
- Bedrock Converse

Add provider executors for:

- OpenAI `/v1/responses/input_tokens`
- Gemini Developer API `countTokens`
- Vertex `countTokens`
- Bedrock `CountTokens`
- Kimi `estimate-token-count`
- Z.AI `tokenizer`

Keep the current baseline, system-only, all-tools and per-tool matrix where the endpoint supports each field.

For Kimi, report message counts and mark tool-definition coverage unavailable. For Z.AI, reject model IDs outside the documented enum unless an explicit capability probe succeeds.

### Phase 3: create reproducible calibration fixtures

Build a small corpus of Pi-shaped content:

- plain instructions
- Markdown-heavy `AGENTS.md` text
- code and JSON
- multilingual text
- short and long tool descriptions
- flat, nested, array and enum-heavy schemas
- representative session messages and tool results

Measure each family across the corpus. Record median error and worst-case error, not one global characters-per-token value.

Do not commit raw captured prompts. Commit only synthetic fixtures, aggregate counts and source metadata.

### Phase 4: ship high-confidence family profiles

Prioritise by likely use and available evidence:

1. Gemini 2 and Gemini 3 generations
2. DeepSeek V3 and V4
3. GLM 4 and GLM 5
4. Kimi K2 and K3
5. Qwen 2.5, Qwen 3 and Qwen 3.5 or later
6. MiniMax M1 and M2 or later
7. Mistral tokenizer revisions
8. Llama 3 and Llama 4
9. Gemma 3 and Gemma 4
10. MiMo generations

A shipped profile should include:

- model matcher
- route exceptions
- text denominator
- session denominator
- tool method and denominator
- corpus and provider evidence
- date measured
- known unsupported aliases

### Phase 5: cover long-tail and local models safely

For model-matched open checkpoints, allow configuration to name a profile or external tokenizer helper.

For proprietary long-tail models, use controlled live probes and route-specific ratios.

For routers and selectors, show unknown before inference. Use the selected model and provider usage after the response.

## Changes to the existing checker

The current checker predates OpenAI's input-token endpoint. It runs tiny paid Responses generations. Replace that route where the selected direct OpenAI model supports `/v1/responses/input_tokens`.

The checker currently detects only Anthropic Messages and OpenAI Responses payloads. Pi 0.83.0 exposes provider-shaped payloads through `before_provider_request` for Google, Bedrock and OpenAI Chat as well. The capture seam is sufficient. No Pi core patch is needed.

The checker should describe every result with 2 fields:

- `method`, such as `provider-preflight`, `provider-usage-delta` or `local-tokenizer`
- `coverage`, such as `full-request`, `messages`, `text`, `tools` or `multimodal`

This prevents a text-only endpoint from being promoted into an exact request total.

## Validation gates

Before adding a built-in family profile:

1. Capture the exact Pi payload for the route.
2. Verify the provider-qualified model in the assistant message.
3. Count or probe baseline, system, tools and full prefix separately.
4. Run at least 3 content shapes and 3 schema shapes.
5. Compare preflight with returned live usage where both exist.
6. Record fixed tool-block overhead separately from per-tool cost.
7. Test aliases, relays and model-generation boundaries.
8. Replay historical sessions where provider usage exists.
9. Keep every displayed estimate marked with `~`.
10. Document unsupported and opaque routes.

## Source notes and unresolved points

This audit used first-party documentation, installed Pi sources and official model repositories. No paid provider generation was run.

The following points still need an authenticated capability probe:

- whether direct Google count calls consume billable quota on every current Gemini route
- whether the Kimi Coding membership key can call the public Moonshot estimate endpoint
- whether DashScope still exposes a documented Qwen tokenization service, which model IDs it accepts and whether Coding Plan keys can call it
- whether Z.AI Coding Plan keys can call `/paas/v4/tokenizer`
- which later GLM model IDs the Z.AI endpoint accepts beyond its published enum
- whether Azure OpenAI supports OpenAI's Responses input-token endpoint on any current API version
- whether a relay exposes an undocumented native provider count endpoint

Treat all of these as unavailable until a capability probe succeeds. OpenAI compatibility alone is not evidence that a provider implements OpenAI's count endpoint.
