# Next release notes (draft)

- Development tooling: Oxlint with vendored anti-slop rules joins `npm run lint` as
  shrink-only baselined debt; `npm install` then `npm run link-pi` on fresh clones.
- Test policy: behaviour is specified through public interfaces via
  `tests/harness/extension-host.ts`; `internals` grab bags may not grow.
- Quality review: baseline updates refuse new debt; tests use Pi or stable domain APIs;
  generic lint rules are disabled where they make domain code less clear.
