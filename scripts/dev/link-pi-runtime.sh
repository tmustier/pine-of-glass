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

# Launchers may be a package symlink or a shell wrapper that invokes Pi from a path
# containing $HOME. Inspect both without executing the wrapper under a substituted HOME.
pi_real="$(readlink -f "$pi_bin")"
candidates=("$pi_real")
while IFS= read -r candidate; do
  candidate="${candidate/#\$HOME/$HOME}"
  candidate="${candidate/#\$\{HOME\}/$HOME}"
  candidate="${candidate/#\~/$HOME}"
  [[ -n "$candidate" ]] && candidates+=("$candidate")
done < <(grep -Eo '(\$HOME|\$\{HOME\}|~|/)[^"[:space:]]*node_modules/@earendil-works/pi-coding-agent' "$pi_real" || true)
npm_root="$(npm root -g 2>/dev/null || true)"
if [[ -n "$npm_root" ]]; then
  candidates+=("$npm_root/@earendil-works/pi-coding-agent")
fi
candidates+=("$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent")

pi_pkg=""
for candidate in "${candidates[@]}"; do
  probe="$candidate"
  while [[ "$probe" != "/" && "$(basename "$probe")" != "pi-coding-agent" ]]; do
    probe="$(dirname "$probe")"
  done
  if [[ -f "$probe/package.json" ]]; then
    pi_pkg="$probe"
    break
  fi
done
if [[ -z "$pi_pkg" ]]; then
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
