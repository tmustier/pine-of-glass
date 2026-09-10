# pine-of-glass: agent notes

Three pi extensions (`contextimate`, `traceline`, `cachemire`) sharing one design
language. TypeScript, zero runtime dependencies, tests on `node:test`.

## Commands

```bash
npm install             # pinned lint tooling; prunes the Pi symlinks, so:
npm run link-pi         # symlink the installed pi runtime into node_modules (types + contract tests); run after every npm install
npm run link-extensions # symlink the extensions (as directories) into ~/.pi/agent/extensions
npm run docs:cache      # regenerate Cachemire retention docs
npm run lint            # POG rules + oxlint/anti-slop (baselined) + generated-doc drift checks
npm run lint:slop       # oxlint alone, full diagnostics
npm run typecheck       # tsc against the real installed pi
npm test                # unit + golden + pi contract tests (node:test)
npm run check           # lint + typecheck + tests
npm run test:smoke      # launches real pi in tmux with an isolated HOME (local-only)
```

## Layout & rules

- One extension per `extensions/pi-<name>/`; shared code lives in
  [`extensions/_lib`](./extensions/_lib): number grammar, family style (glyphs,
  theme-derived ink, panel headers), ANSI helpers, chat-container detection, config
  convention. `_lib` has no `index.ts`, so pi's extension discovery skips it.
- pi resolves extension-relative imports against the symlink path, so local installs
  must link the extension *directories* plus `_lib`; `npm run link-extensions` does
  exactly that.
- [`docs/design-language.md`](./docs/design-language.md) specifies the visual grammar
  all three extensions speak. Record design changes there first, then implement; when a
  renderer and that document disagree, one of them is wrong.
- The contract suite pins every structural assumption about pi internals, so after
  `pi update` a quick `npm test` says exactly which seam (if any) drifted. Test design
  notes: [`docs/testing.md`](./docs/testing.md).
- Before changing Cachemire retention, read the dated
  [audit](./docs/cache-retention-audit-2026-08-04.md). `retention.ts` drives runtime
  resolution and generated policy docs; `cacheClock()` owns clock wording. Match the
  exact route, model and outgoing policy. Keep minimum and maximum semantics distinct,
  and leave unmatched routes unknown. Run `npm run docs:cache` after policy changes.
- Goldens regenerate with `UPDATE_GOLDENS=1 npm test`. Review the diff like code.
  Regenerate whenever rendering changes.
- README screenshots regenerate with the rig in
  [`scripts/dev/screenshots/`](./scripts/dev/screenshots/): real pi TUI in an isolated
  tmux/HOME; see its README for the recipe. The `cachemire` scenario makes live model
  calls (costs cents).
- Agent coding standards live in [`docs/agent-coding-standard.md`](./docs/agent-coding-standard.md)
  and are enforced by `scripts/dev/agent-lint.mjs` and `.oxlintrc.json`. Parse external
  data at its boundary, pass typed values inward, and document real escape hatches with
  `SAFETY:` comments. The baseline and legacy `internals` exports only shrink.
- Tests specify capabilities through Pi's SDK or stable domain-module APIs; do not
  expose private helpers for tests. See [`docs/testing.md`](./docs/testing.md).

## Style

- Vertical alignment is load-bearing, not cosmetic. Deliberate choices across the
  family: traceline's right-aligned fact/size suffix column and block-scoped
  truncation columns (design language §9.7/§9.8), contextimate's decimal-point
  and unit alignment for token counts and its table-like parameter columns,
  diff stats dropping their zero side, cachemire's ledger columns. When adding or
  changing a suffix or column, keep related rows sharing one aligned edge; never
  let a new cell wander the right margin row by row.

- No em dashes (—) in markdown docs. Use commas, colons, semicolons, or parentheses. <!-- agent-lint-disable-line POG007 -->
  (Quoted UI output is exempt: cachemire's ledger genuinely prints — for absent values.) <!-- agent-lint-disable-line POG007 -->

## Releasing

Bump `package.json` version + `CHANGELOG.md`, commit, tag `vX.Y.Z`, push with tags,
`npm publish`, then GitHub release notes (`gh release create`).
