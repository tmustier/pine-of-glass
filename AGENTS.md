# pine-of-glass — agent notes

Three pi extensions (`contextimate`, `traceline`, `cachemire`) sharing one design
language. TypeScript, zero runtime dependencies, tests on `node:test`.

## Commands

```bash
npm run link-pi         # symlink the installed pi runtime into node_modules (types + contract tests) — run first on a fresh clone
npm run link-extensions # symlink the extensions (as directories) into ~/.pi/agent/extensions
npm run typecheck       # tsc against the real installed pi
npm test                # unit + golden + pi contract tests (zero deps, node:test)
npm run test:smoke      # launches real pi in tmux with an isolated HOME (local-only)
```

## Layout & rules

- One extension per `extensions/pi-<name>/`; shared code lives in
  [`extensions/_lib`](./extensions/_lib) (number grammar, family style — glyphs,
  theme-derived ink, panel headers — ANSI helpers, chat-container detection, config
  convention). `_lib` has no `index.ts`, so pi's extension discovery skips it.
- pi resolves extension-relative imports against the symlink path, so local installs
  must link the extension *directories* plus `_lib` — `npm run link-extensions` does
  exactly that.
- [`docs/design-language.md`](./docs/design-language.md) specifies the visual grammar
  all three extensions speak. Record design changes there first, then implement; when a
  renderer and that document disagree, one of them is wrong.
- The contract suite pins every structural assumption about pi internals, so after
  `pi update` a quick `npm test` says exactly which seam (if any) drifted. Test design
  notes: [`docs/testing.md`](./docs/testing.md).
- Goldens regenerate with `UPDATE_GOLDENS=1 npm test` — review the diff like code.
  Regenerate whenever rendering changes.
- README screenshots regenerate with the rig in
  [`scripts/dev/screenshots/`](./scripts/dev/screenshots/) — real pi TUI in an isolated
  tmux/HOME; see its README for the recipe. The `cachemire` scenario makes live model
  calls (costs cents).

## Releasing

Bump `package.json` version + `CHANGELOG.md`, commit, tag `vX.Y.Z`, push with tags,
`npm publish`, then GitHub release notes (`gh release create`).
