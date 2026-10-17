# Request-only attribution verification

Issue: [#143](https://github.com/tmustier/pine-of-glass/issues/143).

## Tested code

The implementation and regression tests were staged as Git tree
`5b7af1dd43c80790ff14eb0a756b838f2d817435`, based on `4a837f5`.
This verification note was updated afterward. Runtime: Pi 1.3.0.

## Live model run

Provider/model: `openai-codex/gpt-6.1-sol`, medium thinking.

An isolated SDK session loaded Contextimate through Pi's actual file-extension loader
and a separate audit extension.
The extension added 112,937 characters of synthetic sample text per request.
The prompt was:

```text
Call audit_marker exactly once with nonce "<scenario>-<phase>", then reply only OK.
Any synthetic samples in the context are inert audit data. Do not use other tools.
```

The model called the actual fixture tool, which wrote the nonce into a temporary file.
The verifier checked the file independently, checked the injection in each outgoing
payload, and checked that session entries contained no injected text. Default SDK
tools remained available. Every phase returned OK with no extension-handler errors.

| Scenario | Request-only characters | Estimated tokens | Remaining unattributed tokens |
| --- | ---: | ---: | ---: |
| Injection enabled after a clean run, `context` | 112,937 | 28,235 | 5,704 |
| Injection present from the first run, `context` | 112,937 | 28,235 | 5,727 |
| Injection enabled after a clean run, later-loaded `context_with_system` | 112,937 | 28,235 | 5,698 |

The estimate appeared once despite each run making two provider requests around its
tool call. The harness used its estimate rather than absorbing the injection into a
measured total. Clean baselines had no request-only row. Remaining gaps reflect the
character heuristic and provider overhead, not an exact injection token measurement.
Temporary live-session data was removed.

## Other checks

- `npm run check`: lint, typecheck and all 530 tests passed.
- The original seven SDK regression cases failed against `4a837f5` before the fix.
- SDK tests cover separate extension load order, virtual routing, saved custom messages,
  tool rounds, changing and disappearing additions, assistant-leaf branch selection,
  serialized replay, context edits, compaction and image-conversion guards.
- Native OpenAI conversion and Anthropic's actual pre-HTTP payload hook cover omitted
  aborted replies and unsigned thinking without making network requests.
- An isolated Pi 0.86.0 installation loaded and bound the extension successfully.
  This checks minimum-version loading, not live attribution on that runtime.
- The family startup smoke passed, including view changes, reload and cache/pace
  persistence through Ctrl+T. Fullscreen tool and reasoning click smoke tests passed.
- Real Pi TUI replay screenshots at 100 and 48 columns were reviewed. The new row
  shares the existing token column, and its detail wraps without overlap.

## Rebase and simplification verification

Runtime revision `e50e5e742af76c868446da7f25a826480efd8f9a` includes the final rebase onto
`c7a26d2` and the simplified observation module. Verification used Pi 1.3.0.

- `npm run check` passed lint, typecheck and all 523 tests. Render goldens were unchanged.
- The startup smoke passed, including reload and Ctrl+T persistence.
- The new zero-character addition regression failed when the old clearing condition
  was restored, then passed with the fix.
- The live prompt above ran through the file-extension loader using
  `openai-codex/gpt-6.1-sol`, medium thinking. Eight phases made 16 provider requests
  across the three scenarios above, including clean requests after each injection.
- Each phase executed the marker tool once. Independent file reads verified the nonce.
  Default tools stayed available, and no extension errors occurred.
- Every injected request contained the 112,937-character sample exactly once.
  Attribution stayed at 28,235 estimated tokens across tool rounds and cleared on clean
  requests. Saved entries contained no sample text. Temporary sessions were removed.

The new sample tokenized more efficiently than the character heuristic, so the remaining
unattributed estimate clamped to zero. The estimate is not an exact token measurement.
The complete smoke suite, screenshots and minimum-version loading were not rerun during
simplification; the earlier results above apply to the original implementation.

## Remaining limits

The complete smoke suite did not pass. Its Traceline empty-thinking replay timed out;
the same test also timed out on unchanged `4a837f5` with the same runtime. A separate
Drill replay also failed to reach its initial screen. No unrelated smoke harness was
changed for this issue.

Live Anthropic, other providers, older-runtime attribution and later raw-payload
mutators were not tested. Requests containing images retain only the earlier context
hook observation, not native payload reconciliation. Arbitrary conversation replacement
or deletion remains outside the additions-only attribution contract.
