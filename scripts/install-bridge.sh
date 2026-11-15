#!/usr/bin/env bash
# Point the Hermes plugin dir at this repo's server code (one source of truth, versioned in git).
#   bash scripts/install-bridge.sh            # link, keeps a backup of an existing plugin dir
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server/phone_bridge" && pwd)"
DST="$HOME/.hermes/plugins/phone_bridge"
if [ -L "$DST" ]; then
  echo "already linked: $DST -> $(readlink "$DST")"; exit 0
fi
if [ -e "$DST" ]; then
  BAK="$DST.bak-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$HOME/.hermes/backups" && BAK="$HOME/.hermes/backups/$(basename "$BAK")" && mv "$DST" "$BAK" && echo "backup: $BAK (outside plugins/ so Hermes does not load it)"
fi
ln -s "$SRC" "$DST" && echo "linked: $DST -> $SRC"
echo "then: hermes plugins enable phone-bridge && systemctl --user restart hermes-gateway"
