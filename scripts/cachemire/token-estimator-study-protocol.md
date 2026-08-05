# Token estimator study protocol

Status: frozen before fresh provider experiments on 4 August 2026.

This study chooses the simplest robust and explainable estimate of the first target
prompt after a model switch. It does not authorize a production behaviour change.
Any production change needs a separate review after the report.

## Question and target

Cachemire needs two estimates of the same quantity:

1. At `model_select`, before the target request exists.
2. At `before_provider_request`, after Pi has built the target request.

The target is the provider-reported prompt total for the first resolved target request:

```text
usage.input + usage.cacheRead + usage.cacheWrite
```

The provider total after the response is exact and is never estimated. Cache warmth,
provider/API/model identity and money accounting are outside this experiment and must
not change.

## Prior evidence

Prior work is evidence, not tuning data for this study:

- Naive chars divided by 4 badly overcounted a 23-tool OpenAI prompt. The provider
  reported about 5.9k tool tokens while pretty JSON divided by 4 claimed about 22.9k.
- Controlled OpenAI schema work found the recursive cookbook-style formula materially
  better than raw tool JSON divided by either 4 or a fitted divisor.
- Anthropic's count endpoint found a tokenizer-family boundary at Claude 4.7. Real
  Pi-shaped text moved from roughly 3.5 to 3.8 chars per token to roughly 2.6.
- Historical transcript replay supports the current family session rates, but cannot
  validate static prompts or tools because session files omit their original values.
- Issue 64 replay showed that a source-model calibration ratio creates large failures
  and supplies no reliable benefit after safety guards.
- Eleven complete live Radius/OpenAI switches found the canonical estimate near 4.1%
  mean absolute error and whole-payload JSON sizing near 11.6%. The sample is small,
  static-heavy and has no direct Anthropic target.

Chars divided by 4 remains a reference floor only. It is not presumed competitive for
Claude 4.7+, tools or mixed provider payloads.

## Frozen estimator ladder

Evaluate these methods in order. Do not add another method after seeing holdout results.

### B0: flat reference

Count semantic prompt characters and divide by 4, with the existing image convention.
Count raw provider-shaped tool JSON the same way. This documents how much component and
family knowledge buys us.

### B1: current canonical estimator

Use the shipped target-family rules:

```text
system chars / family text rate
+ provider-shaped or formula-counted tools
+ transformed history chars / family session rate
+ current image convention
```

This is the simplicity baseline to beat.

### C1: one formula over normalized components

Use B1's formula and constants at both phases. At send time, extract normalized system,
tool, history, reasoning and image components from the final provider request instead
of dividing complete serialized JSON, keys and punctuation as prose.

### C2: one measured structural correction

C2 is eligible only if controlled component deltas identify one named mechanism that
keeps C1 outside the acceptance limits. It may add one round family-level constant for
one of:

- fixed per-message framing
- fixed once-per-tool-block overhead
- same-target opaque reasoning carriers
- provider image accounting

C2 may not add content classifiers, fitted regressions, per-session factors or
source-model information. Do not use more than one new constant per provider family.
Round a denominator to one decimal and an overhead to a whole token.

Cross-model calibration, target-own adaptive calibration, ensembles and runtime token
count API calls are excluded. They add state, latency or failure modes before the simple
component model has failed.

## Evidence collection

All fresh provider evidence must use exact provider/API/model identities. Analyze direct
providers and gateways separately. Gateway results may describe that route but may not
set direct-provider constants.

### Controlled development set

Use direct `openai-codex/gpt-5.6-sol` and direct `anthropic/claude-fable-5` where access
allows. Use Anthropic `count_tokens` when it accepts the exact captured request. For
OpenAI Codex, and as an Anthropic fallback, make a real request with thinking off and a
minimal final instruction such as `Reply only: hi. Do not think.`; read exact prompt
usage from the response.

Measure paired deltas while changing one component at a time:

- minimal baseline
- Pi-shaped markdown/system text at short and long sizes
- prose and dense JSON-like text at short and long sizes
- no tools, one built-in tool and the four built-in tools
- one versus several messages with the same text
- text-only history, tool-call/result history and a growing history
- one same-target retained reasoning carrier
- one small and one ordinary image

Provider input counts should be deterministic. Repeat a controlled case only to verify a
surprising result or a route mismatch.

### Holdout set

Do not use holdout results to choose constants. Hold out:

- the unmodified Pine of Glass Pi startup prompt and active tools
- mixed Pi-shaped histories not used in the component experiments
- later turns from growing direct-provider sessions
- at least one reasoning-bearing and one image-bearing request per supported direct
  provider

Assign whole sessions to development or holdout. Never split turns from one session
between them. Aim for at least 12 holdout requests across at least 6 sessions per direct
provider. If provider access prevents this, report the shortfall and do not claim a
winner for that provider.

Record Radius or another gateway only as a separate diagnostic stratum. Do not use it to
make the direct Anthropic sample look larger.

## Capture and privacy contract

Committed artifacts contain aggregate measurements only:

- case class and development/holdout assignment
- provider, API and model
- route class: direct or gateway
- request and turn sequence numbers local to the experiment
- compaction state
- system characters
- tool count, shaped characters and formula estimate
- message and block counts by role/type
- visible text, tool argument/result, readable reasoning, opaque carrier and image counts
- raw serialized field sizes and normalized component sizes
- B0, B1, C1 and eligible C2 estimates
- exact prompt usage

Never commit or report prompt text, tool names, schemas, provider payloads, session ids,
working directories, credentials or response text. Sensitive payload captures remain
under `/tmp` and are removed after aggregate results are verified.

Every resolved request must match the pending request's exact provider, API and model.
Skip zero-usage, aborted, failed, retried-without-resolution and compaction summarizer
calls. Record skip counts in the report.

## Metrics

For each phase and estimator, report:

- sample and session counts
- signed error in tokens and percent
- absolute error in tokens
- mean and median absolute percentage error
- p95 absolute percentage error
- percentage within 10% and within 20%
- session-cluster bootstrap 95% interval for mean absolute error differences

Report separately by target identity, direct/gateway route, source direction, prompt-size
bucket, first/later turn, compaction state, reasoning presence and image presence. Do not
publish a stratum percentage with fewer than 3 requests; list its raw absolute errors
instead.

The UI rounds estimates, so also report how often an estimator changes the displayed
0.1k value and whether it crosses a 10k-token size band incorrectly.

Use a fixed bootstrap seed and at least 2,000 resamples. Percentage error excludes
zero-token responses; those are capture failures, not data.

## Acceptance and stopping rules

A method is acceptable for a direct provider only when its holdout results meet all of:

- absolute signed mean bias no greater than 5%
- median absolute percentage error no greater than 10%
- p95 absolute percentage error no greater than 25%
- no direction with at least 3 requests has mean absolute error above 15%
- exact-identity and privacy checks have no unexplained failures

Choose the simplest acceptable method. Added complexity must improve holdout mean
absolute percentage error by at least 2 percentage points or p95 by at least 5 points
against the next simpler method, without a material regression in another populated
stratum. The session-cluster bootstrap interval for the improvement must exclude zero.
Otherwise choose the simpler method.

Stop when one method meets the limits and the next rung fails the complexity test. Also
stop, without naming a winner, if direct-provider access or the minimum holdout sample
cannot be obtained. Document an unsupported family instead of transferring constants
from another tokenizer or gateway.

## Required output and completion audit

Produce a committed aggregate JSON dataset and a Markdown report that:

1. traces every prior and fresh evidence source
2. verifies development/holdout separation and privacy
3. shows every frozen metric and populated stratum
4. names the simplest winner, or records why no method qualified, for each supported direct provider
5. says whether send-time replacement should remain, use normalized components or be
   removed
6. lists limitations and unsupported routes without inventing coverage
7. proposes, but does not implement, any production change

Run experiment parser/unit tests, smoke each live capture path used, inspect aggregate
artifacts manually, and run `npm run check`. Map each protocol requirement to fresh
evidence before declaring the study complete.
