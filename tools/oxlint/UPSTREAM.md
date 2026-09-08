# Vendored oxlint plugins

## anti-slop

- Source: https://github.com/dmmulroy/anti-slop
- Copied from upstream commit `95a56e5d24fb3d849673c2d51eb0908b8bd2d33b` (`skills/install-anti-slop/assets/anti-slop`, which is upstream `src/` without its `*.test.ts` files) on 2026-09-08.
- Installed at `tools/oxlint/anti-slop/` and registered in `.oxlintrc.json` as the `anti-slop` plugin.
- `oxlint` and `@oxlint/plugins` are pinned to the same exact version in `package.json`; the plugin imports `@oxlint/plugins`, whose API tracks oxlint. Bump both together.
- Intentional deviations from upstream: the opt-in `effect/` plugin is not vendored because this repo does not use Effect. The generic rule files are unmodified. Rule selection and reasons live in `.oxlintrc.json`.
- To update: fetch the desired upstream revision, diff `src/` against this directory, port reviewed changes, and replace the commit hash above.
