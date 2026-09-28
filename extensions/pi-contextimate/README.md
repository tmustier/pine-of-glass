# pi-contextimate

`pi-contextimate` adds a startup `[Contextimate]` panel to Pi that shows what is filling the model's context window before you type anything: the runtime system prompt, AGENTS.md files, the always-loaded skill index, active tool schemas, and session material.

![Contextimate summary panel at startup](../../docs/img/pi-contextimate-summary.png)

`Ctrl+O` cycles 2 deeper views. Compact is a scan view: one aligned line per skill and per tool, sorted by estimated tokens.

![Contextimate compact view](../../docs/img/pi-contextimate-compact.png)

Expanded adds each section's counting method and sources, plus a readable schema tree for every active tool.

![Contextimate expanded view, excerpt](../../docs/img/pi-contextimate-expanded.png)

## Install

Install from npm:

```bash
pi install npm:pine-of-glass
```

Try it for one run without installing:

```bash
pi -e npm:pine-of-glass
```

For local development from a clone:

```bash
pi -e ./extensions/pi-contextimate
```

## Use

The panel renders after Pi's native startup resource list and re-inserts itself if a chat rebuild (for example `/reload`) drops it. Ctrl+T preserves existing components in regular and fullscreen modes.

- `Ctrl+O`, Pi's expand and collapse key, cycles summary, compact and expanded
- `/contextimate` also cycles; `/contextimate summary`, `/contextimate compact` and `/contextimate expanded` jump to a mode

How to read the numbers:

- every `~` number is an estimate; `Total request` drops it only when Pi's current total is fully provider-reported, and keeps it when trailing messages add a local estimate
- the dim hint line under the header states the counting method once, for example `counts ch ÷ 2.6 (Claude 4.7+ heuristic)`; data rows carry only their raw size, like `(9.2k ch)`
- the method follows the active model, so switching models re-estimates immediately; concrete Claude, Kimi, GLM, Cohere and Grok model IDs keep their measured raw-text profile through supported relays, while dynamic aliases stay unknown until routing selects a model
- until the first post-switch response, `Total request` names its old currency (`pre-switch usage · <model> tokens`) and withholds only that total's context bar and window share
- the first row says `Runtime system prompt` because Pi assembles that prompt at runtime from its base prompt plus tool and extension contributions; expanded view attributes the part it can verify
- after the first turn, the prompt rows count the prompt the latest run sent, including changes extensions make just before a run (for example `pi-skill-gate` hiding skills), which Pi does not keep once the run ends
- `Skill frontmatter` counts the always-loaded skill index only, not skill bodies, which load on demand; it reads Pi's `<available_skills>` index, including one an extension has moved out of Pi's `<skills>` section, and the compact `<codex_skills>` list that `pi-codex-conversion` injects per turn (Pi itself omits the index while `read` and `bash` are swapped out, so that row appears after the first turn)
- each expanded tool header shows where the tool came from: its config scope and defining file, or `builtin`
- `Reasoning context` sums provider-reported exact counts for signed reasoning retained by the response anchoring Pi's total; it follows Claude and OpenAI's model-specific retention defaults
- Pi's exact prompt total, including cache reads and writes, rejects historical attribution that cannot fit; summaries not covered by exact counts remain estimated separately as `Thinking summaries`
- opaque signatures are never treated as token-sized text, and cross-model reasoning is not counted as retained
- `Tool outputs` are measured from the provider-reported growth of the prompt between responses when the prompt cache proves nothing else changed; the detail says `measured`, or names the measured share, and the rest is estimated
- `Total harness` is the first request's measured prompt when every later request provably reused it; the detail then shows the section rows' estimated sum beside it
- `Unattributed` is the remaining accounting gap and can include estimation error, provider overhead, images and reasoning when the provider reports no breakdown

The panel's visual grammar is the family design language: see `docs/design-language.md`.

## Use from another extension

`report.ts` returns the startup breakdown as plain data, counted with the panel's heuristic and `pi-contextimate` config. It is the stable interface; `index.ts` and the other modules are not.

```ts
import { contextReport } from "pine-of-glass/extensions/pi-contextimate/report.ts";

pi.registerCommand("context-json", {
  handler: async (_args, ctx) => {
    const report = contextReport(pi, ctx);
    // { model, heuristic, totalTokens, sections: [{ id, title, chars, tokens }],
    //   skills: [{ name, location, tokens }], tools: [{ name, active, tokens?, source }] }
  },
});
```

At `session_start` the prompt does not yet include skills other extensions add at startup; call it once startup has finished, as a command does.

`sections` covers the runtime system prompt, each AGENTS file, the skill index and the active tool definitions, not the conversation, and `totalTokens` is their sum. It counts Pi's current prompt, `ctx.getSystemPrompt()`: during a run, the prompt that run sent; otherwise Pi's base prompt. After a run the panel keeps counting that run's prompt, so the two differ when an extension rewrites the prompt per run. Each tool's `tokens` is a per-tool estimate; with the provider's payload overhead they need not sum to the tools section.

## How it counts

Sections are counted on provider-shaped payloads with per-model heuristics, never on local object size. [`docs/pi-contextimate.md`](../../docs/pi-contextimate.md) explains the counting policy, the evidence behind each heuristic, and the JSON config for overriding them per provider or model.

Three packaged diagnostics measure rather than guess:

- `pi-contextimate-probe-prefix` captures what Pi actually sends and prints sanitized sizes and usage
- `pi-contextimate-evaluate-transcripts` checks the session heuristics against recorded usage in local session files
- `pi-contextimate-check-provider-tokens` gets provider-exact token counts for a captured payload and suggests calibrated denominators

See [`scripts/contextimate/README.md`](../../scripts/contextimate/README.md) for usage.
