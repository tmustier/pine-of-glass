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
| Z.AI | `ZAI_API_KEY` | message and tool sections for supported GLM models |

Live calls always require `--provider`, because wire compatibility does not identify the service. Dry runs can infer Anthropic, OpenAI, Gemini or Bedrock from the payload shape.

With at least 2 tools, the checker removes the shared tool-block overhead before suggesting Contextimate denominators. Tests cover request construction and this calculation. Network execution remains manual.
