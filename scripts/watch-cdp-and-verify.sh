#!/usr/bin/env bash
# Long-poll loopback CDP, then run the same verify path as wait-cdp-and-verify.
# Safe to leave running until the main Cursor is relaunched with CDP; Ctrl+C exits cleanly.
#
# Main Cursor ONLY via operator quit → npm run start:cursor:cdp (default profile).
# HARD BAN: never starts Cursor; never opens /tmp/cursor-mobile-cdp-profile.
#
# Does NOT kill Cursor. Does NOT flip VERIFIED without live DOM matches.
#
# Usage:
#   ./scripts/watch-cdp-and-verify.sh
#   npm run watch:cdp
#
# Env:
#   CDP_URL                 default http://127.0.0.1:9222
#   CDP_WATCH_INTERVAL_SEC  poll interval while waiting (default 20)
#   CDP_WATCH_MAX_HOURS     optional cap; 0 or unset = until success / Ctrl+C
#   VERIFY_DRY_RUN=1        pass through — verify without writing selector-pack.ts
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

CDP_HOST="127.0.0.1"
CDP_PORT="${CDP_PORT:-9222}"
CDP_URL="${CDP_URL:-http://${CDP_HOST}:${CDP_PORT}}"
INTERVAL_SEC="${CDP_WATCH_INTERVAL_SEC:-20}"
MAX_HOURS="${CDP_WATCH_MAX_HOURS:-0}"
PACK_FILE="${ROOT}/packages/adapters/live-cursor/src/selector-pack.ts"

# Clamp interval to a sane 15–30s band unless operator overrides outside.
if (( INTERVAL_SEC < 5 )); then
  INTERVAL_SEC=5
fi

loud() {
  printf '\n'
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '! %s\n' "$*"
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '\n'
}

# Same scope as uat-precheck: only actions inside createDefaultSelectorPack().
count_verified() {
  if [[ ! -f "${PACK_FILE}" ]]; then
    echo 0
    return
  fi
  awk '
    /createDefaultSelectorPack/ {in_def=1}
    in_def && /^export function/ && !/createDefaultSelectorPack/ {in_def=0}
    in_def && /verification: "VERIFIED"/ {v++}
    END {print v+0}
  ' "${PACK_FILE}"
}

cdp_up() {
  curl -sf --max-time 2 "${CDP_URL}/json" >/dev/null 2>&1
}

trap 'echo; echo "watch:cdp interrupted (Ctrl+C) — selector pack unchanged by this watch loop."; exit 130' INT TERM

echo "=== watch-cdp-and-verify ==="
echo "CDP:      ${CDP_URL}/json"
echo "Interval: ${INTERVAL_SEC}s"
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  echo "Max:      ${MAX_HOURS}h (then exit 1 if CDP never up / verify fails)"
else
  echo "Max:      none (until CDP up + verify succeeds, or Ctrl+C)"
fi
echo
echo "If CDP is down: quit Cursor (Ctrl+Q), then:"
echo "  ./scripts/start-cursor-cdp.sh ${ROOT}"
echo "  # Open Composer in that Cursor window — this watcher will pick it up."
echo
echo "This script will NOT kill Cursor. Ctrl+C is safe."
echo

VERIFIED_BEFORE="$(count_verified)"
echo "Selector pack VERIFIED count (start): ${VERIFIED_BEFORE}"
echo

elapsed=0
max_sec=0
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  # bash arithmetic: hours → seconds (supports integer hours)
  max_sec=$(( MAX_HOURS * 3600 ))
fi

while ! cdp_up; do
  if (( max_sec > 0 && elapsed >= max_sec )); then
    cat <<EOF >&2
FAIL: CDP never came up at ${CDP_URL} within ${MAX_HOURS}h.

Unlock path:
  1. Quit Cursor fully (File → Quit / Ctrl+Q).
  2. ./scripts/start-cursor-cdp.sh ${ROOT}
  3. Open the project + Composer UI.
  4. Re-run: npm run watch:cdp   (or npm run verify:cdp once CDP is up)

Selector pack was NOT marked VERIFIED.
EOF
    exit 1
  fi
  printf 'watching for CDP… %ss elapsed (poll every %ss) — ECONNREFUSED or empty\n' \
    "${elapsed}" "${INTERVAL_SEC}"
  sleep "${INTERVAL_SEC}"
  elapsed=$((elapsed + INTERVAL_SEC))
done

loud "CDP IS UP at ${CDP_URL} after ~${elapsed}s — running verify path"

echo "Sample /json:"
curl -s --max-time 3 "${CDP_URL}/json" | head -c 400 || true
echo
echo

# Same verify path as wait-cdp-and-verify / verify:cdp
echo "=== Live CDP attach probe (existing npm test) ==="
set +e
LIVE_CDP_PROBE=1 CDP_URL="${CDP_URL}" npm test -w @cursor-mobile/live-cursor -- src/cdp-probe.test.ts
PROBE_RC=$?
set -e
if (( PROBE_RC != 0 )); then
  echo >&2 "WARN: cdp-probe.test.ts exited ${PROBE_RC} — continuing to DOM selector match."
fi
echo

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

VERIFIED_AFTER="$(count_verified)"

if (( VERIFY_RC != 0 )); then
  cat <<EOF >&2

FAIL: selector verify exited ${VERIFY_RC}.
  Pack stays CANDIDATE unless high-confidence send_message matched and --write ran.
  Ensure Composer is visible on the CDP Cursor window, then re-run npm run watch:cdp
  (or npm run verify:cdp).
EOF
  echo "Selector pack VERIFIED count (end): ${VERIFIED_AFTER} (was ${VERIFIED_BEFORE})"
  exit "${VERIFY_RC}"
fi

if (( VERIFIED_AFTER > VERIFIED_BEFORE )); then
  loud "VERIFIED FLIPPED: ${VERIFIED_BEFORE} → ${VERIFIED_AFTER} action(s) now VERIFIED"
elif (( VERIFIED_AFTER > 0 )); then
  loud "VERIFY OK — VERIFIED count still ${VERIFIED_AFTER} (no new flips this run)"
else
  loud "VERIFY EXITED 0 but VERIFIED count is still 0 — check Composer visibility / match log"
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
