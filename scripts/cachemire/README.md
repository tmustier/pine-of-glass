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

The capture contains aggregate components and exact response usage. It never contains
prompt text or provider payloads. If a provider count endpoint supplies the exact count,
append it to one unambiguous request with `record-external-token-count.mjs`. Pass the
count endpoint's model through `--counted-model`. The helper rejects a model mismatch.
Pass `--request-id` whenever the capture has more than one unresolved request.

Build the committed aggregate dataset and analysis with:

```bash
node scripts/cachemire/analyze-token-estimator-study.mjs \
  --input /tmp/token-study/capture.jsonl \
  --candidates scripts/cachemire/token-estimator-candidates.json \
  --dataset /tmp/token-study-data.json \
  --json /tmp/token-study-analysis.json \
  --markdown /tmp/token-study-summary.md
```

Keep full provider payload captures under `/tmp`. Never commit them.
