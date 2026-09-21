# Next release notes (draft)

- Development tooling: Oxlint with vendored anti-slop rules joins `npm run lint` as
  shrink-only baselined debt; `npm install` then `npm run link-pi` on fresh clones.
- Test policy: behaviour is specified through Pi's SDK or stable domain-module APIs via
  `tests/harness/extension-host.ts`; `internals` grab bags may not grow.
- Pi 0.86 compatibility: Contextimate reads structured prompt wrappers, Traceline
  validates converted-image identity, and Cachemire and Meantime distinguish logical
  agent calls from background cache warming. The minimum supported Pi version is now
  0.86.0.
- Cachemire includes persisted cache-warming usage in restored ledgers and lineage
  freshness, with warm calls labelled separately from user-initiated model calls.
