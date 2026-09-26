# Anthropic cache TTL boundary audit, 26 September 2026

Cachemire's debug markers showed 2 false `5m TTL reached` warnings in one day. Both
follow-up calls read the full prefix. The idle gaps were 301.7s and 302.7s, measured from
the previous request's send. This audit measures when direct Anthropic 5-minute and
1-hour cache entries actually stop serving reads, and from which moment that time runs.

## Verdict

Direct Anthropic serves reads for 10s past the documented TTL: 310s for a 5-minute
entry and 3,610s for a 1-hour entry. The time runs from the response start of the call
that last read or wrote the entry. The response start is when the HTTP
response headers arrive. Anthropic sends them only after prefill, which is when the
cache is read and written.

| model | TTL | probes | last hit | first miss |
|---|---|---|---|---|
| `claude-haiku-4-5` | 5 minutes | 60 | 309.88s | 310.20s |
| `claude-opus-5-5` | 5 minutes | 8 | 309.16s | 310.29s |
| `claude-haiku-4-5` | 1 hour | 12 | 3,610.05s | 3,611.34s |

Times are from the write call's response start to the read call's send. Cachemire
therefore adds a 10s grace to both direct Anthropic contracts, and it anchors every live
billed call's cache clock at the response start rather than the send.

## Method

Each probe sent a unique prompt of about 8k to 14k tokens through Pi's `ModelRuntime`
with Anthropic subscription auth. It recorded the send time, the response start and the
response end. It then re-sent the identical prompt after a fixed delay and recorded
`cacheRead`. Probes ran concurrently with distinct nonces, so no probe could warm
another.

- 24 Haiku probes between 296s and 310s after the send all hit. A reboot removed
  their raw records after their outcomes were logged.
- 24 Haiku probes between 312s and 600s after the send all missed.
- 12 Haiku probes between 309s and 312s after the send split at 310s after the
  response start. At 311s after the send, one probe hit and one missed. Their response
  starts came 1.36s and 0.81s after the send, which put them 309.64s and 310.20s after
  the response start.
- 8 Opus probes between 300s and 320s after the send split the same way. Four
  further Opus probes returned a provider refusal and are excluded.
- 12 Haiku probes with `cache_control.ttl: "1h"` read back between 3,590s and 3,720s
  after the send. Every probe up to 3,610.05s after the response start hit; every probe
  from 3,611.34s missed. Each delay ran once, so this boundary is less precise than the
  5-minute one.

## The TTL does not run from the response end

4 Haiku probes streamed a long answer for 71s to 76s. Their read calls came 312s to
325s after the send, but only 236s to 252s after the response end. All 4 missed. The
cache is refreshed at prefill, so a long generation does not extend the entry.

The same probe harness timed the HTTP response against the first streamed event. For
a cold 142k-token prompt, the headers arrived 2.73s after the send, in the same
millisecond as the first content event. A warm send of the same prompt returned them
after 1.33s. The header time therefore marks the end of prefill.

Pi reports that moment to extensions as `after_provider_response`.
`tests/contract/pi-provider-response-seam.test.ts` pins the ordering Cachemire relies
on: Pi's Anthropic provider calls `onResponse` after the headers and before it reads
the stream body, and Pi forwards that call to extensions before the assistant message.

## Cachemire policy

- Direct Anthropic contracts, observed or inferred, carry a 10s grace for both the
  5-minute and 1-hour TTL. Expiry, the countdown and TTL causes use `ttlMs + graceMs`.
  The labels stay `5m TTL` and `1h TTL`.
- Live billed calls anchor the cache clock at the response start. Pi does not persist
  that moment, so restored calls keep their request time. For a restored call the
  clock can run early by the call's prefill time.
- Other routes keep their documented windows without grace. MiniMax and Bedrock
  5-minute entries were not measured.

## Limits

These are live observations of one provider route from one location on one day. They
are not a documented contract. Anthropic can change the grace without notice. Re-run the
probe before relying on a boundary tighter than a few seconds.
