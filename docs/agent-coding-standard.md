# Agent coding standard

This repository is maintained by agents as well as humans. The coding standard is
therefore executable: deterministic checks should catch repeated agent failure modes
before review. A lint failure is a just-in-time prompt, not just a compiler-style
error.

Run:

```bash
npm run lint
npm run check
```

`npm run lint` runs `scripts/dev/agent-lint.mjs`, which applies the repo-specific `POG`
rules below, runs Oxlint with the vendored anti-slop plugin (next section), and then
checks generated Cachemire retention docs. Existing violations of every rule are recorded
in `scripts/dev/agent-lint-baseline.json` so each rule prevents regressions while the
codebase is migrated deliberately. Do not grow the baseline as a way to dodge the
standard. Fix the code, add a precise `SAFETY:` comment for a real seam, or update a
reviewed migration plan.

## Slop lint

`.oxlintrc.json` runs Oxlint with [anti-slop](https://github.com/dmmulroy/anti-slop),
vendored at `tools/oxlint/anti-slop/` (provenance in `tools/oxlint/UPSTREAM.md`). The
rules reject low-evidence TypeScript: `unknown` returns, unsafe dictionaries, chained or
unexplained assertions, widening known values, conditional empty-object spreads,
accumulator copies, vague `shape` names, module mocking. `npm run lint:slop` prints the
full diagnostics; `npm run lint` feeds them into the same baseline as the `POG` rules,
keyed by rule id such as `anti-slop(no-unknown-returns)`.

Rules that are off are off by policy, with the reason inline in `.oxlintrc.json`, never
baselined:

- `no-runtime-typeof` and `no-unknown-parameters` assume a schema library at the
  boundary. This package has none, so `parse(value: unknown): T` with `typeof`
  refinement is the sanctioned boundary mechanism (see "Boundary typing"). Leaking
  `unknown` inward is still caught by POG001 and POG004.
- `eslint/no-control-regex`: ANSI escape parsing is the domain.
- In `tests/**`, `require-safety-comment-for-type-assertion` and
  `no-chained-type-assertions` are off because synthetic duck-typed fixtures are the
  documented stand-in pattern, proven against real Pi by the contract suite.

A baseline entry is debt with an intended fix. If a finding is correct code that should
stay, the right move is a rule-level decision in `.oxlintrc.json` with its reason, or
an inline `oxlint-disable-next-line` with a justification, not a baseline entry.

`oxlint` and `@oxlint/plugins` are the repo's only devDependencies and are pinned to the
same exact version; the plugin's API tracks Oxlint. `npm install` prunes the Pi runtime
symlinks, so run `npm run link-pi` after it; `npm run preflight` says so if you forget.

## Boundary typing

`unknown` belongs at true boundaries only:

- Pi internals and TUI component seams
- JSON config files
- provider payloads and serialized session data
- catch values or other external runtime input

At the boundary, parse or refine the value into a domain type. After that, pass typed
values inward. Core rendering, formatting, and economics logic should not repeatedly
rediscover object shapes.

Generic record guards are banned:

```ts
function isRecord(value: unknown): value is Record<string, unknown>;
function isObject(value: unknown): value is object;
```

Use domain-named helpers instead:

```ts
isJsonObject(value)
parseContextimateConfig(value)
parseCachemireConfig(value)
isToolSchemaObject(value)
isPiComponentLike(value)
```

The shared generic JSON helpers live in `extensions/_lib/boundary.ts`. They are for
boundary code and domain parsers, not an excuse to let `unknown` spread through core
logic.

## JSON and config

Do not cast decoded JSON directly:

```ts
const config = JSON.parse(text) as ContextimateConfig; // banned
```

Use parser-driven config reads:

```ts
const config = readJsonConfig(filePath, parseContextimateConfig);
```

Config parsers should be permissive at the file boundary and precise at the call site:
ignore invalid fields, sanitize numbers, and return a typed config object.

## Escape hatches

`any`, broad `Record<string, unknown>` casts, and TypeScript suppressions require a
nearby `SAFETY:` comment unless a rule has a narrower local proof. Good comments state:

1. why the escape hatch is necessary,
2. the runtime shape being relied on,
3. the contract test or source of evidence that pins the assumption.

Example:

```ts
// SAFETY: Pi tool rows are not exported as a stable type. Contract tests pin the
// render/setExpanded/toolName duck type used by traceline.
function renderToolRow(comp: any): string[];
```

If the value is not a Pi seam, prefer `unknown` plus boundary parsing or a precise type.

## Visual and repository invariants

The lint also protects existing repo rules:

- `_lib` must not grow an `index.ts`, because Pi extension discovery should skip it.
- Runtime dependencies stay empty unless maintainers explicitly decide otherwise.
- Raw ANSI colour constants live in the style or ANSI layers, not arbitrary render code.
- Markdown docs avoid em dashes, except quoted or generated UI output with a local lint
  exemption.
- TypeScript files should stay context-sized. Existing oversized files have temporary
  budgets in the baseline and should be split over time rather than grown.
- The test-only `export const internals` objects on the older entry files do not grow
  (POG012). Tests reach behaviour through public interfaces; see
  [testing.md](./testing.md), "Public interfaces". Each entry leaves by extracting its
  logic into a domain module or covering the behaviour through the extension harness.

## Baseline policy

The baseline is a migration ledger. It is allowed because this repo already has large Pi
seam files and historical markdown style drift. It is not a waiver for new code.

When touching a baselined area:

1. Prefer reducing violations in the changed code.
2. Do not add generic record guards.
3. Add `SAFETY:` only for real Pi or runtime boundary seams.
4. If a file is over its line budget, split by domain before adding unrelated logic.
5. If an `internals` entry is in reach, move its logic to a domain module and delete it.
6. Regenerate the baseline only after review when current violations were intentionally
   fixed, moved, or reclassified.

To inspect the migration ledger:

```bash
npm run lint -- --show-baseline
```

To regenerate after reviewed fixes:

```bash
node scripts/dev/agent-lint.mjs --update-baseline
```
