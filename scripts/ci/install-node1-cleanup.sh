#!/usr/bin/env bash
# From the operator PC: install the daily runner cleanup (systemd user timer) on node1 and harden the
# runner service so a restart cannot leave orphan listeners. Needs `ssh node1`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${NODE1_HOST:-node1}"

scp "$ROOT/scripts/ci/node1-runner-cleanup.sh" "$HOST:actions-runner-cleanup.sh"
ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
chmod +x ~/actions-runner-cleanup.sh
d=~/.config/systemd/user
mkdir -p "$d/github-runner.service.d"
cat > "$d/github-runner.service.d/kill-mode.conf" <<'EOF2'
[Service]
KillMode=control-group
TimeoutStopSec=30
# node1 gets its network from the PC after boot: keep retrying instead of staying dead.
Restart=always
RestartSec=15
EOF2
cat > "$d/runner-cleanup.service" <<'EOF2'
[Unit]
Description=Clean old GitHub Actions runner leftovers
[Service]
Type=oneshot
ExecStart=%h/actions-runner-cleanup.sh
EOF2
cat > "$d/runner-cleanup.timer" <<'EOF2'
[Unit]
Description=Daily GitHub Actions runner cleanup
[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
EOF2
systemctl --user daemon-reload
systemctl --user enable --now runner-cleanup.timer
systemctl --user list-timers runner-cleanup.timer --no-pager
REMOTE
