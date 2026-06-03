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

This runs a tiny live Pi request with `thinking off`, captures the outgoing provider payload via `before_provider_request`, and records provider `usage.input`. The printed summary contains only sizes and usage; the payload JSONL artifact can contain sensitive prompt/tool data and should stay local.

Pass extra Pi flags after `--`, for example:

```bash
node scripts/contextimate/probe-live-prefix.mjs -- --no-tools --no-skills --no-context-files
```
