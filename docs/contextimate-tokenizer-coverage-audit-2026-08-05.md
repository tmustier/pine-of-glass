# Contextimate tokenizer coverage audit

Date: 5 August 2026

## Decision

Keep Contextimate dependency-free. Use provider count endpoints and local tokenizers for calibration, then ship small measured profiles.

Use evidence in this order:

1. billed usage for a completed request
2. a provider count endpoint for the same request
3. a narrower message or text count
4. a pinned local tokenizer and chat template
5. a controlled usage-delta probe
6. a calibrated estimate
7. unknown when a router has not selected a model

Do not bundle tokenizers into the extension. Their artifacts are large, several need native or Python runtimes, and raw tokenization misses provider chat and tool encoding.

## Implemented after the audit

The provider checker now supports:

| Provider | Coverage |
|---|---|
| Anthropic | sections and the complete input accepted by `count_tokens` |
| OpenAI | sections and the complete input accepted by `/responses/input_tokens` |
| Gemini Developer API | sections and complete `GenerateContentRequest` |
| Vertex AI | sections and complete count request |
| Amazon Bedrock | sections and complete Converse request for supported models |
| Kimi | system-message section |
| Z.AI | system-message and tool sections for supported GLM models |

Contextimate now resolves tokenizer family separately from wire API shape. Kimi, MiniMax and Vercel models no longer inherit Claude token density merely because Pi sends Anthropic-shaped requests.

The checker remains a manual calibration tool. It does not add startup network calls or runtime dependencies.

## Scope

This audit covers Pi and `@earendil-works/pi-ai` 0.83.0.

The generated catalog contains 1,153 entries in 37 static provider catalogs. It was generated on 29 July 2026. Radius adds a dynamic catalog, which contained 36 models during this audit.

Three surfaces are unbounded:

- `models.json` can add any model served through a supported API
- provider extensions can add any model and API
- llama.cpp discovers loaded GGUF models

The installed Cursor extension added 210 model entries. These are outside Pi's built-in catalog.

## Pi model inventory

Counts include aliases and serving variants, not unique tokenizers.

| Provider catalog | Models | Pi API shape |
|---|---:|---|
| amazon-bedrock | 114 | Bedrock Converse |
| ant-ling | 3 | OpenAI Chat |
| anthropic | 15 | Anthropic Messages |
| azure-openai-responses | 38 | Azure OpenAI Responses |
| cerebras | 3 | OpenAI Chat |
| cloudflare-ai-gateway | 43 | Anthropic, OpenAI Chat and Responses |
| cloudflare-workers-ai | 13 | OpenAI Chat |
| deepseek | 2 | OpenAI Chat |
| fireworks | 16 | Anthropic and OpenAI Chat |
| github-copilot | 29 | Anthropic, OpenAI Chat and Responses |
| google | 24 | Google Generative AI |
| google-vertex | 12 | Google Vertex |
| groq | 7 | OpenAI Chat |
| huggingface | 51 | OpenAI Chat |
| kimi-coding | 4 | Anthropic Messages |
| minimax | 3 | Anthropic Messages |
| minimax-cn | 3 | Anthropic Messages |
| mistral | 30 | Mistral Conversations |
| moonshotai | 10 | OpenAI Chat |
| moonshotai-cn | 10 | OpenAI Chat |
| nvidia | 30 | OpenAI Chat |
| openai | 38 | OpenAI Responses |
| openai-codex | 7 | OpenAI Codex Responses |
| opencode | 59 | Anthropic, Google, OpenAI Chat and Responses |
| opencode-go | 16 | Anthropic, OpenAI Chat and Responses |
| openrouter | 303 | OpenAI Chat |
| qwen-token-plan | 15 | OpenAI Chat |
| qwen-token-plan-cn | 15 | OpenAI Chat |
| together | 17 | OpenAI Chat |
| vercel-ai-gateway | 193 | Anthropic Messages |
| xai | 3 | OpenAI Chat and Responses |
| xiaomi | 6 | OpenAI Chat |
| xiaomi-token-plan-ams | 3 | OpenAI Chat |
| xiaomi-token-plan-cn | 3 | OpenAI Chat |
| xiaomi-token-plan-sgp | 3 | OpenAI Chat |
| zai | 6 | OpenAI Chat |
| zai-coding-cn | 6 | OpenAI Chat |
| Total | 1,153 | 37 static catalogs |

The entries collapse into about 40 identifiable families. The major groups are:

- Claude
- GPT, Codex, o-series and gpt-oss
- Gemini and Gemma
- Llama
- DeepSeek
- Qwen and MiMo
- Kimi
- MiniMax
- GLM
- Mistral and its Codestral, Devstral, Magistral, Ministral, Mixtral, Pixtral and Voxtral variants
- Grok
- Nova
- Nemotron, Cosmos and Granite
- Command, Jamba, Ling, Ring, Step and Seed
- long-tail open and proprietary models served mainly through relays

Selectors such as `auto`, `free`, `fusion`, `big-pickle`, `mai-code-1-flash-picker` and Cursor `default` do not identify a tokenizer before routing.

## Counting coverage

### Full-request provider endpoints

| Provider | Endpoint | Limits |
|---|---|---|
| Anthropic | `POST /v1/messages/count_tokens` | billed usage remains authoritative; previous probes differed by at most 15 tokens |
| OpenAI | `POST /v1/responses/input_tokens` | direct platform API only; Codex OAuth and relays do not document support |
| Gemini | `POST /v1beta/models/{model}:countTokens` | Pi SDK parameters must be translated into `GenerateContentRequest` |
| Vertex AI | publisher model `:countTokens` | use the exact project, location and model |
| Bedrock | `CountTokens` | support is model-specific; some cross-region Claude routes use Bedrock Mantle |

### Narrow provider endpoints

| Provider | Endpoint | Coverage |
|---|---|---|
| Kimi | `POST /v1/tokenizers/estimate-token-count` | messages and multimodal parts, but no top-level tool definitions or assistant tool calls |
| Z.AI | `POST /api/paas/v4/tokenizer` | messages and up to 128 tools; published model enum lists GLM 4.5, 4.6 and 4.6V |
| Cohere | `POST /v1/tokenize` | one text string for a named model |
| xAI | `TokenizeText` | one text string for an accepted Grok model; current Grok IDs need a capability check |

### Public local tokenizers

| Family | Local option | Hosted-request confidence |
|---|---|---|
| Gemini | Google experimental `LocalTokenizer` for a limited allowlist | high for visible text, lower for hosted tools |
| Gemma | official SentencePiece or processor artifacts | high for a pinned checkpoint and template |
| DeepSeek | official Hugging Face tokenizer JSON | high for text, lower for provider tools |
| GLM | official tokenizer JSON; GLM 5 uses a newer tokenizer | high for text when the revision matches |
| Kimi | official tiktoken rank files and custom tokenizer code | high for text, lower for provider tools |
| MiniMax | official tokenizer JSON | split M1 from M2 and later |
| Qwen | official tokenizer JSON | split Qwen 2.5, 3 and 3.5 or later |
| MiMo | model-specific Qwen-derived artifacts | resolve each model revision |
| Mistral | `mistral-common` tokenizer and request renderer | high for a pinned renderer |
| Llama | official Meta artifacts and chat templates | split Llama 3 and 4 |
| gpt-oss | OpenAI Harmony | high for a pinned Harmony deployment |
| Nemotron, Granite and other open checkpoints | model-specific Hugging Face artifacts | depends on the relay's chat template |

A raw tokenizer does not include role delimiters, tool-schema conversion, hidden instructions, multimodal charging or provider templates. Local results must stay labelled by their measured coverage.

## Relay rules

| Route | Preflight treatment |
|---|---|
| explicit model on OpenRouter, Vercel, Copilot, Radius or OpenCode | resolve the likely family from the model ID; keep the result estimated until usage confirms it |
| `auto`, `free`, `fusion`, picker and default aliases | unknown before routing |
| Kimi, Qwen, Z.AI and Xiaomi subscription plans | use the selected model, not the plan name |
| Cloudflare, Together, Fireworks, Groq, Cerebras, NVIDIA and Hugging Face relays | use a model-matched profile, then reconcile with returned usage |
| llama.cpp | use the loaded model's tokenizer or server tokenization facility |

Fast, batch, regional and free suffixes usually preserve the named family. Record the route separately because the template can still differ.

## Contextimate policy

Resolve these facts independently:

- serving route, for credentials and endpoint support
- wire API shape, for system and tool serialization
- tokenizer family and revision, for token density

Current measured profiles remain:

- Claude 4.5 and 4.6
- Claude 4.7 and later
- OpenAI Codex and Responses

Gemini, Bedrock, Mistral and unidentified families remain estimates at characters divided by 4 until calibration data supports a better profile. API compatibility alone does not change that denominator.

Use `scripts/contextimate/check-provider-tokens.ts` to measure captured Pi payloads. Add profiles only after checking several Pi-shaped text and schema fixtures, plus returned provider usage where available.

## Remaining work

Prioritise measured profiles in this order:

1. Gemini 2.x and 3.x
2. DeepSeek V3 and V4
3. GLM 4 and 5
4. Kimi K2 and K3
5. Qwen 2.5, 3 and 3.5 or later
6. MiniMax M1 and M2 or later
7. Mistral revisions
8. Llama 3 and 4
9. Gemma 3 and 4
10. MiMo revisions

Still requiring a capability check:

- Kimi Coding membership keys against the public Moonshot endpoint
- Z.AI Coding Plan keys against the tokenizer endpoint
- GLM model IDs newer than the published tokenizer enum
- current xAI model IDs against `TokenizeText`
- whether DashScope still documents a Qwen tokenization service and which plans can use it
- Azure support for OpenAI's Responses input-token endpoint

No paid provider generation was run for this audit.

## Sources

- [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [OpenAI Responses input-token count](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
- [Gemini countTokens](https://ai.google.dev/api/tokens)
- [Vertex countTokens](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/count-tokens)
- [Bedrock CountTokens](https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html)
- [Kimi estimate tokens](https://platform.kimi.ai/docs/api/estimate)
- [Z.AI tokenizer](https://docs.z.ai/api-reference/tools/tokenizer.md)
- [Cohere tokenize](https://docs.cohere.com/reference/tokenize)
- [xAI tokenizer example](https://github.com/xai-org/xai-sdk-python/blob/main/examples/sync/tokenizer.py)
- [Google local tokenizer](https://github.com/googleapis/python-genai/blob/main/google/genai/local_tokenizer.py)
- [Mistral common](https://github.com/mistralai/mistral-common)
- [OpenAI Harmony](https://github.com/openai/harmony)
- [Meta Llama models](https://github.com/meta-llama/llama-models)
