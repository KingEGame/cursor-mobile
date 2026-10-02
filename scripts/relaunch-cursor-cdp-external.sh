#!/usr/bin/env bash
# EXTERNAL TERMINAL ONLY — do not run from inside a Cursor agent chat.
# Quits are operator-driven: this script never kills Cursor and never opens
# /tmp/cursor-mobile-cdp-profile (HARD BAN).
#
# Flow:
#   1. Operator quits THIS main Cursor (Ctrl+Q / File → Quit)
#   2. Press Enter in this terminal
#   3. Script starts the same main profile with CDP on 127.0.0.1:9222
#   4. Open Composer; watch:main-cdp-new-session auto-runs UAT when :9222 is up
#
# Usage (from an external terminal, after cd to repo):
#   npm run relaunch:cursor:cdp
#   # or:
#   ./scripts/relaunch-cursor-cdp-external.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${1:-${ROOT}}"
CDP_PORT="${CDP_PORT:-9222}"
CDP_HOST="127.0.0.1"
CDP_URL="http://${CDP_HOST}:${CDP_PORT}"
START_SCRIPT="${ROOT}/scripts/start-cursor-cdp.sh"

# HARD BAN: refuse any second-profile path / env.
for arg in "$@"; do
  case "${arg}" in
    --user-data-dir|--user-data-dir=*|*/cursor-mobile-cdp-profile*)
      echo "error: REFUSED — --user-data-dir / second profile is banned." >&2
      exit 3
      ;;
  esac
done
if [[ -n "${CURSOR_USER_DATA_DIR:-}" ]] || [[ -n "${ELECTRON_USER_DATA_DIR:-}" ]]; then
  echo "error: REFUSED — CURSOR_USER_DATA_DIR / ELECTRON_USER_DATA_DIR set; unset them." >&2
  exit 3
fi

if [[ ! -x "${START_SCRIPT}" ]] && [[ ! -f "${START_SCRIPT}" ]]; then
  echo "error: missing ${START_SCRIPT}" >&2
  exit 1
fi

cursor_running() {
  if pgrep -f '/usr/share/cursor/cursor( |$)' >/dev/null 2>&1; then
    return 0
  fi
  if pgrep -x cursor >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

notify_once() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send -a 'cursor-mobile' \
      'Relaunch Cursor with CDP' \
      "Quit this Cursor window, then press Enter in the external terminal. CDP → ${CDP_URL}. Watcher will auto-UAT." \
      || true
  fi
}

cat <<EOF
══════════════════════════════════════════════════════════════════
  EXTERNAL relaunch helper — MAIN Cursor CDP only (no second profile)
══════════════════════════════════════════════════════════════════

  CDP target:  ${CDP_URL} (loopback only)
  Workspace:   ${WORKSPACE}
  Start via:   ${START_SCRIPT}

  This script does NOT kill Cursor.
  HARD BAN: never /tmp/cursor-mobile-cdp-profile or any --user-data-dir.

  Steps:
    1. Quit THIS Cursor fully (Ctrl+Q / File → Quit)
    2. Press Enter here
    3. Cursor relaunches with CDP on ${CDP_HOST}:${CDP_PORT} (default profile)
    4. Open Composer in that same window
    5. If \`npm run watch:main-cdp-new-session\` is already running, it will
       auto-verify CDP and run New-session UAT (ATTACH_COUNT=2)

EOF

notify_once

if cursor_running; then
  echo "Cursor is currently RUNNING (PID(s) present)."
  echo "Quit Cursor first, then press Enter (script will not kill it)."
else
  echo "Cursor does not appear to be running — press Enter to start with CDP."
fi
echo

while true; do
  read -r -p "Press Enter after Cursor is fully quit (or Ctrl+C to abort)… " _
  if cursor_running; then
    echo
    echo "Cursor is still running. Quit it fully (Ctrl+Q), then press Enter again."
    echo "  (This helper never kills Cursor; never opens a second profile.)"
    echo
    continue
  fi
  break
done

echo
echo "Starting MAIN Cursor with CDP (same as npm run start:cursor:cdp)…"
echo "After launch: open Composer. watch:main-cdp-new-session will auto-UAT when ${CDP_URL} is up."
echo

# Same path as start:cursor:cdp — default profile only; workspace as trailing arg.
exec bash "${START_SCRIPT}" "${WORKSPACE}"
