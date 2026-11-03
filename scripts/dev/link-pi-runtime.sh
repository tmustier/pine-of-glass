#!/usr/bin/env bash
# Optional: replace the pinned Pi dev dependencies with links to the globally installed Pi,
# so checks run against the Pi you use. `npm install` restores the pinned versions.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# npm knows the installed package; PATH may contain wrappers or checkout-local Pi bins.
global_root="$(npm root --global)"
pi_pkg="$global_root/@earendil-works/pi-coding-agent"
if [[ ! -f "$pi_pkg/package.json" ]]; then
  echo "error: no installed Pi package at $pi_pkg; install with npm install -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi
# Canonicalize before comparing or deleting anything, including /tmp aliases on macOS.
pi_pkg="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$pi_pkg")"
if [[ "$pi_pkg" == "$repo_root" || "$pi_pkg" == "$repo_root"/* ]]; then
  echo "error: installed Pi resolves inside the current worktree: $pi_pkg" >&2
  exit 1
fi
checkout_root="$repo_root"
while :; do
  if [[ "$pi_pkg" == "$checkout_root/node_modules/"* ]]; then
    echo "error: installed Pi resolves inside a checkout's node_modules: $pi_pkg" >&2
    exit 1
  fi
  [[ "$checkout_root" == / ]] && break
  checkout_root="$(dirname "$checkout_root")"
done

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
