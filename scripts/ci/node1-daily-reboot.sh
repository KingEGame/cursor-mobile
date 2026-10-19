#!/usr/bin/env bash
# Reboot node1 once a day (installed as a root systemd timer by install-node1-reboot.sh).
# Waits (up to 90 min) for a running CI job to finish instead of killing it.
set -uo pipefail
for _ in $(seq 1 90); do
  pgrep -f "Runner.Worker" >/dev/null || break
  sleep 60
done
logger -t node1-daily-reboot "rebooting"
exec systemctl reboot
