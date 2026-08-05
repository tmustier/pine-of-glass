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

- canonical system, tool and history estimates at model selection and request time
- exact prompt usage at `message_end`
- the previous request's paired estimate and exact usage

Compaction summarizer requests are tagged and skipped because their special prompt is
not Cachemire's model-switch forecast target.

The probe is deliberately not part of the production extension. It records aggregate
counts, heuristic labels and model identities only. It does not record prompt
text, tool names or schemas, provider payloads, session ids, or the working directory.
