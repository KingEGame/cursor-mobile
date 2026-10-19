#!/usr/bin/env bash
# From the operator PC: schedule a daily reboot of node1 at 05:00 America/New_York (the operator's local time;
# node1 itself runs on UTC, so the zone is pinned in the timer). Asks for the sudo password on node1.
# PREREQUISITE: node1 must come back with a working network on its own (static IP in netplan), otherwise
# every reboot risks the DHCP failure we saw on 2026-10-18.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${NODE1_HOST:-node1-lan}"

scp "$ROOT/scripts/ci/node1-daily-reboot.sh" "$HOST:/tmp/node1-daily-reboot.sh"
ssh -t "$HOST" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
install -m 755 /tmp/node1-daily-reboot.sh /usr/local/sbin/node1-daily-reboot
cat > /etc/systemd/system/node1-daily-reboot.service <<'EOF2'
[Unit]
Description=Daily reboot of node1
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/node1-daily-reboot
TimeoutStartSec=infinity
EOF2
cat > /etc/systemd/system/node1-daily-reboot.timer <<'EOF2'
[Unit]
Description=Daily reboot of node1 at 05:00 New York time
[Timer]
OnCalendar=*-*-* 05:00:00 America/New_York
Persistent=false
[Install]
WantedBy=timers.target
EOF2
systemctl daemon-reload
systemctl enable --now node1-daily-reboot.timer
systemctl list-timers node1-daily-reboot.timer --no-pager
REMOTE
