# State machines (3 November 2026)

## Session ownership

`_lib/session-state.ts` keeps reload-safe state in a process-wide registry, keyed weakly
by `SessionManager`, not session id. Reload reuses state; other starts replace it and
other shutdowns remove it. Separate SDK runtimes cannot share a ledger or UI handles,
even when they open the same session file. Presentation handles and timers are rebound
on each start. Cachemire and Meantime retain in-flight requests across an SDK reload.

| Mode | Cachemire and Meantime | Contextimate | Traceline |
|---|---|---|---|
| TUI | Ledgers, notices and widgets | Panel and request accounting | Full |
| RPC | Ledgers and notices through `notify`; no widgets or timers | Request accounting | None |
| Headless, print, JSON | No state | Request accounting | None |

Contextimate's view preference and Cachemire's route-level thinking evidence remain
process-wide. Traceline's prototype patches retain one terminal owner; `/drill` checks
that ownership. Anchored chat lines follow the latest session host when Pi reuses its
chat container across `/new` and `/resume`.

## Provider request cycle

`_lib/request-cycle.ts` supplies one `RequestTracker<Sent>` to Cachemire, Meantime,
Contextimate and the model-switch forecast probe. Each caller owns the request data;
the tracker owns attribution:

| Event | Effect |
|---|---|
| `context` (`context_with_system` for Contextimate) | Arm the next agent request |
| `cache_warming_decision: warm` | Expect a replay of the last agent conversation |
| Payload matching an expected replay | Consume that expectation without changing the agent request |
| Other payload while armed | Start the agent request |
| Other payload while sent | Update the same request for a provider re-attempt |
| Other payload while idle | Ignore |
| Provider response | Save its first response time only if attribution is unambiguous |
| Assistant `message_end` | Settle, regardless of usage or stop reason |
| `agent_end` | Abandon unfinished work and replay expectations |

Replay matching uses wire conversations (`messages`, `input`, `contents`), not output
caps, which adapters rewrite. Expectations survive a new request because Pi does not
await an aborted refresh's payload dispatch. They expire at `agent_end`, before Pi can
retry the same conversation. A response overlapping a replay has no attributable start
time; Cachemire falls back to send time.

Cachemire stores fingerprint, retention, timing and notice in one `PendingRequest`.
A re-attempt replaces payload-derived evidence; an unbilled end restores the previous
clock and resolves the notice. Contextimate similarly replaces its captured payload.
`_lib/usage.ts` shares the billed-token check; Contextimate's trusted-context check
remains separate because it also excludes errors and aborts.

## Compaction and timing

Cachemire derives post-compaction state from the active session path relative to its
last billed baseline. Reload and resume preserve the warning; navigating before the
checkpoint clears it. Pi's summary request bypasses extension provider hooks, so there
is no compaction-in-progress flag or summarizer-call classification to get stuck after
cancellation or failure.

Meantime separates request timing from the following tools/harness phase. Responses not
ending in error or abort own their tools even without usage, but unbilled responses
create no timed call. Nested tool events are ignored because their parent interval
already covers them. The phase closes at
the next agent request, or without harness time at `agent_end`.

Run activity is running or idle. Idle starts at `agent_settled`, not `agent_end`,
because Pi can still retry, recover, compact or continue in between.

## Regression coverage

Every confirmed bug retains a regression through Pi's SDK or a domain interface:

| Bug | Test file |
|---|---|
| Child calls or shutdown corrupt Meantime's ledger/widget | `tests/meantime/sessions.test.ts` |
| Child model selection or shutdown changes Contextimate's panel | `tests/contextimate/extension.test.ts` |
| RPC startup takes Cachemire away from the terminal | `tests/contract/cachemire-lifecycle.test.ts` |
| `/drill` reaches another session's terminal | `tests/traceline/drill-owner.test.ts` |
| Rebuild restores the previous session's anchored lines | `tests/contract/pi-chatline-compat.test.ts` |
| Warm replay replaces call evidence or starts its clock early | `tests/lib/native-cache-warming.test.ts` |
| Delayed replay overwrites Contextimate's capture | `tests/lib/native-cache-warming.test.ts` |
| Strict-schema fallback leaves the rejected fingerprint | `tests/cachemire/cache-warming-events.test.ts` |
| Cancelled compaction poisons later classification; reload/resume loses compaction cause | `tests/cachemire/compaction-lifecycle.test.ts` |
| Zero-usage or nested tools inflate the next call's timing | `tests/meantime/sessions.test.ts` |

`tests/lib/request-cycle.test.ts` covers replay, re-attempt and response-attribution
rules. Native warming tests exercise Pi's warmer and Anthropic adapter with scripted
HTTP responses. `tests/contract/pi-compaction-hooks.test.ts` pins summary-hook isolation.
Existing render goldens remain unchanged.

## Still open

- Cachemire still stores model/thinking drift flags and has separate live, warm and
  restored booking paths. A baseline/selection split and shared booking reducer are
  deferred; no confirmed bug requires them.
- Provider hooks lack request ids and purpose, so attribution still infers event order.
  Payload capture also misses transforms from later extension handlers.
- SDK `dispose()` does not emit shutdown. Weak keys allow collection, but a host must
  emit shutdown to stop presentation timers reliably.
- Pi accepts an `aborted` compaction summary when its request signal was not aborted.
  These Pi API gaps are listed in [upstream candidates](./upstream-candidates.md#5-provider-request-attribution).
- Whether an aborted response has refreshed a provider's cache remains unverified.
  Cachemire conservatively restores the previous clock.
