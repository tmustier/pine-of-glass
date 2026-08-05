# Token estimator study report

Status: study complete, no estimator formally accepted, no production behaviour changed.

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

## Evidence sources

The fresh evidence is the 68-request aggregate dataset described below. Earlier evidence
was not used to tune the frozen estimator ladder:

- a 23-tool OpenAI prompt exposed the failure of raw JSON divided by 4, while controlled
  schema work favoured the recursive cookbook formula
- Anthropic `count_tokens` measurements found the Claude 4.7 tokenizer-family boundary
- historical replay covered 92 switches across 72 sessions but lacked original static
  prompts; Issue 64 also showed that source-model calibration caused large failures
- 11 earlier complete Radius and OpenAI switches put canonical mean absolute error near
  4.1% and whole-payload sizing near 11.6%, with no direct Anthropic target

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
have one request each, so the report gives raw errors only. Regenerating the analysis
produces the full metric set for every development and held-out size, turn, compaction,
reasoning, image and declared stratum.

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
all 14 as `count-endpoint-unverified`.

Anthropic's held-out generation attempts failed after quota exhaustion. Their number was
not retained, so an empty `skipCounts` object does not satisfy the frozen skip-accounting
rule. The 14 endpoint values remain useful descriptive measurements, not formal
acceptance evidence.

Validation found no split, privacy, unresolved-request or duplicate-resolution failures.
The failed Anthropic generation count remains unknown, and the study contains no
post-compaction request.

The committed files contain no prompt text, response text, tool names, schemas, provider
payloads, Pi session ids or working directories. Full payloads stayed under `/tmp` and
were removed after the original aggregate files were checked. That deletion prevents
retrospective payload binding, so the report narrows its claims rather than reconstructing
missing evidence.

The descriptive `studyRun` field remains an experiment-run label. The separate
`sessionCluster` field applies the privacy-safe source-session ancestry map in
`token-estimator-session-clusters.json`. Bootstrap resampling, split checks and coverage
use `sessionCluster`, not `studyRun`.

## Residual risks

The holdout set does not cover dense content, prompts above 10k on OpenAI, prompts below
10k on Anthropic, or a post-compaction request. Image measurements also show that one
fixed token constant cannot cover both small and ordinary images. Provider tokenization
and injected prompts may change without a code change.

These gaps do not justify source calibration, a fitted regression or an opaque model.

## Reproduce

The committed dataset, frozen candidate and session-cluster map are the source evidence:

- `scripts/cachemire/token-estimator-study-data.json`
- `scripts/cachemire/token-estimator-candidates.json`
- `scripts/cachemire/token-estimator-session-clusters.json`

Run the analyzer command in `scripts/cachemire/README.md` to regenerate the metrics. The
unit test confirms that this reproduces the corrected dataset and the key acceptance
results.
