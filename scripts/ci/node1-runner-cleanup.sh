#!/usr/bin/env bash
# Daily housekeeping for the self-hosted Actions runner on node1 (installed by install-node1-cleanup.sh).
# Never touches a runner that is executing a job: exits early when a Runner.Worker exists.
set -uo pipefail
RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner}"
SERVICE="${RUNNER_SERVICE:-github-runner.service}"
log() { echo "$(date -Is) $*"; }

if pgrep -f "Runner.Worker" >/dev/null; then
  log "job running, skipping cleanup"
  exit 0
fi

# 1. Orphaned listeners: systemd leaves old Runner.Listener trees behind on restart. If more than one
#    exists, restart the service cleanly (stop kills the whole control group with KillMode=control-group).
listeners="$(pgrep -fc "$RUNNER_DIR/bin/Runner.Listener" || true)"
if [ "${listeners:-0}" -gt 1 ]; then
  log "found $listeners runner listeners, restarting $SERVICE"
  systemctl --user stop "$SERVICE"
  pkill -f "$RUNNER_DIR/bin/Runner.Listener" 2>/dev/null; pkill -f "$RUNNER_DIR/run-helper.sh" 2>/dev/null
  sleep 3
  pkill -9 -f "$RUNNER_DIR/bin/Runner.Listener" 2>/dev/null
  systemctl --user start "$SERVICE"
fi

# 2. Stale runner files (these collide when a previous run died mid-write).
find "$RUNNER_DIR/_diag" -type f -mtime +3 -delete 2>/dev/null
find "$RUNNER_DIR/_work/_temp" -mindepth 1 -mtime +1 -delete 2>/dev/null
find "$RUNNER_DIR/_work/_actions" -mindepth 2 -maxdepth 2 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null

# 3. Build leftovers of finished jobs (checkout re-creates them): packaged apps and extracted AppImages.
for ws in "$RUNNER_DIR"/_work/*/*; do
  [ -d "$ws" ] && rm -rf "$ws/dist-desktop" "$ws/dist-apk" "$ws/.gate" 2>/dev/null
done
find /tmp -maxdepth 1 \( -name 'appimage_extracted_*' -o -name 'hub-smoke-*' \) -mtime +1 -exec rm -rf {} + 2>/dev/null

log "cleanup done; disk free: $(df -h --output=avail "$RUNNER_DIR" | tail -1 | tr -d ' ')"
