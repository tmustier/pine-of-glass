#!/usr/bin/env bash
# Symlink the globally installed Pi runtime into this repo's gitignored node_modules/
# so tests and `tsc --noEmit` resolve against the real installed Pi (drift detector).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pi_bin="$(command -v pi || true)"
if [[ -z "$pi_bin" ]]; then
  echo "error: pi not found on PATH" >&2
  exit 1
fi

# Resolve the installed package dir from the pi launcher symlink.
pi_real="$(readlink -f "$pi_bin")"
pi_pkg="$pi_real"
while [[ "$pi_pkg" != "/" && "$(basename "$pi_pkg")" != "pi-coding-agent" ]]; do
  pi_pkg="$(dirname "$pi_pkg")"
done
if [[ ! -f "$pi_pkg/package.json" ]]; then
  echo "error: could not locate pi-coding-agent package from $pi_bin" >&2
  exit 1
fi

mkdir -p "$repo_root/node_modules/@earendil-works" "$repo_root/node_modules/@types"
ln -sfn "$pi_pkg" "$repo_root/node_modules/@earendil-works/pi-coding-agent"
for dep in pi-tui pi-ai pi-agent-core; do
  src="$pi_pkg/node_modules/@earendil-works/$dep"
  if [[ -d "$src" ]]; then
    ln -sfn "$src" "$repo_root/node_modules/@earendil-works/$dep"
  fi
done
if [[ -d "$pi_pkg/node_modules/@types/node" ]]; then
  ln -sfn "$pi_pkg/node_modules/@types/node" "$repo_root/node_modules/@types/node"
fi

echo "linked Pi runtime from $pi_pkg"
