#!/usr/bin/env bash
# Poll loopback CDP until up, then attach-probe + live selector match.
# Marks selector-pack VERIFIED only for high-confidence live DOM hits
# (send_message required; approve/deny if matched).
#
# Main Cursor ONLY (default profile) via operator quit → npm run start:cursor:cdp.
# HARD BAN: this script never starts Cursor and never opens a second profile.
#
# Does NOT kill Cursor. Does NOT flip VERIFIED without live matches.
#
# Usage (after quitting Cursor and starting with CDP on the main window):
#   npm run start:cursor:cdp
#   # open workspace + Composer in THAT window
#   npm run verify:cdp
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

CDP_HOST="127.0.0.1"
CDP_PORT="${CDP_PORT:-9222}"
CDP_URL="${CDP_URL:-http://${CDP_HOST}:${CDP_PORT}}"
TIMEOUT_SEC="${CDP_WAIT_TIMEOUT_SEC:-300}"
INTERVAL_SEC="${CDP_WAIT_INTERVAL_SEC:-5}"

echo "=== wait-cdp-and-verify ==="
echo "CDP:     ${CDP_URL}/json"
echo "Timeout: ${TIMEOUT_SEC}s (poll every ${INTERVAL_SEC}s)"
echo
echo "If CDP is down (main Cursor was started without --remote-debugging-port):"
echo "  1. Quit THIS Cursor fully (Ctrl+Q / File → Quit) — script will not kill it"
echo "  2. npm run start:cursor:cdp"
echo "     # or: ./scripts/start-cursor-cdp.sh ${ROOT}"
echo "  3. Reopen this workspace + open Composer in THAT main window"
echo "  4. Re-run: npm run verify:cdp"
echo
echo "This script will NOT kill Cursor. HARD BAN: never /tmp/cursor-mobile-cdp-profile (second window)."
echo

cdp_up() {
  curl -sf --max-time 2 "${CDP_URL}/json" >/dev/null 2>&1
}

elapsed=0
while ! cdp_up; do
  if (( elapsed >= TIMEOUT_SEC )); then
    cat <<EOF >&2
FAIL: CDP never came up at ${CDP_URL} within ${TIMEOUT_SEC}s.

Unlock path (main window — preferred):
  1. Quit Cursor fully (File → Quit / Ctrl+Q) — do not kill from this script.
  2. npm run start:cursor:cdp
  3. Reopen this workspace + open Composer in THAT window (not Agents Cloud).
  4. Re-run: npm run verify:cdp

Selector pack was NOT marked VERIFIED.
HARD BAN: do not open /tmp/cursor-mobile-cdp-profile — quit THIS Cursor only.
EOF
    exit 1
  fi
  printf 'waiting for CDP… %ss / %ss (ECONNREFUSED or empty)\n' "${elapsed}" "${TIMEOUT_SEC}"
  sleep "${INTERVAL_SEC}"
  elapsed=$((elapsed + INTERVAL_SEC))
done

echo
echo "CDP is up after ~${elapsed}s. Sample /json:"
curl -s --max-time 3 "${CDP_URL}/json" | head -c 400 || true
echo
echo

# Reuse existing attach-only probe (HTTP + extractor_stale while CANDIDATE).
echo "=== Live CDP attach probe (existing npm test) ==="
set +e
LIVE_CDP_PROBE=1 CDP_URL="${CDP_URL}" npm test -w @cursor-mobile/live-cursor -- src/cdp-probe.test.ts
PROBE_RC=$?
set -e
if (( PROBE_RC != 0 )); then
  echo >&2 "WARN: cdp-probe.test.ts exited ${PROBE_RC} — continuing to DOM selector match."
fi
echo

# Live DOM strategy match + optional pack write.
echo "=== Live selector match (high-confidence → VERIFIED) ==="
export CDP_URL
VERIFY_ARGS=(--write)
if [[ "${VERIFY_DRY_RUN:-}" == "1" || "${VERIFY_DRY_RUN:-}" == "true" ]]; then
  VERIFY_ARGS=()
  echo "(VERIFY_DRY_RUN set — will not write selector-pack.ts)"
fi

set +e
npx --yes tsx "${ROOT}/scripts/cdp-selector-verify.mts" "${VERIFY_ARGS[@]}"
VERIFY_RC=$?
set -e

if (( VERIFY_RC != 0 )); then
  cat <<EOF >&2

FAIL: selector verify exited ${VERIFY_RC}.
  Pack stays CANDIDATE unless high-confidence send_message matched and --write ran.
  Ensure Composer is visible on the CDP Cursor window, then re-run.
EOF
  exit "${VERIFY_RC}"
fi

cat <<EOF

=== Success path ===
Next:
  1. Restart Hub (reloads selector pack):  ./scripts/start-hub-tailscale.sh
  2. Send a test message from the phone / Hub.
  3. Spot-check Approve/Deny on PC if those actions were flipped.

Sender unlock requires: CDP up + send_message VERIFIED + Hub restarted.
EOF

exit 0
