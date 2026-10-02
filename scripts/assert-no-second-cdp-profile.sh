#!/usr/bin/env bash
# Assert no second CDP profile Cursor is running. Exit 1 if found.
# Kill-only helper: SECOND_CDP_KILL=1 kills matching Cursor PIDs (never ~/.config/Cursor).
#
# HARD BAN: agents must never launch:
#   /usr/share/cursor/cursor ... --user-data-dir=/tmp/cursor-mobile-cdp-profile
# Operator path only: quit THIS Cursor → npm run start:cursor:cdp
set -euo pipefail

PROFILE="${CDP_PROFILE:-/tmp/cursor-mobile-cdp-profile}"
MARKER="user-data-dir=${PROFILE}"

list_second_cursor_pids() {
  # Cursor binary only — ignore shells/python whose argv merely mentions the marker.
  ps -eo pid=,args= 2>/dev/null | while IFS= read -r line; do
    # Trim leading spaces from `pid=,args=` so ${line%% *} is not empty.
    line="${line#"${line%%[![:space:]]*}"}"
    case "${line}" in
      *"/usr/share/cursor/cursor"*"${MARKER}"*|*"$(command -v cursor 2>/dev/null || true)"*"${MARKER}"*)
        # Exclude tooling wrappers that embed the marker in a heredoc/script text
        case "${line}" in
          *extglob*|*assert-no-second*|*HARD_BAN*|*pgrep*|*python3\ -c*)
            continue
            ;;
        esac
        # Must look like an actual Cursor process (root or --type= child)
        case "${line}" in
          /usr/share/cursor/cursor\ *|*/usr/share/cursor/cursor\ *|*/usr/share/cursor/cursor\ --*)
            echo "${line%% *}"
            ;;
        esac
        ;;
    esac
  done | sort -u | grep -E '^[0-9]+$' || true
}

mapfile -t REAL < <(list_second_cursor_pids)

if ((${#REAL[@]} == 0)); then
  echo "OK: zero Cursor processes with ${MARKER}"
  exit 0
fi

echo "FOUND second-profile Cursor PIDs: ${REAL[*]}"
ps -p "$(IFS=,; echo "${REAL[*]}")" -o pid,args= 2>/dev/null || true

if [[ "${SECOND_CDP_KILL:-0}" == "1" ]]; then
  # shellcheck disable=SC2086
  kill ${REAL[*]} 2>/dev/null || true
  sleep 2
  mapfile -t STILL < <(list_second_cursor_pids)
  if ((${#STILL[@]} > 0)); then
    # shellcheck disable=SC2086
    kill -9 ${STILL[*]} 2>/dev/null || true
  fi
  echo "Killed second-profile Cursor only (main ~/.config/Cursor untouched)"
  exit 0
fi

echo "FAIL: second CDP profile running — kill with: SECOND_CDP_KILL=1 npm run assert:no-second-cdp" >&2
echo "Operator CDP path: quit THIS Cursor → npm run start:cursor:cdp (no --user-data-dir)" >&2
exit 1
