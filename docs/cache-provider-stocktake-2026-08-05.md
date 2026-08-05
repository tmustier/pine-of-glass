# Cache provider stocktake, 5 August 2026

## Decision

Cachemire now supports four evidence-backed route groups beyond direct Anthropic and
OpenAI:

1. MiniMax M2.7 and M2.7 highspeed, on the global and China routes
2. Amazon Bedrock Claude 4.5 and 4.6 models with an observed `cachePoint`
3. Groq GPT-OSS models, after a cache read confirms that an automatic entry exists
4. Cerebras supported models, as a 1-hour maximum after a confirmed read

OpenRouter's Anthropic routes also publish 5-minute and 1-hour cache policies. They
need a gateway-specific policy because fallback can change the physical provider before
the TTL ends.

Most other routes can support observed hit, miss and cost reporting. They cannot support
a safe retention clock. Their public documentation omits a maximum, uses an automatic
cache with an unpublished lifetime, or hides the final upstream route.

The implementation uses an evidence registry keyed by provider, wire API, model and
observed request policy. Each match also states whether a reported cache write can
activate the window or whether a confirmed read is required.

## Scope

This audit covers Pi 0.83.0 and `@earendil-works/pi-ai` 0.83.0. Pi's static model data
was generated on 29 July 2026.

The installed text catalogue contains:

- 37 static provider routes
- 1,153 static model entries
- Radius, with a dynamic gateway catalogue
- llama.cpp, with a dynamic local router catalogue
- arbitrary custom providers and models registered through `models.json` or extensions

Pi also exposes 40 OpenRouter image-generation entries. They are outside this audit
because Cachemire observes text model calls and prompt-prefix usage, not image generation.

Model counts are route entries, not unique foundation models. The same model can appear
through several providers and wire APIs. OpenRouter, Vercel AI Gateway and Amazon
Bedrock account for 610 entries between them.

This audit groups aliases that share one cache contract. It names exact models where the
contract differs within a route. Copying all 1,153 generated IDs into this document would
create a second stale catalogue.

## Cachemire already has broad outcome support

Cachemire's ledger and hit or miss classification are provider-neutral once Pi reports
normalized usage. Pi 0.83.0 maps cache usage from these wire APIs:

| Wire API | Pi cache-read source | Pi cache-write source |
|---|---|---|
| Anthropic Messages | `cache_read_input_tokens` | `cache_creation_input_tokens` |
| Amazon Bedrock Converse | `cacheReadInputTokens` | `cacheWriteInputTokens` |
| OpenAI Chat Completions | `prompt_tokens_details.cached_tokens`, then `prompt_cache_hit_tokens` | `prompt_tokens_details.cache_write_tokens` |
| OpenAI, Azure and Codex Responses | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` |
| Google Gemini and Vertex | `usageMetadata.cachedContentTokenCount` | none |
| Mistral Conversations | 6 accepted spellings of cached-token detail | none |
| Pi Messages and Radius | gateway-normalized usage | gateway-normalized usage |
| llama.cpp | `prompt_tokens_details.cached_tokens` | none |

Cachemire therefore reports outcomes for many non-Anthropic and non-OpenAI routes. Its
retention registry covers direct Anthropic and OpenAI, MiniMax M2.7, documented Bedrock
Claude 4.5 and 4.6 models, Groq GPT-OSS, and supported Cerebras models.

Pi ignores top-level `usage.cached_tokens`, used by Moonshot and some Together
responses. Cachemire overlays those providers and copies the count into Pi's supported
nested field when no native cache-read field exists. Existing custom streams win, and
the overlay is removed on shutdown or reload.

Pricing and a non-zero cached-token count prove a read. They do not prove retention,
eviction cause, replica identity or future warmth.

## Provider and model inventory

The status column describes the strongest safe Cachemire behavior from current public
evidence.

| Pi provider route | Static models | Wire API | Model scope | Strongest safe status |
|---|---:|---|---|---|
| `amazon-bedrock` | 114 | Bedrock Converse | Amazon, Anthropic, DeepSeek, Google, Meta, MiniMax, Mistral, Moonshot, NVIDIA, OpenAI, Qwen, Writer, xAI and Z.AI families | 5-minute or 1-hour clock for documented Claude 4.5 and 4.6 models; usage only for the rest |
| `ant-ling` | 3 | OpenAI Completions | Ling 2.6 and Ring 2.6 | no public cache contract |
| `anthropic` | 15 | Anthropic Messages | Claude Haiku, Sonnet, Opus and Fable | current 5-minute or 1-hour clock |
| `azure-openai-responses` | 38 | Azure Responses | GPT-4, GPT-5 and o-series | usage only until Pi exposes the selected retention policy |
| `cerebras` | 3 | OpenAI Completions | Gemma 4, GPT-OSS 120B and GLM 4.7 | 1-hour maximum for supported models after a confirmed read |
| `cloudflare-ai-gateway` | 43 | Anthropic, OpenAI Completions and OpenAI Responses | Claude, GPT and Workers AI routes | gateway route unknown; response cache is a separate feature |
| `cloudflare-workers-ai` | 13 | OpenAI Completions | Cloudflare-hosted Gemma, Llama, Mistral, Kimi, Nemotron, GPT-OSS, Qwen and GLM | usage only; no published TTL |
| `deepseek` | 2 | OpenAI Completions | DeepSeek V4 Flash and Pro | usage only; lifetime is not a contract |
| `fireworks` | 16 | Anthropic and OpenAI Completions | DeepSeek, GPT-OSS, Kimi, MiniMax, Qwen and GLM | usage only; replica-local lifetime is variable |
| `github-copilot` | 29 | Anthropic, OpenAI Completions and OpenAI Responses | Claude, Gemini, GPT, Kimi and MAI | no public backend retention contract |
| `google` | 24 | Google Generative AI | Gemini, Gemma and Deep Research | implicit-cache usage only; explicit cache resources are not used by Pi |
| `google-vertex` | 12 | Google Vertex | Gemini | implicit-cache usage only; explicit cache resources are not used by Pi |
| `groq` | 7 | OpenAI Completions | Llama, GPT-OSS and Qwen | 2-hour idle clock for 3 GPT-OSS models after a confirmed read |
| `huggingface` | 51 | OpenAI Completions | routed models from 10 vendors | upstream route unknown |
| `kimi-coding` | 4 | Anthropic Messages | Kimi coding aliases and K3 | no route-specific cache contract |
| `minimax` | 3 | Anthropic Messages | MiniMax M2.7, M2.7 highspeed and M3 | 5-minute clock for M2.7 models; usage only for M3 |
| `minimax-cn` | 3 | Anthropic Messages | MiniMax M2.7, M2.7 highspeed and M3 | 5-minute clock for M2.7 models; usage only for M3 |
| `mistral` | 30 | Mistral Conversations | Codestral, Devstral, Magistral, Ministral, Mistral, Mixtral and Pixtral | Pi can read returned cache usage, but Mistral publishes no hosted cache contract |
| `moonshotai` | 10 | OpenAI Completions | Kimi K2 and K3 families | observed usage through Cachemire's response shim; automatic cache, 256-token minimum, unknown lifetime |
| `moonshotai-cn` | 10 | OpenAI Completions | Kimi K2 and K3 families | observed usage through Cachemire's response shim; automatic cache, 256-token minimum, unknown lifetime |
| `nvidia` | 30 | OpenAI Completions | routed models from 11 vendors | no managed NIM cache contract |
| `openai` | 38 | OpenAI Responses | GPT-4, GPT-5 and o-series | current 30-minute minimum for GPT-5.6 and later GPT-5 families; current 24-hour maximum for an observed supported pre-GPT-5.6 request |
| `openai-codex` | 7 | Codex Responses | GPT-5 Codex and GPT-5.6 variants | current 30-minute minimum for GPT-5.6 variants; no backend-specific maximum |
| `opencode` | 59 | Anthropic, Google and OpenAI APIs | routed models from 15 families | pricing evidence only; no gateway retention contract |
| `opencode-go` | 16 | Anthropic and OpenAI APIs | routed models from 8 families | pricing evidence only; no gateway retention contract |
| `openrouter` | 303 | OpenAI Completions | routed models from more than 30 vendors | explicit Anthropic policy candidate with gateway caveat; usage only otherwise |
| `qwen-token-plan` | 15 | OpenAI Completions | Qwen, DeepSeek, Kimi, MiniMax and GLM | no Token Plan cache contract |
| `qwen-token-plan-cn` | 15 | OpenAI Completions | Qwen, DeepSeek, Kimi, MiniMax and GLM | no Token Plan cache contract |
| `together` | 17 | OpenAI Completions | routed models from 10 vendors | observed usage through native fields or Cachemire's response shim; no retention window |
| `vercel-ai-gateway` | 193 | Anthropic Messages | routed models from more than 20 vendors | upstream policy and provider can vary |
| `xai` | 3 | OpenAI Completions and Responses | Grok 4.3, 4.5 and Build | usage only; entries can be evicted at any time |
| `xiaomi` | 6 | OpenAI Completions | MiMo V2, V2.5 and Pro variants | usage and pricing only; no public lifetime |
| `xiaomi-token-plan-ams` | 3 | OpenAI Completions | MiMo V2 Pro and V2.5 | usage and plan pricing only; no public lifetime |
| `xiaomi-token-plan-cn` | 3 | OpenAI Completions | MiMo V2 Pro and V2.5 | usage and plan pricing only; no public lifetime |
| `xiaomi-token-plan-sgp` | 3 | OpenAI Completions | MiMo V2 Pro and V2.5 | usage and plan pricing only; no public lifetime |
| `zai` | 6 | OpenAI Completions | GLM 4.5, 4.7 and 5 families | cached-input billing, but no Coding Plan retention contract |
| `zai-coding-cn` | 6 | OpenAI Completions | GLM 4.5, 4.7 and 5 families | cached-input billing, but no Coding Plan retention contract |
| `radius` | dynamic | Pi Messages | gateway catalogue | usage only; resolved upstream policy is hidden |
| `llama.cpp` | dynamic | OpenAI Completions | loaded local GGUF models | observed reads only; capacity and process lifecycle replace TTL |

## Existing direct route decisions still hold

Direct Anthropic supports explicit 5-minute and 1-hour cache entries, refreshed by a
hit. Cachemire observes the outgoing `cache_control` but activates the request-time
window only after `cacheRead > 0` or `cacheWrite > 0` confirms an entry.

Direct OpenAI automatically caches eligible prefixes. Supported models below GPT-5.6
can request `prompt_cache_retention: "24h"`. The field defines a maximum policy and
supports no warmth claim before it. Although Pi accepts a normalized cache-write field,
this direct OpenAI route does not report one, so Cachemire activates the maximum only
after `cacheRead > 0`. The read is a safe anchor: 24 hours later the observed entry must
have reached the documented maximum, even if it was created earlier.

For GPT-5.6 and later GPT-5 families, OpenAI documents a 30-minute minimum lifetime.
The only supported `prompt_cache_options.ttl` value is `30m`, and it is the default even
when a client omits the field. Cachemire can stay silent during that minimum and change
to unknown at the boundary. The minimum provides no stale or expiry claim.

OpenAI Codex uses a separate ChatGPT subscription backend. Its public client and Pi's
adapter expose cache keys and cached-token usage. The GPT-5.6 family minimum still
applies, but direct API policy such as the pre-GPT-5.6 24-hour maximum must not be
transferred to Codex.

Primary sources:

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Codex pricing and limits](https://developers.openai.com/codex/pricing)

## Implemented retention routes

### MiniMax M2.7 is the clearest addition

MiniMax documents explicit `cache_control` for M2.7 and M2.7 highspeed on both regional
routes. The cache lasts 5 minutes and a hit refreshes it at no extra cost. The provider
returns Anthropic-compatible read and write fields, which Pi already normalizes.

Cachemire limits this policy to the `minimax` and `minimax-cn` Anthropic routes, the 2
M2.7 model IDs, an observed marker, and confirmed read or write usage. MiniMax M3 uses
passive automatic caching with no published lifetime, so its retention remains unknown.

Primary sources:

- [MiniMax global explicit cache](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache.md)
- [MiniMax global passive cache](https://platform.minimax.io/docs/api-reference/text-prompt-caching.md)
- [MiniMax China explicit cache](https://platform.minimaxi.com/docs/api-reference/anthropic-api-compatible-cache.md)
- [MiniMax China passive cache](https://platform.minimaxi.com/docs/api-reference/text-prompt-caching.md)

### Bedrock Claude has strong route-specific evidence

Amazon Bedrock documents 5-minute and model-specific 1-hour cache points for Claude.
Successful hits reset the TTL. Pi places `cachePoint: {"type":"default"}` in supported
Claude requests. It adds `ttl: "1h"` for long retention and maps Bedrock's read and write
usage.

Cachemire accepts only an observed `cachePoint`, a dated allowlist of documented Claude
4.5 and 4.6 IDs, and confirmed read or write usage. Bedrock's overview and model cards do
not always agree for newer Claude aliases, which remain unknown.

Pi uses the same Converse adapter for 114 entries, but cache support differs by model:

- Nova has automatic and explicit caching, but Pi currently uses the automatic path
- GPT-5.6's documented breakpoint cache uses Bedrock's Responses endpoint and gives a
  30-minute minimum, not a usable maximum
- Mistral Large 3 and MiniMax M2.1 model cards say caching is supported but omit enough
  lifecycle detail for a clock
- most other Bedrock families publish no prompt-cache contract

Primary source:

- [Amazon Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)

### Groq can start a clock only after a read

Groq documents automatic exact-prefix caching for:

- `openai/gpt-oss-20b`
- `openai/gpt-oss-120b`
- `openai/gpt-oss-safeguard-20b`

Cached data expires after 2 hours without use. Cacheable prompt minimums vary from 128
to 1,024 tokens. Groq reports reads but no writes.

A first miss does not prove that Groq created an entry, so Cachemire starts or refreshes
the 2-hour window only after `cacheRead > 0`.

Pi's GPT-OSS safeguard price card records no cache-read rate, so Cachemire cannot
accurately price those reads.

Primary source:

- [Groq prompt caching](https://console.groq.com/docs/prompt-caching)

### Cerebras supports a conservative maximum

Cerebras documents automatic 128-token-block caching for `zai-glm-4.7` and
`gpt-oss-120b`. It guarantees 5 minutes and says entries may persist for up to 1 hour.
It does not say that a read refreshes the guarantee. Reads and uncached input have the
same price.

After a confirmed read, Cachemire records the 1-hour maximum without claiming prior
warmth.

Primary source:

- [Cerebras prompt caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching)

### OpenRouter needs a gateway policy kind

OpenRouter documents 5-minute and 1-hour policies for Anthropic cache controls. It says
the 1-hour option works across Anthropic, Amazon Bedrock and Google Vertex providers.
OpenRouter also uses sticky provider routing after cache use or when `session_id` is
present.

A fallback can move the next request to another physical cache, while Cachemire's
`contract` window assumes stable cache identity. OpenRouter retention therefore remains
unknown. Its Anthropic policy also cannot cover all 303 models: Pi adds Anthropic-style
markers only to `anthropic/*` model IDs.

Primary source:

- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

## Routes with useful outcomes but no safe clock

### Automatic caches with unpublished or variable lifetimes

These routes report enough information for hit and cost reporting, but their retention
remains unknown:

- DeepSeek: automatic per-user cache, usually cleared within hours to days
- xAI: automatic cache, with eviction allowed at any time
- Fireworks: replica-local entries usually last several minutes and may last for hours
- Together: best-effort short-lived serverless cache, with no configurable window
- Moonshot: automatic cache above 256 tokens, with a system-managed lifetime
- MiniMax M3: passive cache above 512 tokens, with no published lifetime
- Xiaomi and Xiaomi Token Plan: cached-input fields and prices, with no lifecycle
- Z.AI Coding Plan: cached-input billing, with no exact Coding Plan lifetime
- Cloudflare Workers AI: prefix caching and session affinity, with no numeric TTL

Primary sources:

- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [xAI prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works)
- [Fireworks prompt caching](https://docs.fireworks.ai/guides/prompt-caching)
- [Together serverless model pricing](https://docs.together.ai/docs/serverless/models)
- [Moonshot context caching](https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api.md)
- [Xiaomi OpenAI-compatible API](https://mimo.mi.com/static/docs/api/chat/openai-api.md)
- [Z.AI cache guide](https://docs.z.ai/guides/capabilities/cache.md)
- [Cloudflare Workers AI prompt caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/)

### Explicit cache resources that Pi does not use

Google Gemini supports explicit `cachedContents` resources with a default 1-hour TTL.
Former Vertex AI context-cache documentation now redirects to the Gemini Enterprise
Agent Platform, leaving the exact Vertex Generative API lifecycle unverified. Pi's normal
Generative AI and Vertex requests do not create cache resources or send a `cachedContent`
resource name. Cachemire sees only implicit-cache usage, whose lifetime is unpublished.
Resource creation and updates also happen outside `before_provider_request`.

Primary sources:

- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Gemini GenerateContent caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
- [Former Vertex context cache overview, now redirected](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)

### Azure has a contract that Pi does not expose

Azure documents automatic caching from 1,024 tokens. Its in-memory policy usually clears
entries after 5 to 10 minutes of inactivity and always within 1 hour. Supported models
can use up to 24 hours. Newer model generations have different defaults.

Pi's Azure Responses adapter sends `prompt_cache_key`, but it does not send or expose
`prompt_cache_retention`. Deployment names can also hide the exact deployed model.
Cachemire cannot prove which policy applied, so the clock remains unknown.

Primary source:

- [Azure prompt caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)

### Gateway routes hide cache identity

These providers route to other providers or use undocumented subscription backends:

- Cloudflare AI Gateway
- Vercel AI Gateway
- Hugging Face Inference Providers
- OpenCode Zen and OpenCode Go
- GitHub Copilot
- Radius
- Kimi For Coding
- Qwen Token Plan

The route may report cached usage or publish cache prices. That does not identify the
physical provider, replica or retention policy.

Cloudflare AI Gateway also offers a separate whole-response cache. It is controlled by
HTTP headers, lasts from 60 seconds to one month and returns a stored response on a hit.
That feature is not prompt-prefix caching. Pi does not set its cache headers, so the
current route does not expose response-cache replays to Cachemire.

Qwen's ordinary Model Studio API documents a 5-minute explicit cache. The Token Plan
uses isolated keys and endpoints and does not publish the same route contract, so
Cachemire leaves its retention unknown.

Primary sources:

- [Cloudflare AI Gateway response caching](https://developers.cloudflare.com/ai-gateway/features/caching/)
- [Vercel AI Gateway automatic caching](https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching)
- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/index)
- [OpenCode Zen model pricing](https://opencode.ai/docs/zen)
- [OpenCode Go model pricing](https://opencode.ai/docs/go)
- [GitHub Copilot request billing](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/copilot-requests)
- [Radius gateway](https://radius.pi.dev/)
- [Kimi Code documentation](https://www.kimi.com/code/docs/en/)
- [Qwen Token Plan quick start](https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-quick-start.md)
- [Qwen Model Studio context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache.md)

### Local and self-hosted caches are capacity-based

llama.cpp enables prompt caching by default and reuses the longest prefix in a selected
slot. Pi does not bind a session to a slot. Entries can disappear through slot reuse,
RAM pressure, model unload, router LRU, configured sleep or process restart. There is no
TTL. Pi receives read usage but no write usage.

NVIDIA NIM can pass backend options such as vLLM prefix caching. The deployment operator
controls the backend and lifecycle. NVIDIA publishes no common managed retention
contract for Pi's NIM route.

Mistral's official hosted API documentation does not publish a prompt-cache contract.
Pi sends affinity fields and accepts several possible cached-token response shapes, but
those client seams do not establish server behavior.

Primary sources:

- [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [NVIDIA NIM environment variables](https://docs.nvidia.com/nim/large-language-models/latest/reference/environment-variables.html)
- [Mistral documentation index](https://docs.mistral.ai/llms.txt)

## Refresh procedure

Repeat this audit when Pi changes its model catalogue or provider request builders:

1. Record the Pi and `pi-ai` versions and the generated model-data timestamp.
2. Enumerate every provider, model ID and wire API from Pi's generated catalogue.
3. Diff all cache-related request and response fields in `pi-ai/dist/api`.
4. Read the official cache and pricing page for every changed provider or model family.
5. Record exact TTLs, maxima, minima, refresh rules, request controls and usage fields.
6. Treat missing or conflicting evidence as unknown.
7. Update the policy registry, evidence tests, this audit and `docs/pi-cachemire.md`
   together.
8. Run `npm run check`.

The audit date belongs to the evidence. Update it only after checking the linked primary
sources again.
