#!/usr/bin/env bash
# Link the installed Pi runtime into this repo for type and contract checks.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pi_bin="$(command -v pi || true)"
if [[ -z "$pi_bin" ]]; then
  echo "error: pi not found on PATH" >&2
  exit 1
fi

pi_real="$(readlink -f "$pi_bin")"
candidates=("$pi_real")
while IFS= read -r candidate; do
  candidate="${candidate/#\$HOME/$HOME}"
  candidate="${candidate/#\$\{HOME\}/$HOME}"
  candidate="${candidate/#\~/$HOME}"
  candidates+=("$candidate")
done < <(grep -Eo '(\$HOME|\$\{HOME\}|~|/)[^"[:space:]]*node_modules/@earendil-works/pi-coding-agent' "$pi_real" || true)

pi_pkg=""
for candidate in "${candidates[@]}"; do
  case "$candidate" in
    */pi-coding-agent) pi_pkg="$candidate" ;;
    */pi-coding-agent/*) pi_pkg="${candidate%%/pi-coding-agent/*}/pi-coding-agent" ;;
  esac
  [[ -f "$pi_pkg/package.json" ]] && break
  pi_pkg=""
done
if [[ -z "$pi_pkg" ]]; then
  echo "error: could not locate pi-coding-agent package from $pi_bin" >&2
  exit 1
fi

mkdir -p "$repo_root/node_modules/@earendil-works" "$repo_root/node_modules/@types"
ln -sfn "$pi_pkg" "$repo_root/node_modules/@earendil-works/pi-coding-agent"
for dep in pi-tui pi-ai pi-agent-core; do
  src="$pi_pkg/node_modules/@earendil-works/$dep"
  [[ -d "$src" ]] && ln -sfn "$src" "$repo_root/node_modules/@earendil-works/$dep"
done
if [[ -d "$pi_pkg/node_modules/@types/node" ]]; then
  ln -sfn "$pi_pkg/node_modules/@types/node" "$repo_root/node_modules/@types/node"
fi

echo "linked Pi runtime from $pi_pkg"
