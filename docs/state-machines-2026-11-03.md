# State machine redesign (3 November 2026)

This document designs fixes for the implicit state machines in the four extensions. An implicit
state machine here means state that moves between named situations (for example "a provider
request is in flight") but is stored as loose booleans and optional fields, with the transitions
spread across event handlers. The audit that found them is summarised in the first section. The
rest of the document says what to change, in what order, and how each change is tested.

Status: design only. Nothing here is implemented. Three investigations against Pi 1.3.0 and
`main` at `3e13d7c` checked the suspected bugs before this design was finished, and their findings
are folded in. The last section lists them, with the Amp threads that hold their full reports and
reproduction tests.

## Triage

Most of the implicit state machines are fine and should stay as they are. A machine needs work
when it has a real or likely bug, or when the same machine is written more than once and the
copies have already drifted apart.

| Machine | Where | Decision |
|---|---|---|
| Process ownership of global state | cachemire, traceline (guarded); meantime, contextimate (not guarded) | Fix: one shared owner, used by all four |
| Provider request lifecycle (armed, sent, settled, aborted) | cachemire, meantime, contextimate, forecast probe | Fix: one shared request cycle that recognises cache-warm replays and fallback re-attempts |
| Cachemire pending request (nine `pending*` fields) | `pi-cachemire/index.ts` | Fix: one `PendingRequest` value |
| Cachemire drift flags (`modelSwitched`, `thinkingChanged`, `compacted`) | `pi-cachemire/index.ts`, `warm.ts` | Fix: derive them instead of storing them |
| Cachemire compaction (`inCompaction`, `compacted`) | `pi-cachemire/index.ts` | Fix: delete `inCompaction`, derive `compacted` |
| Booking a billed call (live, warm, restored) | `index.ts` `message_end`, `warm.ts`, `ledger.ts` | Fix: one reducer |
| Meantime call phase and run activity | `pi-meantime/index.ts` | Make explicit with tagged unions, and fix tool-time ownership |
| Session lifetimes on `session_start` | all four | Make explicit: process, session and UI lifetimes |
| "Was this call billed?" test | five copies | Fix: one helper |
| Drill mode, pager, digit buffer | `pi-traceline/drill*.ts` | Leave |
| Row view state (z0, z1, revealed folds, ledger overrides) | `pi-traceline/click.ts` | Leave (specified in design language §9.12.1) |
| Summaries batcher and per-gist state | `pi-traceline/summaries.ts` | Leave |
| Cache clock phases | `pi-cachemire/clock.ts` | Leave (already explicit and pure) |
| Contextimate view mode, snapshot cache, panel install | `pi-contextimate/index.ts` | Leave |
| Lexers and scanners | `record-shell.ts`, `sgr.ts`, `thinking-preview.ts`, `_lib/forecast.ts` | Leave |
| Render cache, topology, write snapshots, nested captures, anchored lines | traceline, `_lib/chatline.ts` | Leave |

The section "Machines left as they are" gives the reason for each "Leave" row.

## Design rules used throughout

The same five rules shape every change below.

1. Each piece of state has one owner and one place that changes it. Event handlers translate Pi
   events into calls on that owner; they do not assign fields directly.
2. A machine with more than two states is a tagged union with a `kind` field, so an impossible
   combination of flags cannot be written down.
3. A value that can be computed from other state is computed, not stored. Stored copies of
   derived values are the main source of drift in the current code (for example `modelSwitched`
   is assigned in four handlers).
4. When the same machine runs in several extensions, the machine lives in `_lib` and each
   extension supplies only the data it attaches to each state.
5. Every fix lands with a test that fails on the current `main`, written against Pi's SDK through
   `tests/harness/extension-host.ts` as `docs/testing.md` requires.

## Shared pieces in `_lib`

### Process ownership (`_lib/session-owner.ts`)

Pi can run more than one agent session in the same Node process. An extension that calls
`createAgentSession` gets an in-process session with its own extension runner, and Pi invokes each
extension's factory again for it, so closures are per session but `globalThis` is shared.
Subagents that Pi spawns as separate processes (the example subagent extension, `RpcClient`) do
not share globals. All four extensions keep state on `globalThis`, so an in-process child
session's events reach the same state as the interactive session unless something stops them.
Cachemire and Traceline each wrote their own guard; Meantime and Contextimate have none.

The investigation (thread `T-01a1a11e-2170-70c4-a9f8-333edba5f95b`) confirmed the Meantime bug
with an SDK-hosted test that fails on `main`. A headless child in the same process does the
following to the interactive session's Meantime state:

- Its request closes the parent's open tool phase early (a six-second tool was recorded as three
  seconds) and replaces the parent's live call.
- Its `message_end` resolves the parent's live call with the child's usage, and its `agent_end`
  drops the parent's live call, so the parent's real usage is lost from `/pace`.
- Its completed calls join the parent's ledger and slow-start baselines.
- Its `session_shutdown` clears the shared timer and widget, which freezes the parent's clock.
  A child `session_start` with a reason other than `startup` or `reload` also wipes the
  parent's history and UI handles. A default SDK child starts with `startup`, so this needs an
  explicit `new`, `resume` or `fork`.
- Its factory call overwrites the shared config before any check.

Contextimate's request accounting is per session and was correct in an interleaved test. Its UI
globals are not: a child's `setModel` changed the model the parent's panel used, and a child's
`session_shutdown` cancelled the parent's pending panel install.

The investigation also found a gap in Cachemire's guard. It qualifies any session with `hasUI`,
and Pi's RPC mode binds a UI (`mode: "rpc"`), so an RPC-like session that starts first claims
the ledger and a later TUI session gets nothing. Traceline already requires `mode === "tui"`.
Traceline's `/drill` command checks `hasUI` but not ownership.

The design moves Traceline's `tui-owner.ts` into `_lib` and generalises it:

```ts
export interface SessionOwner {
  /** True while this extension instance owns the process-wide slot. */
  owns(): boolean;
  /** Claim on session_start; false when another instance owns the slot or ctx does not qualify. */
  claim(ctx: { hasUI: boolean; mode?: string }): boolean;
  /** Release on session_shutdown; false when this instance did not own it. */
  release(): boolean;
}

export function sessionOwner(slot: string, qualifies: (ctx: { hasUI: boolean; mode?: string }) => boolean): SessionOwner;
```

Each extension creates one owner in its default export, with its own slot name and rule:

| Extension | Slot | Qualifies when |
|---|---|---|
| Traceline | `__tracelineTuiOwner` | `mode === "tui" && hasUI` (unchanged) |
| Cachemire | `__piCachemireOwner` | `mode === "tui" && hasUI` (changed from `hasUI`) |
| Meantime | `__piMeantimeOwner` | `mode === "tui" && hasUI` |
| Contextimate | `__piContextimateOwner` | `mode === "tui" && hasUI` |

All four use the same rule, because all four render into Pi's terminal UI: the chat container,
widgets and the resource list. Decision needed: requiring the TUI means Cachemire and Meantime
stop working in RPC mode, where today they fall back to `notify`. The recommendation is to accept
that, because the alternative (letting a TUI session take ownership from an RPC session) adds a
hand-over protocol for a case with no known user.

The guard rules are:

1. Every event handler, command handler and timer callback that touches global state starts with
   `if (!owner.owns()) return;`. Only `session_start` calls `claim`, and only `session_shutdown`
   calls `release`.
2. Nothing touches global state before the claim. Meantime keeps reading its config in the
   factory body, because `enabled: false` must still stop it from registering `/pace`, but it
   moves `s.config = config` into `session_start`, after the claim.
3. Closure state that Pi creates per factory call, such as Contextimate's `request` in
   `request-messages.ts`, stays unguarded, because it already belongs to one session and its
   accounting entries are useful in headless sessions too.

One limit remains. Pi's SDK `AgentSession.dispose()` does not emit `session_shutdown`, so an
owner disposed that way never releases its slot. That only matters if a TUI session is disposed
without shutdown, which Pi's interactive mode does not do, so the design accepts it.

Tests (each must fail on `main`):

- Meantime: the investigation's test. A headless session and an interactive session share one
  process; a billed call in the headless session must not appear in the interactive `/pace`
  ledger. A second case drives the child's `session_shutdown` and checks that the parent's widget
  still updates.
- Contextimate: a `setModel` in the headless session does not change the model the interactive
  panel shows, and a headless `session_shutdown` does not cancel the panel install.
- Cachemire: an RPC-mode session that starts first does not stop a later TUI session from showing
  the ledger.

### Provider request cycle (`_lib/request-cycle.ts`)

Cachemire, Meantime and Contextimate each track the same sequence of Pi events for one provider
request. Each copy stores it differently, and all three share one confirmed bug. The shared cycle
holds the sequence once and lets each extension attach its own data to the sent request.

#### What the investigation found

The investigation (thread `T-01a1a11e-4436-7695-90cf-37eac6006197`) checked the request
lifecycle against Pi 1.3.0. Most suspected problems were refuted:

- Pi's automatic retry is safe. The failed attempt ends with an error `message_end` and
  `agent_end`, and the retry starts with a fresh `context` event, so it is armed normally.
- Built-in compaction summaries, branch summaries and Traceline's summary requests do not reach
  the provider hooks, so no extension books them as agent-loop calls.
- Tree navigation, `/fork` and `/resume` wait for or abort the active request before they replace
  the session, so a request cannot settle into the wrong session.
- Steering and follow-up messages do not produce a `context` before the previous call's
  `message_end`.

The confirmed problems are these:

1. Pi's cache warmer replays the last agent request with `maxTokens: 1`, and it reuses the
   request's options, so the replay emits `before_provider_request` and `after_provider_response`
   to extensions. If a replay is sent while an agent request is armed, the replay consumes the
   arm and the real request is ignored. Cachemire then fingerprints the wrong payload (a reproduced
   case reported an "unknown" miss instead of "system prompt changed"), and Meantime charges the
   time spent in `context` handlers to the model. Contextimate's capture is overwritten by a
   delayed replay, which persisted 5 request-only characters instead of 26 in the reproduction.
2. Anthropic's strict-schema fallback sends a second payload for the same call without a new
   `context`. Cachemire keeps the first, rejected payload's fingerprint and misses a tool change
   in the payload that was actually used.
3. Meantime gives a round's tools to the next call when the round's `message_end` reports zero
   usage, because only a billed call opens the tool phase.

Pi's provider hook events carry only the payload, so nothing in the event says whether a request
is an agent-loop request, a cache-warm replay or a fallback re-attempt. The tracker has to work
that out from event order, and it should be the only code that does.

#### The tracker

```ts
export type RequestCycle<Sent> =
  | { kind: "idle" }
  | { kind: "armed" }                                  // context seen, no agent payload yet
  | { kind: "sent"; sent: Sent; respondedAt?: number; responseAmbiguous: boolean };

/** What one before_provider_request turned out to be. */
export type PayloadKind = "agent" | "reattempt" | "replay" | "foreign";

export interface RequestTracker<Sent> {
  readonly state: RequestCycle<Sent>;
  /** context (Contextimate: context_with_system). */
  arm(): void;
  /** cache_warming_decision with action "warm": the next matching payload is a replay. */
  expectReplay(): void;
  /** before_provider_request. Calls `start` for an agent payload and `retry` for a re-attempt. */
  payload(payload: unknown, now: number, start: () => Sent, retry: (sent: Sent) => void): PayloadKind;
  /** after_provider_response. */
  responded(now: number): void;
  /** Assistant message_end, whatever its usage or stop reason. */
  settle(): Sent | undefined;
  /** agent_end, session_start, session_tree. */
  abandon(): Sent | undefined;
}
```

The rules, in the order `payload` applies them:

1. A payload is a replay when a `cache_warming_decision` with action `warm` came first and the
   payload's conversation messages equal those of the last agent payload. A replay changes
   nothing except the response bookkeeping in rule 5. Both conditions are needed. The decision
   event is Pi's own signal that a warm is coming, but a later extension can override it to
   `stop`, so the message comparison confirms it. The comparison alone cannot tell a replay from
   an ordinary retry, which resends the same messages. A decision that no matching payload
   follows is cleared by the next agent payload.
2. A payload in the `armed` state is an agent payload. `start` creates the extension's data.
3. A payload in the `sent` state is a re-attempt of the same call (the strict-schema fallback).
   `retry` lets the extension replace what it derived from the payload, such as Cachemire's
   fingerprint, and the send time stays the same.
4. A payload in the `idle` state is foreign, for example from an extension that drives its own
   agent, and is ignored, as today.
5. A response that arrives while a replay is waiting for its own response cannot be attributed,
   so it marks the agent request's `responseAmbiguous` and leaves `respondedAt` unset. Cachemire
   then anchors the clock at the send time, which is what it already does for restored calls.
   Settling the agent request resets the replay count, so a replay that never got a response
   cannot make later requests ambiguous.
6. `settle` ends the request on any assistant `message_end`. Each extension then decides what to
   book from the message itself: Cachemire books only billed usage, and Meantime starts the tool
   phase for any response that did not end in `error` or `aborted`. This replaces the current rule
   in which a zero-usage `message_end` leaves the request open until `agent_end`.

Each extension keeps one tracker instead of its own flags:

| Extension | `Sent` data | Arms on |
|---|---|---|
| Cachemire | `PendingRequest` (below) | `context` |
| Meantime | `LiveCall` (already in `timing.ts`) | `context` |
| Contextimate | `{ saved, payload, counts, nonTextChars, hasImages }` | `context_with_system` |

The message comparison needs one small payload reader in `_lib`, which returns the wire
conversation (`messages` for Anthropic and OpenAI chat, `input` for OpenAI Responses) as a
stable string. Cachemire's `fingerprintPayload` already parses the same fields and should use it.

Two contract tests pin the Pi behaviour that the rules depend on:

- With cache warming on, a warm refresh emits `cache_warming_decision` and then a
  `before_provider_request` whose conversation messages equal the last agent request's.
- The Anthropic strict-schema fallback emits two `before_provider_request` events for one
  `context` and one `message_end`.

The regression tests are the investigation's warming test (warming off passes and warming on
fails on `main`, for both Cachemire's cause and Meantime's model time), its Contextimate
delayed-replay test, and its strict-fallback test.

The tracker is still an inference from event order. The clean fix is in Pi: if
`before_provider_request` and `after_provider_response` carried the request's purpose (`agent`,
`cache_warm`) and an id shared with the resulting message, rules 1, 3 and 5 would become a
lookup. That request goes in `docs/upstream-candidates.md`, and the tracker shrinks to the lookup
when a supported Pi provides it.

One finding is left as it is. After an aborted request whose response had started, Cachemire
rolls the clock back to the previous refresh, although the provider may already have written the
cache. The investigation could not verify what providers do in that case without a live call. The
current rule is the cautious one and stays until a live probe shows otherwise.

### Billed usage (`_lib/usage.ts`)

Five places test `usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 &&
usage.cacheWrite === 0`. Contextimate's `hasTrustedUsage` and Traceline's summary accounting use
different tests, and they answer a different question, so they stay separate but get a name that
says so.

```ts
/** The provider reported tokens for this response (it may still have been aborted). */
export function hasBilledUsage(usage: UsageLike): boolean;
```

Cachemire's four readers (`index.ts`, `warm.ts`, `ledger.ts`, `lineage-persistence.ts`) and
Meantime use `hasBilledUsage`. Contextimate keeps
`hasTrustedUsage`, because Pi's context total also excludes aborted and errored responses.

### Lifetimes on `session_start`

Each extension resets a different subset of its global state on `session_start`, and the subsets
are written as long field lists (Meantime's reset assigns 18 fields). The design splits each
extension's global state into three parts, so the reset rule becomes one line per part:

```ts
interface ExtensionGlobals<Process, Session, Ui> {
  /** Survives reload and session changes: config caches, Cachemire's thinking evidence. */
  process: Process;
  /** Replaced on every session_start except reload. */
  session: Session;
  /** Rebound on every session_start: ui, theme, tui, widget, chat container. */
  ui?: Ui;
}
```

The request tracker is not part of any of the three. It is abandoned on every `session_start`,
including reload, because a request cannot settle into a reloaded module's handlers.

This is a convention, not a framework. Each extension declares its three types and writes a
`newSession()` constructor; `_lib` adds nothing beyond the owner.

## Cachemire

Cachemire's `CachemireState` has about 40 fields, counting the `WarmSyncState` it extends. They
fall into five groups that change for different reasons, and the redesign gives each group its
own type and its own update path:

1. The baseline: what the provider cache is believed to hold for the active path.
2. The selection: the model and thinking level Pi will use for the next request.
3. The drift between the two: model switch, thinking change and compaction. All three are
   derived.
4. The pending request, held by the shared request tracker.
5. The ledger: booked `CallRecord`s and the per-run aggregate.

`index.ts` is over its line budget (655 lines in the lint baseline). The new types and reducers go
in a new `state.ts`, and `index.ts` keeps only event wiring.

### Baseline

```ts
/** What the provider cache holds for the active path, as of the last billed call. */
export interface CacheBaseline {
  /** Prompt size of the last billed call: the next call's expected cache read. */
  expectedRead: number;
  /** When a compatible request last refreshed the cache entry: the clock anchor. */
  refreshedAt?: number;
  window: CacheWindow;
  /** Route and thinking level that billed the last call. */
  billedBy?: { provider?: string; model?: string; api?: string; thinkingLevel?: string };
  /** Refresh time of the previously booked call: the ledger's gap anchor. */
  previousCallAt?: number;
}
```

`refreshedAt` and `previousCallAt` replace `lastRefreshedAt` and `prevCallRefreshedAt`. The names
say what each one anchors, because today the two are easy to confuse and they differ after a
branch switch (the clock follows lineage, the ledger follows the timeline).

The baseline changes in exactly two ways:

- `projectBaseline(lineages, entries, leafId, selection)` recomputes it from lineage snapshots.
  It wraps today's `resolveCacheLineage` and `cacheStateForLineage`, and runs on `session_start`,
  `session_tree` and `before_provider_request`, as now.
- `bookCall` (below) advances it after a billed call.

Nothing else assigns to it. In particular, `before_provider_request` no longer sets
`lastRefreshedAt = requestAt` and `window = unknown`, and `agent_end` no longer restores them. The
clock reads the in-flight state from the tracker instead:

```ts
function clockInput(baseline: CacheBaseline, cycle: RequestCycle<PendingRequest>, drift: CacheDrift, now: number): ClockInput {
  const anchor = cycle.kind === "sent"
    ? { lastRefreshedAt: cycle.sent.requestAt, window: UNKNOWN_WINDOW }
    : { lastRefreshedAt: baseline.refreshedAt, window: baseline.window };
  return { now, ...anchor, cachedTokens: baseline.expectedRead, ...drift };
}
```

The clock shows the same text as today in every state, so the goldens do not change. The
rollback block in `agent_end` is deleted.

### Selection and drift

```ts
export interface Selection {
  route?: ThinkingRoute;              // provider, model, api, appendOnlyEffort
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
  thinkingLevel?: string;
}

export interface CacheDrift {
  /** The selected route differs from the route that billed the baseline. */
  modelSwitched: boolean;
  /** The selected effort would break the cached prefix on this route. */
  thinkingChanged: boolean;
  /** A compaction checkpoint sits after the baseline call on the active path. */
  compacted: boolean;
}

export function cacheDrift(
  baseline: CacheBaseline, selection: Selection, evidence: ThinkingEvidenceLedger,
  path: { entries: readonly SessionEntry[]; leafId: string | null; baselineSnapshot?: CacheLineageSnapshot },
): CacheDrift;
```

The selection is updated by `session_start`, `model_select`, `thinking_level_select` and
`session_tree`. The drift is recomputed after any change to the baseline or the selection, and
stored only as a cache next to them. Today's rules carry over unchanged:

- `modelSwitched` is today's comparison in `model_select` (id, then provider and api when known).
- `thinkingChanged` is today's `markThinkingChange`: a warm prefix exists, the model reasons, and
  `thinkingChangeInvalidatesCache` says the change breaks it.
- `compacted` uses the existing `pathContainsCompaction` from `lineage.ts`.

Deriving `compacted` from the session path also fixes a confirmed bug (thread
`T-01a1a11e-305f-730d-8545-0cefd0defa3f`). Today `session_start` always sets `compacted = false`,
so after `/reload`, `/resume` or a restart that follows a compaction, the widget stops saying
"cache stale after compaction" before the next call. After `/resume` or a restart, the next
call's miss is also labelled "unknown" instead of "compaction". The lineage path cannot recover
the cause, because `resolveCacheLineage` only checks `pathContainsCompaction` when a fingerprint
comparison says `history`, and restored snapshots have no fingerprint. The stored flag is also
wrong in the other direction: it survives tree navigation, so navigating to a point before the
compaction keeps the warning on a path that was never compacted. A derived `compacted` is
correct in all of these cases, because it reads the active path every time. It is passed to
`classifyCall` and `predictBreak` directly, so the compaction cause no longer depends on
fingerprints.

`switchForecast` stays a stored cache, because computing it walks the whole session. It is
recomputed in the same place as the drift, only when `modelSwitched` is true.

### Compaction in progress

Today `session_before_compact` sets `inCompaction` and only `session_compact` (success) or
`session_start` clears it. The investigation confirmed that a compaction can start and not
succeed. When the user presses Escape, when an extension handler returns `{ cancel: true }` after
Cachemire's handler, or when the summary request fails, Pi emits `session_compact_failed` instead
of `session_compact`. The flag then stays set, and `classifyCall` labels every later billed call,
including real cache hits, as a "compaction summarizer call" miss. Break warnings stop, thinking
evidence stops being recorded, and warm entries get the same false label. The widget does not
show it, so the user sees a quiet widget and a wrong ledger.

The investigation also showed that the flag has no job to do. Pi's built-in compaction summary
calls the model's stream function directly. It does not emit `context`, `before_provider_request`,
`after_provider_response` or `message_end`, so Cachemire never sees the summary request, and no
agent-loop request runs while a compaction is in progress. The only reachable effect of
`inCompaction` is the bug.

The design deletes the machine instead of repairing it:

1. Remove `inCompaction` from the state, from `ClassifyInput`, from `predictBreak`, from
   `BilledThinkingChange.incomparable` and from `WarmSyncState`.
2. Remove the `compaction-work` cause kind, its branch in `classifyCall`, its exception in the
   `broke` test in `message_end`, and the `forensics.test.ts` case that pins it.
3. Remove the `session_before_compact` handler. `session_compact` no longer sets anything either,
   because `compacted` is derived; it only triggers a drift recompute and a widget update.
4. Add a contract test that pins the assumption the deletion relies on. A real
   `session.compact()` with a scripted model must not emit `context`, `before_provider_request`
   or `message_end` to extensions. If a later Pi routes the summary through those hooks, the
   contract test fails and says so, which is the repo's normal way to catch Pi drift.

The repo supports Pi 0.86.0 and later, and the investigation only read Pi 1.3.0. If an older
supported Pi did route the summary through the hooks, the summary call would be booked as an
ordinary call with an "unknown" or "history" cause. That is a wrong label on one row, which is
smaller than the current bug. `session_compact_failed` exists in every supported version (added
in Pi 0.84.3), so if review prefers to keep the guard, the fallback is to clear the flag on that
event too. The deletion is still the recommendation.

The same flag exists in the dev probe `scripts/cachemire/model-switch-forecast-probe.ts`, which
also never resets it on `session_start`. The probe gets the same deletion.

The investigation found one Pi edge case outside this design. A provider that returns
`stopReason: "aborted"` without aborting the request signal is accepted as a successful
compaction, because Pi's summary validation rejects only `error` and `length`. That is a Pi
issue, not a Cachemire one; it is listed here so it is not lost.

### Pending request

```ts
/** One agent-loop provider request, from send to settle. */
export interface PendingRequest {
  requestAt: number;
  requestLeafId: string | null;
  fingerprint: RequestFingerprint;
  /** First divergence from the baseline request, named at send time. */
  fingerprintCause?: CallCause;
  retention?: RetentionMatch;
  /** Time since the baseline's refresh, measured at send. */
  cacheGapMs?: number;
  /** The break notice placed at send, resolved in place when usage arrives. */
  notice?: ThemedText;
}
```

The tracker's `respondedAt` replaces `pendingResponseAt`. `pendingPreviousRefreshedAt` and
`pendingPreviousWindow` disappear, because the baseline is no longer changed at send time.
`pendingNotice` moves into the request, so a notice cannot outlive its request. When `settle`
returns a request whose message has no billed usage, or `abandon` returns one, Cachemire resolves
`request.notice` with the "send ended without usage" line. Under the new settle rule that happens
at the zero-usage `message_end` instead of at `agent_end`, so the line appears slightly earlier
and says the same thing.

The strict-schema fallback reaches Cachemire through the tracker's `retry` callback, which
recomputes `fingerprint` and `fingerprintCause` from the payload that Pi actually used and keeps
`requestAt`, `cacheGapMs` and `notice`. The notice text is not recomputed, because the prediction
was already shown; the resolved line uses the corrected cause.

### One reducer for booking a billed call

Today three functions book a billed call into the ledger and advance the baseline: the live path
in `message_end`, `syncWarmEntries` in `warm.ts`, and `restoreBranchRecords` in `ledger.ts`. They
apply the same idea with different details, and they have already drifted (for example the
warm path ignores the wire API when it decides whether the model switched, while the live and
restored paths compare it). The design keeps
one pure reducer and three thin callers:

```ts
export type CallObservation = {
  source: "live" | "warm" | "restored";
  at: number;
  requestAt: number;
  /** When the provider began responding, or requestAt when unknown. */
  refreshedAt: number;
  usage: UsageLike;
  billedBy: { provider?: string; model?: string; api?: string; thinkingLevel?: string };
  window: CacheWindow;
  promptTokens: number;
  /** Live calls only. */
  fingerprintCause?: CallCause;
  cacheGapMs?: number;
  thinkingChange?: ThinkingEvidence;
};

export function bookCall(
  ledger: { records: readonly CallRecord[]; baseline: CacheBaseline; drift: CacheDrift },
  call: CallObservation,
  rates?: ModelRates,
): { record: CallRecord; baseline: CacheBaseline };
```

The source-specific rules stay, but they sit in one function where they can be compared:

- `restored` replaces causes other than `model` and `compaction` with "restored session (cause
  unknown)", as `restoreBranchRecords` does now.
- `warm` sets `warm: true` and `uncachedUsd = cost.total`.
- `live` alone carries `fingerprintCause`, `cacheGapMs` and the thinking verdict.

`restoreBranchRecords` becomes a fold of `bookCall` over the branch, starting from an empty
baseline. `syncWarmEntries` becomes a fold over the unseen warm entries. The thinking-evidence
side effect (`recordBilledThinking`) stays in the live caller, because it changes the process-wide
evidence ledger, and the reducer stays pure.

### Tests for the Cachemire redesign

The baseline, drift and booking changes are a refactor. The existing event tests and the
`cachemire-lines.txt` golden must pass unchanged, and that is the main evidence. The
investigation left three SDK-hosted tests that fail on `main`; they become the regression tests
for the behaviour that changes:

- A cancelled compaction (an extension returns `{ cancel: true }` after Cachemire's handler) is
  followed by two ordinary calls, and `/cache` does not show "compaction summarizer call".
- After a successful compaction and `session.reload()`, the widget still shows "cache stale
  after compaction".
- A compacted session reopened in a new host labels the next call's miss with the compaction
  cause.

Two more tests are new:

- Navigating with `/tree` to an entry before the compaction removes the "cache stale after
  compaction" warning.
- A warm entry, a live call and a restored call with the same usage book records with the same
  classification kind and the same next baseline; the restored record differs only in its cause
  label. This guards the reducer against the copies drifting apart again.

## Meantime

Meantime's live state mixes two machines in one flat object: the phase of the current call and
whether the agent is running. The design makes both explicit and moves the request part to the
shared tracker.

### Call phase

```ts
type CallPhase =
  /** No call this run yet, or the last phase was closed by agent_end. */
  | { kind: "between" }
  /** A sent request: the tracker's Sent payload. */
  | { kind: "live"; call: LiveCall }
  /** After a response: its tools run, then pi and extensions prepare the next request.
   * callIndex is absent when the response reported no usage, so there is no call to attach to. */
  | { kind: "after"; callIndex?: number; startedAt: number; tools: ToolClock };

interface ToolClock {
  open: Map<string, number>;   // toolCallId to start time
  done: Interval[];
}
```

The transitions, written as one table:

| From | Event | To | Effect |
|---|---|---|---|
| `between` or `after` | agent payload (tracker) | `live` | close `after` with harness time |
| `live` | `message_end`, billed | `after` with `callIndex` | resolve the call, run anomaly notices |
| `live` | `message_end`, not billed, not `error` or `aborted` | `after` without `callIndex` | none |
| `live` | `message_end` with `error` or `aborted` | `between` | drop the live call |
| `after` | top-level `tool_execution_start` / `_end` | `after` | update `tools` |
| any | `agent_end` | `between` | close `after` without harness time; drop `live` |

Three changes alter behaviour, and each fixes a confirmed problem:

1. A response without usage now opens its own `after` phase, so its tools are no longer counted
   in the next billed call. The investigation reproduced a 1-second tool joining the next round's
   2-second tool, which `/pace` showed as 3 seconds.
2. A warm replay no longer starts a live call, because the tracker classifies it. That removes
   the reproduced case where 10 seconds of `context` handler time was counted as model time.
3. Tool events with a `parentToolCallId` are ignored. A nested call runs inside its parent tool,
   so the parent's interval already covers it. When a codemode script is cancelled, its nested
   calls can finish after the parent and after the next request starts; that cleanup does not
   hold up the agent loop, so it is not tool time. Today Meantime counts nested calls as tools,
   and a late one is clipped (the investigation saw a 5-second nested call recorded as 1 second).

A top-level tool event outside an `after` phase is ignored. The investigation found that Pi awaits
top-level tools before the next request, so the case does not occur.

### Run activity

```ts
type Activity =
  | { kind: "running" }
  | { kind: "settling" }               // agent_end seen, agent_settled not yet
  | { kind: "idle"; since: number };
```

`runActive` and `idleSince` become this one value, and `idleMs` stays as the accumulator. The
`settling` state keeps today's accounting, in which the time between `agent_end` and
`agent_settled` counts as active, but now names it, so a later change to that rule is a one-line
decision.

### Tests for Meantime

The existing `timing.test.ts`, render tests and `meantime-lines.txt` golden must pass unchanged.
The new tests each fail on `main`:

- The ownership test from the shared owner section.
- The warming test from the request-cycle section, which checks that `/pace` does not charge
  `context` handler time to the model.
- A round whose response reports no usage runs a 1-second tool, and the next billed round runs a
  2-second tool. `/pace` shows 2 seconds of tool time for the billed call.

## Contextimate

Contextimate needs only the shared owner (for `model_select`, `session_shutdown` and its other
global writes) and the shared request tracker in `request-messages.ts`, which stops a delayed
warm replay from overwriting the captured payload. Its other machines, the view mode, the
snapshot cache and the panel install retry, are already explicit and stay as they are.

The investigation found one more limit that this design does not fix. Contextimate copies the
payload inside its own `before_provider_request` handler, so a handler that runs later can still
change the payload, and the copy then differs from what Pi sent. Cachemire has the same limit and
already documents it in `thinking.ts`. Pi has no hook that sees the final payload, so the fix is
an upstream request (below).

## Machines left as they are

These machines are small, local, already explicit, or specified on purpose. Changing them would
add code without fixing anything.

- The drill mode, pager and digit buffer in Traceline. The mode is one `DrillState` object whose
  presence means the mode is on, teardown is safe to repeat, and `stepDigits` is already a pure
  function. The smoke test `traceline-drill-smoke.mjs` covers the keyboard paths.
- Traceline's row view state. The four sources (Pi's `expanded`, revealed folds, ledger
  overrides, and reasoning visibility) are specified in design language §9.12.1, including that
  Ctrl+T leaves revealed groups and ledgers as they are.
- The summaries batcher. After #191 it uses an in-flight counter. A gist stored as `undefined`
  means "asked or failed, do not ask again", which matches the documented intent.
- The cache clock. `cacheClock` returns an explicit `phase`, and `nextClockUpdateMs` is its
  transition schedule. Both are pure and covered by the golden.
- Lexers and scanners (`readShell`, `dimUnstyledSpans`, thinking-run grouping, `inImageRun`). Their
  state is local to one pure function and covered by the bash corpus and unit tests.
- The render cache, topology index, write snapshots, nested-call captures, anchored chat lines and
  `LiveWidget`. Each is a small class or keyed cache with one owner and a clear reset point.
- The forecast probe in `scripts/cachemire/`. It is a manual dev tool. It should adopt the shared
  request tracker once the tracker exists, so its findings use the same arming rule as Cachemire.

## Order of work

Each step is one pull request that can ship on its own.

1. Shared owner, with guards in all four extensions and the two-session tests. This fixes the
   confirmed Meantime and Contextimate bugs and the Cachemire RPC gap.
2. Compaction fix in Cachemire, as a small change to the current code before the refactor.
   Delete `inCompaction` and `compaction-work`, add the compaction contract test, and set
   `compacted` from `pathContainsCompaction` on `session_start` and `session_tree` instead of
   resetting it. The three investigation tests must fail before the change and pass after it.
3. `_lib/usage.ts` and the lifetime split. These are small refactors that the next two steps
   build on.
4. Cachemire state redesign: `state.ts`, baseline, selection, derived drift, `PendingRequest` and
   `bookCall`. The existing tests and golden must pass unchanged, and `index.ts` must drop below
   its line budget so the baseline entry shrinks.
5. Shared request tracker, adopted by Cachemire, Meantime and Contextimate, with the two
   contract tests and the warming, delayed-replay and strict-fallback regression tests. The
   forecast probe adopts it in the same step.
6. Meantime phase and activity unions, including the tool-time fixes and their tests.
7. Entries in `docs/upstream-candidates.md` for the Pi requests below.

Steps 1 and 2 fix confirmed bugs with small changes and can start at once. Steps 4 to 6 are
larger, and step 5 changes behaviour in all three extensions, so it needs the end-to-end check
from `AGENTS.md`: a real session with an approved model and cache warming on, with the ledgers
compared against the provider usage.

## Requests for Pi

These go in `docs/upstream-candidates.md`. They are not needed for the fixes above, but each one
would let this repo delete inference code.

1. Provider hook events (`before_provider_request`, `after_provider_response`) carry the request's
   purpose (`agent`, `cache_warm`) and an id that the resulting assistant message also carries.
   The request tracker's replay, re-attempt and response rules would become a lookup.
2. A hook, or a field on `message_end`, that exposes the final payload after every extension's
   transform. Cachemire and Contextimate both read the payload at their own hook position today.
3. `AgentSession.dispose()` emits `session_shutdown`, or documents that it does not, so process
   ownership tokens are released when an SDK host disposes a session.
4. Compaction rejects a summary whose `stopReason` is `aborted`. Pi 1.3.0 rejects only `error`
   and `length`, so a provider that reports `aborted` without aborting the request signal is
   accepted as a successful compaction.

## Investigations

Each investigation ran on Amp against `main` at `3e13d7c` with the locked Pi 1.3.0 and scripted
providers, with no live model calls. Each left its reproduction tests uncommitted in its own
sandbox; the full test code is in the thread's final message.

| Thread | Question | Result |
|---|---|---|
| `T-01a1a11e-2170-70c4-a9f8-333edba5f95b` | Can a second session in the same process corrupt Meantime and Contextimate state? | Confirmed for Meantime (failing test) and for Contextimate's UI globals. Found Cachemire's RPC ownership gap. |
| `T-01a1a11e-305f-730d-8545-0cefd0defa3f` | Can `inCompaction` get stuck, and does `compacted` survive reload? | Both confirmed (three failing tests). The summary request never reaches the provider hooks. |
| `T-01a1a11e-4436-7695-90cf-37eac6006197` | Retries, aborts, steering, extension model calls and tree navigation during a request | Retries, steering and navigation refuted. Cache-warm replay, strict fallback and Meantime tool ownership confirmed (failing tests). |
