# Cachemire development probes

## Capture model-switch forecast inputs

Use `model-switch-forecast-probe.ts` to compare Cachemire's estimates with provider
usage while preserving the static prompt material missing from historical session
files.

Run it explicitly for a development session:

```bash
rm -f /tmp/cachemire-switch.jsonl
PI_CACHEMIRE_FORECAST_CAPTURE=/tmp/cachemire-switch.jsonl \
  pi -e ./scripts/cachemire/model-switch-forecast-probe.ts
```

Send at least one prompt, switch models, then send another prompt. Repeat both switch
directions under the same run when comparing model families. The probe appends JSONL,
so remove the old file first or group records by `runId`.

Records distinguish:

- canonical system, tool and history estimates at `model_select`
- recognized provider-prompt estimates at `before_provider_request`
- exact prompt usage at `message_end`
- the previous request's paired estimates and exact usage

Compaction summarizer requests are tagged and skipped because their special prompt is
not Cachemire's model-switch forecast target.

The probe is deliberately not part of Cachemire's production extension. It records
aggregate counts, heuristic labels and model identities only. It does not record prompt
text, tool names or schemas, provider payloads, session ids, or the working directory.

## Run the token estimator study tools

Read `token-estimator-study-protocol.md` before collecting data. It freezes the splits,
metrics, estimator ladder and privacy rules.

Load `token-estimator-capture.ts` explicitly and label every study process:

```bash
PI_TOKEN_ESTIMATOR_CAPTURE=/tmp/token-study/capture.jsonl \
PI_TOKEN_ESTIMATOR_RUN_ID=development-run-1 \
PI_TOKEN_ESTIMATOR_CASE=system-prose-short \
PI_TOKEN_ESTIMATOR_SPLIT=development \
PI_TOKEN_ESTIMATOR_ROUTE=direct \
PI_TOKEN_ESTIMATOR_STRATA=component:system,direction:none \
  pi --no-extensions -e ./scripts/cachemire/token-estimator-capture.ts \
  --model openai-codex/gpt-5.6-sol -p 'Reply only: hi. Do not think.'
```

The aggregate capture contains components, response usage and a SHA-256 digest of each
provider payload. It never contains prompt text or provider payloads.

When using a provider count endpoint, load the sensitive payload capture under `/tmp`
alongside the aggregate capture. Count the exact payload and save the structured result:

```bash
node scripts/contextimate/check-provider-tokens.mjs \
  --payload /tmp/token-study/request.payloads.jsonl \
  --exact --live --json > /tmp/token-study/exact-count.json

node scripts/cachemire/record-external-token-count.mjs \
  --capture /tmp/token-study/capture.jsonl \
  --result /tmp/token-study/exact-count.json \
  --request-id REQUEST_ID
```

The recorder rejects provider, API, model or payload-digest mismatches. Pass
`--request-id` whenever the aggregate capture has more than one unresolved request.

Build the aggregate dataset and analysis with:

```bash
node scripts/cachemire/analyze-token-estimator-study.mjs \
  --input /tmp/token-study/capture.jsonl \
  --candidates scripts/cachemire/token-estimator-candidates.json \
  --clusters scripts/cachemire/token-estimator-session-clusters.json \
  --dataset /tmp/token-study-data.json \
  --json /tmp/token-study-analysis.json \
  --markdown /tmp/token-study-summary.md
```

The privacy-safe committed dataset is also a deterministic analyzer input:

```bash
node scripts/cachemire/analyze-token-estimator-study.mjs \
  --input-dataset scripts/cachemire/token-estimator-study-data.json \
  --candidates scripts/cachemire/token-estimator-candidates.json \
  --clusters scripts/cachemire/token-estimator-session-clusters.json \
  --dataset /tmp/token-study-data.json \
  --json /tmp/token-study-analysis.json \
  --markdown /tmp/token-study-summary.md
```

Keep full provider payload captures and structured live results under `/tmp`. Never
commit them.
