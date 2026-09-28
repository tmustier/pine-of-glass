#!/usr/bin/env bash
# Optional: replace the pinned Pi dev dependencies with links to the globally installed Pi,
# so checks run against the Pi you use. `npm install` restores the pinned versions.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Every `pi` on PATH, skipping this repo's own (npm run puts node_modules/.bin first) and
# wrappers that name no pi-coding-agent path.
candidates=()
while IFS= read -r pi_bin; do
  pi_real="$(readlink -f "$pi_bin")"
  [[ "$pi_real" == "$repo_root"/* ]] && continue
  candidates+=("$pi_real")
  while IFS= read -r candidate; do
    candidate="${candidate/#\$HOME/$HOME}"
    candidate="${candidate/#\$\{HOME\}/$HOME}"
    candidate="${candidate/#\~/$HOME}"
    candidates+=("$candidate")
  done < <(grep -Eo '(\$HOME|\$\{HOME\}|~|/)[^"[:space:]]*node_modules/@earendil-works/pi-coding-agent' "$pi_real" || true)
done < <(which -a pi)
if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "error: no installed pi found on PATH" >&2
  exit 1
fi

pi_pkg=""
for candidate in "${candidates[@]}"; do
  case "$candidate" in
    */pi-coding-agent) pi_pkg="$candidate" ;;
    */pi-coding-agent/*) pi_pkg="${candidate%%/pi-coding-agent/*}/pi-coding-agent" ;;
  esac
  [[ -f "$pi_pkg/package.json" && "$pi_pkg" != "$repo_root"/* ]] && break
  pi_pkg=""
done
if [[ -z "$pi_pkg" ]]; then
  echo "error: could not locate an installed pi-coding-agent package from pi on PATH" >&2
  exit 1
fi

mkdir -p "$repo_root/node_modules/@earendil-works" "$repo_root/node_modules/@types"
link() {
  rm -rf "$2"
  ln -s "$1" "$2"
}
link "$pi_pkg" "$repo_root/node_modules/@earendil-works/pi-coding-agent"
for dep in pi-tui pi-ai pi-agent-core; do
  src="$pi_pkg/node_modules/@earendil-works/$dep"
  [[ -d "$src" ]] && link "$src" "$repo_root/node_modules/@earendil-works/$dep"
done
if [[ -d "$pi_pkg/node_modules/@types/node" ]]; then
  link "$pi_pkg/node_modules/@types/node" "$repo_root/node_modules/@types/node"
fi

echo "linked Pi runtime from $pi_pkg"
