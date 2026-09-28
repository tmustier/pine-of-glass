# Next release notes (draft)

- Contextimate's startup breakdown is available to other extensions as plain data:
  `contextReport(pi, ctx)` from `extensions/pi-contextimate/report.ts` returns the model,
  heuristic, total and each section's characters and estimated tokens, the skills in the
  skill index and every tool with whether it is active. It counts Pi's current system prompt
  with the panel's heuristic and the user's `pi-contextimate` config, and is the stable
  interface for this; the `internals` object remains for this repo's tests only. The accounting moved out of
  `index.ts` into `snapshot.ts`, `heuristic-config.ts` and `tool-accounting.ts`; the panel is
  unchanged.
