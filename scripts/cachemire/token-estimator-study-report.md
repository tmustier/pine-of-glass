# Token estimator study report

Status: analysis complete, formal acceptance incomplete, no production behaviour changed.

Date: 4 August 2026.

## Decision

Keep the current canonical family estimator, B1, at model selection. Do not add a
send-time estimator. Neither direct provider has a formal winner under the frozen
acceptance rules.

The evidence supports these conclusions:

- direct Anthropic's B1 measurements pass the numerical limits, but the 14 held-out
  count-endpoint results cannot be bound retrospectively to their deleted payloads
- direct OpenAI's B1 measurements miss the 5% signed-bias limit and cover only 5
  independent session clusters, although B1 is the best frozen estimator
- the current send-time whole-payload replacement, P0, makes both direct routes worse
  in the paired descriptive comparison
- normalized send-time components, C1, add complexity without a material held-out gain
- Anthropic's 290-token tool-block candidate, C2, makes held-out results worse
- Radius remains a diagnostic route because 4 requests across 2 session clusters cannot
  support a route-level decision

A later, separately approved production change may remove P0 and leave the B1 model
selection estimate in place through the send. OpenAI's response-verified evidence
supports that change; Anthropic points in the same direction but is not formal evidence.
This study does not make the production change.

## Recommended formulas

### Direct Anthropic

Keep the current Claude 4.7 and later rules as the best frozen option, not a formally
validated winner:

```text
system characters / 2.6
+ Anthropic-shaped tools / 2.6
+ transformed history characters / 2.6
+ the current image convention
```

Do not add the 290-token C2 tool-block constant. It represents a real provider
mechanism, but other conservative component errors already cover it in the measured
natural prompts. Adding it raised held-out mean absolute percentage error from 3.01% to
5.06%. The external-count provenance gap prevents formal acceptance.

### Direct OpenAI Codex

Keep B1 as the best available estimator:

```text
system characters / 4
+ the recursive OpenAI cookbook-style tool formula
+ transformed history characters / 4
+ the current image convention
```

Do not call this a validated winner. Its held-out median and p95 errors pass, but its
6.78% selection bias misses the 5% limit. Controlled text tests show why a simple new
constant is unsafe. Prose and dense JSON-like text tokenize at materially different
rates.

### Send time

A future approved change may remove the current send-time replacement. Do not replace
it with C1.

Against the B1 selection estimate that removal would actually retain, P0 increased
paired held-out mean absolute percentage error by:

- 3.52 percentage points on OpenAI (13 requests across 5 session clusters), bootstrap
  worsening interval 2.40 to 6.60 points
- 3.16 percentage points on Anthropic (14 requests across 6 session clusters), bootstrap
  worsening interval 2.61 to 4.38 points; this remains descriptive because the endpoint
  counts are not provenance-bound

C1 changed held-out send-time error by less than the 2-point complexity threshold:

- OpenAI worsened by 0.07 points, bootstrap improvement interval -0.61 to 0.15
- Anthropic worsened by 0.16 points, bootstrap improvement interval -0.16 to -0.15

The positive direction in an improvement interval means the more complex estimator is
better. Both C1 intervals fail the frozen complexity rule.

## Held-out results at model selection

The target is the measured provider prompt total for the next request. B0 is semantic
characters divided by 4. B1 is the current family estimator. The corrected B0 selection
benchmark uses only the target-shaped tool characters recorded at `model_select`; it
does not inspect the later provider request, provider usage or source-model calibration.

| Target and method | Requests | Session clusters | Signed error, tokens | Signed error | Mean absolute tokens | Median absolute tokens | MAPE | Median APE | p95 APE | Within 10% | Within 20% | Acceptable |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| OpenAI B0 | 13 | 5 | +872.5 | +10.19% | 872.5 | 862 | 10.19% | 10.39% | 16.70% | 23.1% | 100% | no |
| OpenAI B1 | 13 | 5 | +579.8 | +6.78% | 581.5 | 569 | 6.80% | 6.86% | 13.41% | 92.3% | 100% | no, bias and coverage |
| Anthropic B0 | 14 | 6 | -4,793.3 | -33.86% | 4,793.3 | 4,766 | 33.86% | 34.20% | 37.23% | 0% | 0% | no |
| Anthropic B1 | 14 | 6 | +265.2 | +1.83% | 335.6 | 180 | 2.31% | 1.29% | 9.42% | 100% | 100% | no, provenance and skip accounting |

B1 improved selection MAPE over B0 by:

- 3.40 points on OpenAI, bootstrap interval 3.17 to 3.50
- 31.55 points on Anthropic, bootstrap interval 28.51 to 32.97 (descriptive only)

## Held-out send-time results

B1-send measures the same canonical formula after the user message exists. P0 is the
current production replacement. C1 normalizes final provider components before applying
B1's formula. C2 adds Anthropic's frozen 290-token tool block.

| Target and method | Requests | Session clusters | Signed error, tokens | Signed error | Mean absolute tokens | Median absolute tokens | MAPE | Median APE | p95 APE | Within 10% | Within 20% | Acceptable |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| OpenAI B1-send | 14 | 5 | +671.1 | +7.79% | 671.1 | 587 | 7.79% | 7.08% | 13.66% | 85.7% | 100% | no, bias and coverage |
| OpenAI P0 | 14 | 5 | +878.4 | +10.18% | 878.4 | 792 | 10.18% | 8.93% | 16.10% | 78.6% | 100% | no, bias and coverage |
| OpenAI C1 | 14 | 5 | +579.8 | +6.86% | 679.2 | 588 | 7.86% | 7.08% | 13.66% | 85.7% | 100% | no, bias and coverage |
| Anthropic B1-send | 14 | 6 | +414.9 | +2.86% | 414.9 | 198 | 2.86% | 1.42% | 9.52% | 100% | 100% | no, provenance and skip accounting |
| Anthropic P0 | 14 | 6 | +786.1 | +5.47% | 786.1 | 543 | 5.47% | 3.90% | 12.12% | 85.7% | 100% | no, bias, provenance and skip accounting |
| Anthropic C1 | 14 | 6 | +436.9 | +3.01% | 436.9 | 220 | 3.01% | 1.58% | 9.68% | 100% | 100% | no, provenance and skip accounting |
| Anthropic C2 | 14 | 6 | +726.9 | +5.06% | 726.9 | 510 | 5.06% | 3.66% | 11.66% | 85.7% | 100% | no, bias, provenance and skip accounting |

## Display effects

Primary estimates differed from the measured rounded 0.1k display in nearly every held-out
request. OpenAI B1 selection matched once, so its mismatch rate was 92.3%. Every other
primary direct estimate differed. This reflects the strict 50-token rounding boundary,
not a separate accounting failure.

Compared with B1-send:

- P0 changed the displayed 0.1k value in 100% of direct held-out requests
- C1 changed it in 14.3% of OpenAI requests and 50% of Anthropic requests
- C2 changed it in 100% of Anthropic requests

OpenAI estimates crossed a 10k band incorrectly in 15.4% of B1 selection cases, 21.4%
of B1-send cases and 14.3% of C1 cases. Anthropic crossed no 10k band incorrectly.
P0 created visible churn without improving accuracy.

## Controlled component evidence

### Static text and tools

These development cases changed one main component at a time. System character counts
include Pi's fixed request wrapper. All token totals are exact provider counts.

| Provider | Case | System characters | Tools | Exact | B0 | B1 | P0 | C1 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| OpenAI | baseline | 963 | 0 | 217 | 249 | 249 | 264 | 249 |
| OpenAI | short prose | 2,135 | 0 | 455 | 542 | 542 | 557 | 542 |
| OpenAI | long prose | 45,854 | 0 | 10,514 | 11,472 | 11,472 | 11,487 | 11,472 |
| OpenAI | short dense JSON-like text | 1,664 | 0 | 404 | 424 | 424 | 439 | 424 |
| OpenAI | long dense JSON-like text | 65,566 | 0 | 19,172 | 16,400 | 16,400 | 16,415 | 16,400 |
| OpenAI | one tool | 963 | 1 | 358 | 420 | 352 | 389 | 352 |
| OpenAI | 4 tools | 963 | 4 | 695 | 959 | 631 | 782 | 631 |
| Anthropic | baseline | 1,020 | 0 | 368 | 263 | 383 | 492 | 405 |
| Anthropic | short prose | 2,192 | 0 | 755 | 556 | 834 | 947 | 856 |
| Anthropic | long prose | 45,911 | 0 | 16,747 | 11,486 | 17,649 | 17,986 | 17,671 |
| Anthropic | short dense JSON-like text | 1,721 | 0 | 665 | 438 | 652 | 817 | 674 |
| Anthropic | long dense JSON-like text | 65,623 | 0 | 27,161 | 16,414 | 25,230 | 29,832 | 25,252 |
| Anthropic | one tool | 1,020 | 1 | 899 | 443 | 636 | 771 | 658 |
| Anthropic | 4 tools | 1,020 | 4 | 1,634 | 982 | 1,431 | 1,599 | 1,453 |

The text marginals explain why this study did not fit a new global denominator:

- OpenAI ranged from about 3.4 characters per token for dense text to 4.9 for short
  prose
- Anthropic ranged from about 2.4 characters per token for dense text to 3.0 for short
  prose

The OpenAI cookbook-style tool formula materially beat raw shaped JSON divided by 4.
This confirms the earlier 23-tool result, where the provider reported about 5.9k tool
tokens and pretty JSON divided by 4 claimed about 22.9k.

Anthropic's exact 4-tool ablation found:

- 290 tokens of once-per-request tool instructions
- 976 net tool-definition tokens
- 2.95 shaped characters per net tool token

C1 estimated 1,048 definition tokens and omitted the 290-token block. Adding the full
290 fixed one mechanism but over-corrected natural held-out prompts. The frozen C2
candidate was therefore rejected.

### Growing messages

The semantic message text grew by 31 characters per turn. P0 grew much faster because
it counted provider JSON framing as prose.

| Provider | Turn | Messages | Semantic history characters | Exact | B1 | P0 | C1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| OpenAI | 1 | 1 | 29 | 217 | 249 | 264 | 249 |
| OpenAI | 2 | 3 | 60 | 237 | 256 | 338 | 256 |
| OpenAI | 3 | 5 | 91 | 257 | 264 | 412 | 264 |
| OpenAI | 4 | 7 | 122 | 277 | 272 | 487 | 272 |
| Anthropic | 1 | 1 | 29 | 368 | 383 | 492 | 405 |
| Anthropic | 2 | 3 | 60 | 387 | 395 | 547 | 417 |
| Anthropic | 3 | 5 | 91 | 406 | 406 | 603 | 428 |
| Anthropic | 4 | 7 | 122 | 425 | 418 | 658 | 440 |

This gives a direct mechanism for the earlier live observation that send-time estimates
gained positive bias over turns.

### Tool history, reasoning and images

The controlled tool-call and result turn contained about 2.2k tool-result characters.
B1 undercounted that second request by 94 tokens on OpenAI and 480 on Anthropic. P0's
extra framing reduced those two errors, but it failed on ordinary message growth and the
held-out set. Anthropic C2 reduced the controlled tool-history error from 458 to 168
tokens, then failed the held-out bias rule.

Same-target opaque carriers were also overcounted:

- an OpenAI carrier of 1,592 characters produced a B1 absolute error of 245 tokens and
  a C1 error of 194 tokens in the controlled second request
- an Anthropic carrier of 348 characters produced a B1 error of 134 tokens and a C1
  error of 156 tokens

There is only one reasoning-bearing held-out request per direct provider. The raw B1
absolute errors were 817 OpenAI tokens and 890 Anthropic tokens. The study does not set
a carrier constant from that coverage.

Image cost depends strongly on image dimensions:

| Provider | Image | Exact increase over text baseline | B1 image allocation |
|---|---|---:|---:|
| OpenAI | 32 by 32 | 20 | about 1,200 |
| OpenAI | 1,024 by 768 | 940 | about 1,200 |
| Anthropic | 32 by 32 | 39 | about 1,847 |
| Anthropic | 1,024 by 768 | 1,074 | about 1,847 |

One fixed image token constant cannot cover both sizes. The frozen ladder allowed one
family-level correction, so the study did not introduce a size model after seeing these
results. The existing image convention remains a known conservative risk.

## Held-out strata for B1-send

The analysis suppresses percentages for strata with fewer than 3 requests. Those rows
show raw absolute token errors.

| Target | Stratum | Requests | MAPE or raw absolute errors |
|---|---|---:|---|
| OpenAI | under 10k | 14 | 7.79% |
| OpenAI | first request | 7 | 7.75% |
| OpenAI | later request | 7 | 7.83% |
| OpenAI | no compaction | 14 | 7.79% |
| OpenAI | reasoning absent | 13 | 7.66% |
| OpenAI | reasoning present | 1 | 817 tokens |
| OpenAI | image absent | 12 | 6.82% |
| OpenAI | image present | 2 | 1,213, 1,201 tokens |
| OpenAI | same-family direction | 13 | 8.00% |
| OpenAI | Anthropic to OpenAI | 1 | 504 tokens |
| OpenAI | unmodified natural prefix | 6 | 7.02% |
| OpenAI | tool history | 3 | 6.02% |
| Anthropic | 10k to 50k | 14 | 2.86% |
| Anthropic | first request | 7 | 3.17% |
| Anthropic | later request | 7 | 2.54% |
| Anthropic | no compaction | 14 | 2.86% |
| Anthropic | reasoning absent | 13 | 2.65% |
| Anthropic | reasoning present | 1 | 890 tokens |
| Anthropic | image absent | 11 | 1.40% |
| Anthropic | image present | 3 | 8.21% |
| Anthropic | same-family direction | 13 | 2.98% |
| Anthropic | OpenAI to Anthropic | 1 | 176 tokens |
| Anthropic | unmodified natural prefix | 6 | 1.42% |
| Anthropic | mixed history | 7 | 1.40% |
| Anthropic | reasoning component | 3 | 2.79% |
| Anthropic | tool-history-labelled requests | 2 | 198, 196 tokens |

No direction with at least 3 requests exceeded the 15% limit. Cross-family directions
have one request each, so the report gives raw errors only. The committed analysis JSON
contains the same full metric set for every development and held-out size, turn,
compaction, reasoning, image and declared stratum.

## Gateway diagnostic

Radius `pi-messages/gpt-5.6-sol` had 4 held-out requests across 2 session clusters:

| Method | Signed error | MAPE | Median APE | p95 APE |
|---|---:|---:|---:|---:|
| B1 selection | +10.86% | 10.86% | 10.77% | 10.96% |
| B1-send | +10.96% | 10.96% | 10.87% | 11.05% |
| P0 | +11.98% | 11.98% | 11.10% | 12.87% |
| C1 | +10.96% | 10.96% | 10.87% | 11.05% |

This route has too little coverage and does not set direct-provider constants.

## Data quality and privacy

The aggregate dataset contains 68 measured requests across 41 study runs and 37 session
clusters:

- 19 direct OpenAI development requests across 13 session clusters
- 17 direct Anthropic development requests across 12 session clusters
- 14 direct OpenAI held-out requests across 5 session clusters
- 14 direct Anthropic held-out requests across 6 session clusters
- 4 held-out Radius diagnostics across 2 session clusters

Counts came from 54 provider responses and 14 Anthropic `count_tokens` calls. Provider
response metadata verifies identity for the 54 response rows. The 14 historical endpoint
rows retain only a manually entered model check: they lack provider/API evidence and a
payload digest binding the count to the captured request. The analyzer therefore marks
all 14 as `count-endpoint-unverified`. Three development requests used both Anthropic
routes; their response usage and endpoint results matched in all 3 cases, but those
aggregate cross-checks do not bind the 14 held-out payloads.

Anthropic's held-out generation attempts failed after quota exhaustion. Their number was
not retained, so an empty `skipCounts` object does not satisfy the frozen skip-accounting
rule. The 14 endpoint values remain useful descriptive measurements, not formal
acceptance evidence.

Validation found:

- 54 response-verified rows and 14 unverified count-endpoint rows
- 0 development and holdout split failures after source-session clustering
- 0 forbidden privacy keys, UUIDs or local paths in committed artifacts
- 0 unresolved prompt targets and 0 duplicate recorded resolutions
- an unknown number of unrecorded failed Anthropic generation attempts
- 0 compaction requests in the committed study

The committed files contain no prompt text, response text, tool names, schemas, provider
payloads, Pi session ids or working directories. Full payloads stayed under `/tmp` and
were removed after the original aggregate files were checked. That deletion prevents
retrospective payload binding, so the report narrows its claims rather than reconstructing
missing evidence.

The descriptive `studyRun` field remains an experiment-run label. The separate
`sessionCluster` field applies the privacy-safe source-session ancestry map in
`token-estimator-session-clusters.json`. Bootstrap resampling, split checks and coverage
use `sessionCluster`, not `studyRun`.

## Prior evidence and reruns

The study treated earlier results as evidence, not tuning data:

- historical replay had 92 comparable switches across 72 sessions
- source-model calibration increased mean absolute error and produced large outliers
- 11 earlier complete Radius and OpenAI switches put canonical error near 4.1% and
  whole-payload sizing near 11.6%
- historical session files lacked original system prompts and tool schemas, so they
  could not validate absolute static estimates

Fresh direct-provider cases replaced the doubtful static reconstruction. They captured
actual current system text, tool payloads, final provider requests and measured usage.
Direct and gateway routes stayed separate. No source token count or usage rescaled a
target estimate.

## Residual risks

The recommendation has these limits:

- OpenAI B1 misses the frozen signed-bias limit by 1.78 percentage points
- all OpenAI holdout prompts were under 10k and all Anthropic prompts were about 14k to
  16k; no dense-content case was held out
- development text cases changed the sign of error by content type, so OpenAI's bias is
  not a safe correction constant
- small and ordinary images need size-aware provider accounting, outside the frozen
  one-constant ladder
- there is only one reasoning-bearing held-out request per direct provider
- cross-family directions have one held-out request each
- no final request followed compaction
- Anthropic held-out generation quota was exhausted; 14 held-out targets used the
  official count endpoint, but the deleted captures prevent payload binding and the
  failed-attempt count is unknown
- OpenAI has only 5 independent held-out session clusters after the natural-history forks
  are collapsed to their shared source ancestor
- forked histories count as the first target request even when they contain earlier
  source messages
- Radius has only 4 diagnostic requests
- provider tokenization and injected prompts can change without a code change

These risks do not justify source calibration, a fitted regression or an opaque model.

## Generated analysis snapshot

The block below is generated from the committed aggregate dataset by
`analyze-token-estimator-study.mjs`. The test suite requires it to match regenerated
output, so the primary metrics, paired comparisons, acceptance results and coverage
cannot drift independently from the machine-readable analysis.

<!-- token-estimator-analysis:start -->
### Token estimator study analysis

Dataset: 68 resolved requests across 37 session clusters.
Identity failures: 0; unresolved requests: 0; duplicate resolutions: 0; privacy violations: 0; split failures: 0.
Identity evidence: 54 provider responses; 0 payload-bound count-endpoint rows; 14 unverified count-endpoint rows.

### Primary metrics

| Split / route / target | Estimator | n | Bias | MAPE | Median APE | p95 APE | Within 10% | Wrong 10k band |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| development / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B0-send | 19 | 39.5% | 41.6% | 14.7% | 518.1% | 36.8% | 0.0% |
| development / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B1-send | 19 | 35.3% | 39.3% | 9.2% | 517.7% | 52.6% | 0.0% |
| development / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | P0-current-send | 19 | 52.4% | 53.9% | 21.7% | 530.4% | 26.3% | 0.0% |
| development / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | C1-normalized-send | 19 | 34.7% | 38.8% | 10.2% | 517.7% | 47.4% | 0.0% |
| development / direct / anthropic/anthropic-messages/claude-fable-5 | B0-send | 17 | -14.4% | 45.7% | 31.4% | 263.4% | 5.9% | 5.9% |
| development / direct / anthropic/anthropic-messages/claude-fable-5 | B1-send | 17 | 27.6% | 39.9% | 7.1% | 453.6% | 52.9% | 0.0% |
| development / direct / anthropic/anthropic-messages/claude-fable-5 | P0-current-send | 17 | 53.0% | 57.6% | 33.6% | 488.2% | 23.5% | 0.0% |
| development / direct / anthropic/anthropic-messages/claude-fable-5 | C1-normalized-send | 17 | 31.1% | 42.1% | 10.3% | 459.0% | 35.3% | 0.0% |
| development / direct / anthropic/anthropic-messages/claude-fable-5 | C2-anthropic-tool-block | 17 | 36.8% | 38.6% | 7.8% | 459.0% | 58.8% | 0.0% |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B0-selection | 13 | 10.2% | 10.2% | 10.4% | 16.7% | 23.1% | 15.4% |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B1-selection | 13 | 6.8% | 6.8% | 6.9% | 13.4% | 92.3% | 15.4% |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B0-send | 14 | 10.7% | 11.2% | 11.0% | 17.4% | 21.4% | 14.3% |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B1-send | 14 | 7.8% | 7.8% | 7.1% | 13.7% | 85.7% | 21.4% |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | P0-current-send | 14 | 10.2% | 10.2% | 8.9% | 16.1% | 78.6% | 21.4% |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | C1-normalized-send | 14 | 6.9% | 7.9% | 7.1% | 13.7% | 85.7% | 14.3% |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B0-selection | 14 | -33.9% | 33.9% | 34.2% | 37.2% | 0.0% | 85.7% |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B1-selection | 14 | 1.8% | 2.3% | 1.3% | 9.4% | 100.0% | 0.0% |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B0-send | 14 | -32.8% | 32.8% | 33.7% | 33.8% | 0.0% | 78.6% |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B1-send | 14 | 2.9% | 2.9% | 1.4% | 9.5% | 100.0% | 0.0% |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | P0-current-send | 14 | 5.5% | 5.5% | 3.9% | 12.1% | 85.7% | 0.0% |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | C1-normalized-send | 14 | 3.0% | 3.0% | 1.6% | 9.7% | 100.0% | 0.0% |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | C2-anthropic-tool-block | 14 | 5.1% | 5.1% | 3.7% | 11.7% | 85.7% | 0.0% |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B0-selection | 4 | 10.4% | 10.4% | 10.3% | 10.5% | 0.0% | 0.0% |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B1-selection | 4 | 10.9% | 10.9% | 10.8% | 11.0% | 0.0% | 0.0% |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B0-send | 4 | 10.7% | 10.7% | 10.7% | 10.8% | 0.0% | 0.0% |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B1-send | 4 | 11.0% | 11.0% | 10.9% | 11.1% | 0.0% | 0.0% |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | P0-current-send | 4 | 12.0% | 12.0% | 11.1% | 12.9% | 0.0% | 0.0% |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | C1-normalized-send | 4 | 11.0% | 11.0% | 10.9% | 11.1% | 0.0% | 0.0% |

### Paired holdout comparisons

Positive mean improvement means the second estimator has lower absolute percentage error.

| Split / route / target | Comparison | n | Session clusters | Mean improvement | 95% bootstrap interval |
|---|---|---:|---:|---:|---:|
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B0-selection -> B1-selection | 13 | 5 | 3.40 points | 3.17 to 3.50 |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B0-send -> B1-send | 14 | 5 | 3.42 points | 1.78 to 3.88 |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B1-send -> C1-normalized-send | 14 | 5 | -0.07 points | -0.61 to 0.15 |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B1-send -> P0-current-send | 14 | 5 | -2.39 points | -2.71 to -2.21 |
| holdout / direct / openai-codex/openai-codex-responses/gpt-5.6-sol | B1-selection -> P0-current-send | 13 | 5 | -3.52 points | -6.60 to -2.40 |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B0-selection -> B1-selection | 14 | 6 | 31.55 points | 28.51 to 32.97 |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B0-send -> B1-send | 14 | 6 | 29.92 points | 24.39 to 32.34 |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B1-send -> C1-normalized-send | 14 | 6 | -0.16 points | -0.16 to -0.15 |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B1-send -> P0-current-send | 14 | 6 | -2.61 points | -3.04 to -2.46 |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | B1-selection -> P0-current-send | 14 | 6 | -3.16 points | -4.38 to -2.61 |
| holdout / direct / anthropic/anthropic-messages/claude-fable-5 | C1-normalized-send -> C2-anthropic-tool-block | 14 | 6 | -2.05 points | -2.08 to -1.97 |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B0-selection -> B1-selection | 4 | 2 | -0.43 points | -0.43 to -0.43 |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B0-send -> B1-send | 4 | 2 | -0.22 points | -0.22 to -0.22 |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B1-send -> C1-normalized-send | 4 | 2 | 0.00 points | 0.00 to 0.00 |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B1-send -> P0-current-send | 4 | 2 | -1.02 points | -1.02 to -1.02 |
| holdout / gateway / radius/pi-messages/gpt-5.6-sol | B1-selection -> P0-current-send | 4 | 2 | -1.12 points | -1.12 to -1.12 |

### Formal acceptance

| Target | Phase | Estimator | n | Session clusters | Acceptable | Failures |
|---|---|---|---:|---:|---|---|
| openai-codex/openai-codex-responses/gpt-5.6-sol | selection | B0-selection | 13 | 5 | no | bias, median, coverage |
| openai-codex/openai-codex-responses/gpt-5.6-sol | selection | B1-selection | 13 | 5 | no | bias, coverage |
| openai-codex/openai-codex-responses/gpt-5.6-sol | send | B0-send | 14 | 5 | no | bias, median, coverage |
| openai-codex/openai-codex-responses/gpt-5.6-sol | send | B1-send | 14 | 5 | no | bias, coverage |
| openai-codex/openai-codex-responses/gpt-5.6-sol | send | P0-current-send | 14 | 5 | no | bias, coverage |
| openai-codex/openai-codex-responses/gpt-5.6-sol | send | C1-normalized-send | 14 | 5 | no | bias, coverage |
| anthropic/anthropic-messages/claude-fable-5 | selection | B0-selection | 14 | 6 | no | bias, median, p95, direction, provenance, skip-accounting |
| anthropic/anthropic-messages/claude-fable-5 | selection | B1-selection | 14 | 6 | no | provenance, skip-accounting |
| anthropic/anthropic-messages/claude-fable-5 | send | B0-send | 14 | 6 | no | bias, median, p95, direction, provenance, skip-accounting |
| anthropic/anthropic-messages/claude-fable-5 | send | B1-send | 14 | 6 | no | provenance, skip-accounting |
| anthropic/anthropic-messages/claude-fable-5 | send | P0-current-send | 14 | 6 | no | bias, provenance, skip-accounting |
| anthropic/anthropic-messages/claude-fable-5 | send | C1-normalized-send | 14 | 6 | no | provenance, skip-accounting |
| anthropic/anthropic-messages/claude-fable-5 | send | C2-anthropic-tool-block | 14 | 6 | no | bias, provenance, skip-accounting |

### Coverage

- direct development: 36
- direct holdout: 28
- gateway diagnostic: 4
- reasoning-bearing: 4
- image-bearing: 9

### Capture exclusions and gaps

- No skip records.
- Unrecorded skip accounting: anthropic/anthropic-messages/claude-fable-5

Full split, route, size, turn, reasoning, image and declared-stratum metrics are in the JSON report.
<!-- token-estimator-analysis:end -->

## Completion audit

The audit confirms:

1. The frozen protocol is committed separately from the data tooling.
2. Controlled direct-provider cases cover text shape and size, tools, message growth,
   tool calls and results, reasoning carriers, and 2 image sizes.
3. Privacy-safe source-session clusters stay wholly within one split.
4. The analyzer reports signed and absolute errors, percentiles, display effects,
   populated strata and 4,000 session-cluster bootstrap samples with seed 20260804.
5. Percentages are suppressed from each estimator with fewer than 3 comparable requests.
6. The send-time replacement, normalized C1 and frozen C2 candidate were tested without
   changing production code.
7. The committed aggregate dataset deterministically regenerates corrected estimates and
   the full machine-readable analysis.
8. Privacy checks pass for all committed artifacts.

The frozen formal-acceptance audit does not pass:

- OpenAI has 13 selection requests across only 5 independent session clusters, and B1
  also misses the signed-bias limit.
- Anthropic has 14 endpoint measurements across 6 clusters, but all 14 lack payload-bound
  provider/API provenance and the failed-generation skip count was not retained.

The study therefore names no formal direct-provider winner. Future captures record a
SHA-256 digest of the provider payload; the external counter preserves accepted prompt
controls including `output_config` and `cache_control`; the recorder validates provider,
API, model and payload digest before admitting a result.

Machine-readable evidence lives in:

- `scripts/cachemire/token-estimator-study-data.json`
- `scripts/cachemire/token-estimator-study-analysis.json`
- `scripts/cachemire/token-estimator-exact-cross-checks.json`
- `scripts/cachemire/token-estimator-candidates.json`
- `scripts/cachemire/token-estimator-session-clusters.json`
