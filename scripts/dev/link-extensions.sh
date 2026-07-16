#!/usr/bin/env bash
# Symlink this repo's extensions into ~/.pi/agent/extensions for local development.
#
# Extensions share code via extensions/_lib, and pi's jiti loader resolves relative
# imports against the symlink path (not the realpath). So each extension must be
# linked as a *directory*, with _lib linked alongside it — file symlinks to index.ts
# would break the ../_lib/* imports. _lib has no index.ts, so pi's extension
# discovery skips it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target_dir="${HOME}/.pi/agent/extensions"
mkdir -p "$target_dir"

# Remove pre-0.4.0 file symlinks, which cannot resolve ../_lib imports.
for legacy in pi-contextimate.ts pi-traceline.ts pi-cachemire.ts; do
  if [ -L "$target_dir/$legacy" ]; then
    rm "$target_dir/$legacy"
    echo "removed legacy file symlink: $target_dir/$legacy"
  fi
done

for name in _lib pi-contextimate pi-traceline pi-cachemire pi-meantime; do
  ln -sfn "$repo_root/extensions/$name" "$target_dir/$name"
  echo "linked $target_dir/$name -> $repo_root/extensions/$name"
done
