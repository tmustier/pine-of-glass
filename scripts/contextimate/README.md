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

## Provider-exact token checks

```bash
# 1. capture what pi actually sends (see Live prefix probe above)
node scripts/contextimate/probe-live-prefix.mjs --output-dir /tmp/probe

# 2. preview the counting plan (no network)
node scripts/contextimate/check-provider-tokens.mjs --payload /tmp/probe/*.payloads.jsonl

# 3. get provider-exact counts
node scripts/contextimate/check-provider-tokens.mjs --payload /tmp/probe/*.payloads.jsonl --live
```

This builds a matrix of minimal counting requests (baseline, system-only, all-tools, and per-tool) from a captured payload, passing each section through **byte-identical** (never reshaped), so the counted payload is exactly what pi sent and exactly what contextimate estimates. Use `--tools name1,name2` to focus on specific tools (e.g. one lazy-loaded MCP server whose hot-path footprint the startup estimator cannot see), `--model` to count against a different model, and `--json` for machine output.

- **Anthropic**: uses the free `count_tokens` endpoint. Credentials: `ANTHROPIC_API_KEY`, or automatically pi's own OAuth token from `~/.pi/agent/auth.json` (used locally against the official API only, never printed).
- **OpenAI**: uses tiny real `/v1/responses` probes (`max_output_tokens: 16`, `store: false`) and reads exact `usage.input_tokens`. **Not free**: costs a fraction of a cent per probe. Requires `OPENAI_API_KEY` (pi's `openai-codex` OAuth token cannot call `api.openai.com`).
- Providers inject a fixed tool-block overhead once per request whenever any tool is present; with ≥2 per-tool counts the script solves for it and reports `net` per-tool costs so small tools are not overstated. The suggested `textDenominator`/`toolDenominator` overrides come from the net numbers and can be pasted into a `contextimate.rules` entry.
- Adding another provider is one entry in the `PROVIDERS` registry inside the script (`build` + `execute` + credential hints); no contextimate changes needed. Types in `check-provider-tokens.d.mts`.
- Request-building and the overhead math are unit-tested (`tests/contextimate/provider-check.test.ts`); tests never touch the network.
