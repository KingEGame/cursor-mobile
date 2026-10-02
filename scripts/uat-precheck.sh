#!/usr/bin/env bash
# UAT precheck — green/red gates for PC-local cursor_mobile E2E readiness.
# Product locks: Tailscale mesh required; CDP stays 127.0.0.1; no USB reverse/ngrok path.
#
# No-CDP primary (default): CDP down is YELLOW, not a critical fail. Hub mesh +
# create-queue (CURSOR_DOWN → HTTP 202) is the P0 close path when the operator
# declines Cursor relaunch. Set REQUIRE_CDP=1 to restore metal/CDP-critical gate.
#
# Exit codes:
#   0 — all critical PC-side checks green (phone Tailscale peer may still be red)
#   1 — one or more critical PC-side checks failed
#   2 — usage / environment error
#
# Usage:
#   ./scripts/uat-precheck.sh
#   REQUIRE_CDP=1 ./scripts/uat-precheck.sh   # metal path (CDP critical)
#   PIXEL_SERIAL=33080DLH20007Y HUB_PORT=8787 ./scripts/uat-precheck.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_PORT="${HUB_PORT:-8787}"
CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
PIXEL_SERIAL="${PIXEL_SERIAL:-33080DLH20007Y}"
COMPANION_PKG="${COMPANION_PKG:-local.cursor.mobile}"
TAILSCALE_PKG="${TAILSCALE_PKG:-com.tailscale.ipn}"
SELECTOR_PACK="${SELECTOR_PACK:-${ROOT}/packages/adapters/live-cursor/src/selector-pack.ts}"
# Primary P0 close path does not require MAIN :9222 (operator may decline relaunch).
REQUIRE_CDP="${REQUIRE_CDP:-0}"
ALLOW_NO_CDP="${ALLOW_NO_CDP:-1}"
if [[ "${REQUIRE_CDP}" == "1" ]]; then
  ALLOW_NO_CDP=0
fi

GREEN=0
RED=0
YELLOW=0
CRITICAL_FAIL=0

pass() { GREEN=$((GREEN + 1)); printf '  [GREEN] %s\n' "$*"; }
fail() { RED=$((RED + 1)); CRITICAL_FAIL=$((CRITICAL_FAIL + 1)); printf '  [RED]   %s\n' "$*"; }
warn() { YELLOW=$((YELLOW + 1)); printf '  [YELLOW]%s\n' " $*"; }
info() { printf '  [----]  %s\n' "$*"; }

http_ok() {
  local url="$1"
  curl -sf --max-time 3 "${url}" >/dev/null 2>&1
}

echo "=== cursor_mobile UAT precheck ==="
echo "  repo:   ${ROOT}"
echo "  hub:    :${HUB_PORT}"
echo "  cdp:    ${CDP_URL}"
echo "  pixel:  ${PIXEL_SERIAL}"
echo

# --- Hub health (critical PC-side) ---
echo "-- Hub health"
TS_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
fi
TS_IP="${TS_IP:-100.91.47.68}"

if http_ok "http://127.0.0.1:${HUB_PORT}/health"; then
  pass "Hub loopback http://127.0.0.1:${HUB_PORT}/health"
else
  fail "Hub loopback http://127.0.0.1:${HUB_PORT}/health unreachable"
fi

if http_ok "http://${TS_IP}:${HUB_PORT}/health"; then
  pass "Hub mesh http://${TS_IP}:${HUB_PORT}/health"
else
  fail "Hub mesh http://${TS_IP}:${HUB_PORT}/health unreachable (need HUB_HOST=0.0.0.0 + Tailscale up)"
fi

# --- CDP (optional by default; critical only when REQUIRE_CDP=1) ---
echo "-- CDP"
if http_ok "${CDP_URL}/json/version" || http_ok "${CDP_URL}/json"; then
  pass "CDP up at ${CDP_URL}"
elif [[ "${ALLOW_NO_CDP}" == "1" ]]; then
  warn "CDP down at ${CDP_URL} — no-CDP primary OK (Hub create-queue 202 / CursorDown); REQUIRE_CDP=1 for metal gate"
else
  fail "CDP down at ${CDP_URL} — quit Cursor, npm run start:cursor:cdp, then npm run verify:cdp"
fi

# AC-001-02 / AC-X-02: CDP must stay loopback-only — Tailscale IP must NOT expose :9222
CDP_PORT="$(printf '%s' "${CDP_URL}" | sed -n 's|.*:\([0-9][0-9]*\).*|\1|p')"
CDP_PORT="${CDP_PORT:-9222}"
if [[ -n "${TS_IP}" ]]; then
  if http_ok "http://${TS_IP}:${CDP_PORT}/json/version" || http_ok "http://${TS_IP}:${CDP_PORT}/json"; then
    fail "CDP reachable on Tailscale IP http://${TS_IP}:${CDP_PORT} (must be 127.0.0.1 only — AC-001-02)"
  else
    pass "CDP not exposed on Tailscale IP :${CDP_PORT} (AC-001-02)"
  fi
fi

# --- Tailscale peers (phone presence is non-critical for PC exit; reported) ---
echo "-- Tailscale peers"
if ! command -v tailscale >/dev/null 2>&1; then
  fail "tailscale CLI missing on PC"
else
  pass "tailscale CLI present (PC mesh)"
  TS_STATUS="$(tailscale status 2>/dev/null || true)"
  if echo "${TS_STATUS}" | grep -qE 'kingwarpc|[[:space:]]linux[[:space:]]'; then
    pass "PC Tailscale peer online"
  else
    fail "PC Tailscale peer not visible in status"
  fi

  PHONE_ONLINE=0
  if echo "${TS_STATUS}" | grep -qiE '[[:space:]]android[[:space:]]' ; then
    while IFS= read -r line; do
      if echo "${line}" | grep -qi 'android' && ! echo "${line}" | grep -qi 'offline'; then
        PHONE_ONLINE=1
        pass "Android Tailscale peer online: $(echo "${line}" | awk '{print $1,$2}')"
      fi
    done <<< "$(echo "${TS_STATUS}" | grep -i android || true)"
  fi
  if (( PHONE_ONLINE == 0 )); then
    warn "No online Android Tailscale peer (Pixel must log in / join tailnet tail246b3f)"
    info "Pixel package may be installed but not yet on mesh — operator login required"
  fi
fi

# --- adb devices ---
echo "-- adb"
if ! command -v adb >/dev/null 2>&1; then
  warn "adb not on PATH — skip device package checks"
else
  ADB_OUT="$(adb devices 2>/dev/null || true)"
  if echo "${ADB_OUT}" | grep -qE "^${PIXEL_SERIAL}[[:space:]]+device"; then
    pass "Pixel ${PIXEL_SERIAL} authorized (device)"
  elif echo "${ADB_OUT}" | grep -qE "^${PIXEL_SERIAL}[[:space:]]+"; then
    fail "Pixel ${PIXEL_SERIAL} present but not authorized (state != device)"
  else
    warn "Pixel ${PIXEL_SERIAL} not listed in adb devices"
  fi

  if echo "${ADB_OUT}" | grep -qE '[[:space:]]device$'; then
    pass "At least one adb device authorized"
  else
    warn "No authorized adb devices"
  fi

  # --- APK packages on Pixel (when device present) ---
  if echo "${ADB_OUT}" | grep -qE "^${PIXEL_SERIAL}[[:space:]]+device"; then
    if adb -s "${PIXEL_SERIAL}" shell pm path "${COMPANION_PKG}" >/dev/null 2>&1; then
      pass "Companion APK present (${COMPANION_PKG})"
    else
      warn "Companion APK missing (${COMPANION_PKG}) — sideload release APK"
    fi
    if adb -s "${PIXEL_SERIAL}" shell pm path "${TAILSCALE_PKG}" >/dev/null 2>&1; then
      pass "Tailscale APK present (${TAILSCALE_PKG})"
    else
      warn "Tailscale APK missing (${TAILSCALE_PKG}) — install from pkgs.tailscale.com/stable"
    fi
  fi
fi

# --- Selector pack VERIFIED vs CANDIDATE ---
echo "-- Selector pack"
if [[ ! -f "${SELECTOR_PACK}" ]]; then
  fail "Selector pack file missing: ${SELECTOR_PACK}"
else
  ACTION_CAND="$(awk '
    /createDefaultSelectorPack/ {in_def=1}
    in_def && /^export function/ && !/createDefaultSelectorPack/ {in_def=0}
    in_def && /verification: "CANDIDATE"/ {c++}
    END {print c+0}
  ' "${SELECTOR_PACK}")"
  ACTION_VER="$(awk '
    /createDefaultSelectorPack/ {in_def=1}
    in_def && /^export function/ && !/createDefaultSelectorPack/ {in_def=0}
    in_def && /verification: "VERIFIED"/ {v++}
    END {print v+0}
  ' "${SELECTOR_PACK}")"

  info "default-pack actions: CANDIDATE=${ACTION_CAND} VERIFIED=${ACTION_VER}"
  if (( ACTION_CAND == 0 && ACTION_VER > 0 )); then
    pass "Selector pack all mutation actions VERIFIED"
  elif (( ACTION_VER > 0 )); then
    warn "Selector pack PARTIAL — ${ACTION_VER} VERIFIED, ${ACTION_CAND} still CANDIDATE"
  else
    warn "Selector pack all CANDIDATE — mutations fail-closed until npm run verify:cdp on live DOM"
  fi
fi

echo
echo "=== Summary: GREEN=${GREEN} RED=${RED} YELLOW=${YELLOW} ==="
info "mode: ALLOW_NO_CDP=${ALLOW_NO_CDP} REQUIRE_CDP=${REQUIRE_CDP}"
if (( CRITICAL_FAIL > 0 )); then
  echo "RESULT: FAIL (critical PC-side red)"
  echo "Unlock: Hub start:hub:tailscale · phone Tailscale login · (optional metal) Cursor CDP + verify:cdp"
  exit 1
fi
echo "RESULT: PASS (critical PC-side green; yellow = operator/phone/CDP follow-ups)"
exit 0
