# pi-contextimate validation scripts

These scripts are optional local diagnostics. They write artifacts under `/tmp` by default and must not be used to commit or publish full provider payloads.

## Historical transcript session-growth evaluation

```bash
node scripts/contextimate/evaluate-transcripts.mjs \
  --root ~/.pi/agent/sessions \
  --output /tmp/pi-contextimate-transcript-eval/results.json
```

This compares recorded provider input usage in local Pi JSONL sessions with the current session-material heuristic. It fits one static intercept per transcript because historical JSONL sessions do **not** store the startup system prompt or provider tool schema payload. Use it to evaluate session growth, not static prefix/tool-schema accuracy.

## Live prefix probe

```bash
node scripts/contextimate/probe-live-prefix.mjs \
  --model openai-codex/gpt-5.5 \
  --cwd ~/projects/commercial \
  --output-dir /tmp/pi-contextimate-prefix-probe
```

This runs a tiny live Pi request with `thinking off`, captures the outgoing provider payload via `before_provider_request`, and records provider `usage.input`. It clears inherited parent-session model selectors, then verifies the provider-qualified model in the generated assistant message. A mismatch exits non-zero and the capture must be discarded; disable the extension or preset that changed model selection before retrying. The printed summary contains only sizes and usage; the payload JSONL artifact can contain sensitive prompt/tool data and should stay local.

Pass extra Pi flags after `--`, for example:

```bash
node scripts/contextimate/probe-live-prefix.mjs -- --no-tools --no-skills --no-context-files
```

## Provider token checks

```bash
node scripts/contextimate/probe-live-prefix.mjs --output-dir /tmp/probe
node scripts/contextimate/check-provider-tokens.ts --payload /tmp/probe/*.payloads.jsonl
node scripts/contextimate/check-provider-tokens.ts --payload /tmp/probe/*.payloads.jsonl --provider anthropic --live
```

The checker measures the system prompt and tools against a minimal message. Add `--full` to count the complete captured request where the provider supports it. Use `--tools name1,name2`, `--model` or `--json` to narrow or structure the result.

Supported count APIs:

| Provider | Credential | Coverage |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` or Pi OAuth | sections and full countable input |
| OpenAI | `OPENAI_API_KEY` | sections and full countable Responses input |
| Gemini Developer API | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | sections and full request |
| Vertex AI | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and `GOOGLE_CLOUD_ACCESS_TOKEN` | sections and full request |
| Amazon Bedrock | standard AWS credentials and `AWS_REGION` | sections and full request for supported models |
| Kimi | `MOONSHOT_API_KEY` | message sections |
| Cohere | `COHERE_API_KEY` | raw system text for a named model |
| Z.AI | `ZAI_API_KEY` | message and tool sections for supported GLM models |

Live calls always require `--provider`, because wire compatibility does not identify the service. Dry runs can infer Anthropic, OpenAI, Gemini or Bedrock from the payload shape. Cohere's endpoint counts raw text, not chat roles or tools; pass the direct Cohere model name with `--model` when the capture came through a relay.

With at least 2 tools, the checker removes the shared tool-block overhead before suggesting Contextimate denominators. Tests cover request construction and this calculation. Network execution remains manual.

The calibration checks below are manual. They add no runtime dependencies or startup network calls, and make no generation requests.

## Open tokenizer calibration

Reproduce the Kimi, GLM, Cohere, DeepSeek and Qwen raw-text profiles from a source checkout:

```bash
uv run --with 'huggingface-hub==1.26.0' --with 'tokenizers==0.22.2' \
  --with 'tiktoken==0.13.0' scripts/contextimate/study-open-tokenizers.py --json
```

The script pins each revision and tokenizer hash. It reads the public corpus at git revision `556dd115a77839773e143afc0d982afa59eb7479`, so later changes cannot move the baseline. It verifies Kimi's rank file and configuration directly. For DeepSeek and Qwen, it checks the BPE content and corpus token stream of every artifact. It does not execute downloaded code.

## Gemini count fingerprints

Gemini exposes counts through the official `countTokens` endpoint. Reproduce the Gemini evidence with an API key:

```bash
GEMINI_API_KEY=... scripts/contextimate/check-gemini-tokenizers.py --json
```

The checker sends each fixture as one user text part. It groups its 17 default model IDs only when all counts match. Repeat `--model` to check another exact ID. It never prints the key or source text. Google can retire preview IDs, so the checked-in evidence preserves the measured result.

## Relay alias verification

Verify profiled DeepSeek and Qwen routes against OpenRouter and Vercel's public catalogs:

```bash
npm run link-pi
scripts/contextimate/check-relay-tokenizer-routes.py
```

The checker compares installed Pi routes with OpenRouter's Hugging Face IDs and Vercel's full model names. It needs no API key.

## xAI tokenizer fingerprints

xAI exposes exact token IDs and bytes through `TokenizeText`. The separate checker keeps its optional Python SDK out of the extension and npm dependency tree:

```bash
uv run --with 'xai-sdk==1.17.0' \
  scripts/contextimate/check-xai-tokenizers.py --json
```

It reads `XAI_API_KEY`, or a fresh xAI OAuth login from Pi. The fixed public corpus covers prose, code, multilingual text, whitespace, control-like strings and deterministic random text. Models join one group only when every token record matches.

Add `--contextimate-corpus` to calculate divisors from the pinned open-tokenizer corpus. Add `--file <path>` for another local corpus, but never send sensitive files. Use repeated `--model` options to inspect aliases. The script reports the resolved model. It never prints credentials or source text.
