# Next release notes (draft)

- Development tooling: Oxlint with vendored anti-slop rules joins `npm run lint` as
  shrink-only baselined debt; `npm install` then `npm run link-pi` on fresh clones.
- Test policy: behaviour is specified through Pi's SDK or stable domain-module APIs via
  `tests/harness/extension-host.ts`; `internals` grab bags may not grow.
