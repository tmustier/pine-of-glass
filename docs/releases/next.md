# Next release notes (draft)

- Development tooling: Oxlint with vendored anti-slop rules joins `npm run lint` as
  shrink-only baselined debt; `npm install` then `npm run link-pi` on fresh clones.
- Test policy: behaviour is specified through public interfaces via
  `tests/harness/extension-host.ts`; `internals` grab bags may not grow.
- Quality review: baseline updates refuse new debt; typed union narrowing stays legal;
  the test host enforces shared-project ownership and fails on caught handler errors.
- Internal rename: tool payload helpers use `numerator`/`ToolDefinition`; the
  fallback label reads `Unknown tool numerator`.
