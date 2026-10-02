#!/usr/bin/env bash
# PRIMARY CDP path only: relaunch the operator's MAIN Cursor window with loopback CDP.
# Does NOT kill a running Cursor session — quit first, then re-run this script.
# Does NOT open /tmp/cursor-mobile-cdp-profile or any second window.
#
# Operator steps:
#   1. Quit Cursor fully (Ctrl+Q / File → Quit)
#   2. npm run start:cursor:cdp -- /path/to/workspace
#   3. Open Composer in that same main window
#   4. npm run verify:cdp
#
# Product locks: CDP binds 127.0.0.1 only; phone never dials CDP; PC-local Hub.
set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
CDP_HOST="127.0.0.1"
CDP_URL="http://${CDP_HOST}:${CDP_PORT}"

resolve_cursor_bin() {
  if [[ -x /usr/share/cursor/cursor ]]; then
    printf '%s\n' /usr/share/cursor/cursor
    return 0
  fi
  if command -v cursor >/dev/null 2>&1; then
    command -v cursor
    return 0
  fi
  return 1
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE ":${CDP_PORT}[[:space:]]"
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${CDP_PORT}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

cursor_running() {
  # Match the app binary / common process name; avoid matching this script.
  if pgrep -f '/usr/share/cursor/cursor( |$)' >/dev/null 2>&1; then
    return 0
  fi
  if pgrep -x cursor >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

if ! CURSOR_BIN="$(resolve_cursor_bin)"; then
  echo "error: Cursor binary not found." >&2
  echo "  Expected /usr/share/cursor/cursor or \`cursor\` on PATH." >&2
  exit 1
fi

# HARD BAN first: never pass --user-data-dir (any path), even if Cursor is already up.
for arg in "$@"; do
  case "${arg}" in
    --user-data-dir|--user-data-dir=*|*/cursor-mobile-cdp-profile*)
      echo "error: REFUSED — --user-data-dir / second profile is banned." >&2
      echo "  CDP = this main Cursor only after a full quit." >&2
      echo "  Do: Quit Cursor → npm run start:cursor:cdp  (no alternate profile)." >&2
      exit 3
      ;;
  esac
done
if [[ -n "${CURSOR_USER_DATA_DIR:-}" ]] || [[ -n "${ELECTRON_USER_DATA_DIR:-}" ]]; then
  echo "error: REFUSED — CURSOR_USER_DATA_DIR / ELECTRON_USER_DATA_DIR set; unset them." >&2
  exit 3
fi

echo "Cursor binary: ${CURSOR_BIN}"
echo "CDP target:    ${CDP_URL} (loopback only)"
echo "Mode:          PRIMARY (main Cursor window / default profile — no second window)"
echo

if cursor_running; then
  cat <<'EOF' >&2
error: Cursor appears to be running already.

This script will NOT quit or kill your session.
It will NOT open a second /tmp profile window.

Quit Cursor first, then re-run (same main window + workspace):
  • Menu: File → Quit  (or Cursor → Quit on some builds)
  • Linux shortcut: Ctrl+Q

After a full quit:
  npm run start:cursor:cdp -- /data/projects/cursor_mobile
  # Open Composer in that window → npm run verify:cdp

EOF
  exit 2
fi

if port_in_use; then
  cat <<EOF >&2
warning: port ${CDP_PORT} already has a listener.
  If another debugger owns it, Cursor may fail to bind CDP.
  Check:  ss -ltn | grep ${CDP_PORT}
  Verify: curl -s ${CDP_URL}/json | head

EOF
fi

cat <<EOF
Starting Cursor with:
  --remote-debugging-port=${CDP_PORT}
  --remote-debugging-address=${CDP_HOST}
  (default profile — main window; no --user-data-dir)

After Cursor is up, open Composer in this window, then verify CDP:
  curl -s ${CDP_URL}/json | head
  ss -ltn | grep ${CDP_PORT}   # expect 127.0.0.1 only
  npm run verify:cdp

Hub should use: CDP_URL=${CDP_URL}
Never expose this port on Tailscale/LAN. Phone never dials CDP.

EOF

# Default profile only — never --user-data-dir=/tmp/cursor-mobile-cdp-profile.
exec "${CURSOR_BIN}" \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address="${CDP_HOST}" \
  "$@"
