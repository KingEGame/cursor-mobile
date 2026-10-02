#!/usr/bin/env bash
# Install + start the Hub as a systemd *user* service (starts at login, restarts on crash).
#   npm run hub:service:install      # install/refresh and start
#   systemctl --user status cursor-mobile-hub
#   journalctl --user -u cursor-mobile-hub -f
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "${UNIT_DIR}"

(cd "${REPO_ROOT}" && npm run build)
sed "s#__REPO_ROOT__#${REPO_ROOT}#g" "${REPO_ROOT}/scripts/systemd/cursor-mobile-hub.service" \
  > "${UNIT_DIR}/cursor-mobile-hub.service"

systemctl --user daemon-reload
systemctl --user enable cursor-mobile-hub.service
systemctl --user restart cursor-mobile-hub.service
sleep 2
systemctl --user --no-pager status cursor-mobile-hub.service | head -n 5
