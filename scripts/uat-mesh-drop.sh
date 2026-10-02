#!/usr/bin/env bash
# UAT mesh-drop (AC-003-01) — honest PARTIAL evidence without operator VPN UI.
#
# Uses Tailscale Android broadcast intents:
#   com.tailscale.ipn.DISCONNECT_VPN / CONNECT_VPN → IPNReceiver
# Does NOT force-stop Tailscale APK, kill main Cursor, or leave mesh down.
#
# Expected APK Health after disconnect + Refresh:
#   State: TailscaleDown · "Cannot reach Hub — open Tailscale…"
#
# Usage:
#   ./scripts/uat-mesh-drop.sh
#   PIXEL_SERIAL=… ./scripts/uat-mesh-drop.sh
#
# Exit: 0 on PASS_PARTIAL (TailscaleDown UX) + mesh restored; 1 otherwise.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

PIXEL_SERIAL="${PIXEL_SERIAL:-33080DLH20007Y}"
COMPANION_PKG="${COMPANION_PKG:-local.cursor.mobile}"
TS_PKG="${TS_PKG:-com.tailscale.ipn}"
PEER_HOST="${PEER_HOST:-pixel-7}"
EVID_DIR="${EVID_DIR:-/tmp/ac00301-evidence}"

PASS=0
FAIL=0
RESULTS=()

log() { printf '[uat-mesh] %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); RESULTS+=("PASS  $*"); log "PASS  $*"; }
fail() { FAIL=$((FAIL + 1)); RESULTS+=("FAIL  $*"); log "FAIL  $*"; }

adb_bin() { adb -s "${PIXEL_SERIAL}" "$@"; }

ui_dump() {
  # uiautomator dump can race — retry until hierarchy is non-empty (see adb-live-chat-send-uat).
  local xml=""
  local i
  for i in 1 2 3 4 5; do
    adb_bin shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
    sleep 2
    xml="$(adb_bin shell cat /sdcard/ui.xml 2>/dev/null || true)"
    if printf '%s' "${xml}" | grep -q 'hierarchy'; then
      printf '%s' "${xml}"
      return 0
    fi
    sleep 1
  done
  printf '%s' "${xml}"
}

ui_blob() {
  printf '%s' "$1" | python3 -c '
import re, sys
xml = sys.stdin.read()
parts = []
for m in re.finditer(r"(?:text|content-desc)=\"([^\"]*)\"", xml):
    t = m.group(1).strip()
    if t:
        parts.append(t)
print("\n".join(parts))
'
}

tap_resource() {
  local rid="$1"
  local xml center
  xml="$(ui_dump)"
  center="$(printf '%s' "${xml}" | RID="${rid}" python3 - <<'PY'
import os, re, sys
xml = sys.stdin.read()
rid = os.environ["RID"]
patterns = [
    rf'resource-id="{re.escape(rid)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
    rf'content-desc="Refresh health"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
]
m = None
for pat in patterns:
    m = re.search(pat, xml)
    if m:
        break
if not m:
    raise SystemExit(1)
x1, y1, x2, y2 = map(int, m.groups())
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
)" || {
    # Fallback: known Refresh button center on Pixel 7 Health scroll (when dump races).
    if [[ "${rid}" == "health-refresh" ]]; then
      log "tap fallback health-refresh @540,1158"
      adb_bin shell input tap 540 1158
      return 0
    fi
    return 1
  }
  read -r x y <<<"${center}"
  adb_bin shell input tap "${x}" "${y}"
  log "tap ${rid} @${x},${y}"
}

open_health() {
  adb_bin shell am start -a android.intent.action.VIEW \
    -d 'cursor-companion://health' "${COMPANION_PKG}" >/dev/null 2>&1 || true
  sleep 2
}

ts_broadcast() {
  local action="$1"
  adb_bin shell am broadcast -a "${action}" -n "${TS_PKG}/.IPNReceiver" 2>&1 | tail -1
}

vpn_connected() {
  adb_bin shell dumpsys connectivity 2>&1 | grep -q 'VPN:com.tailscale.ipn'
}

peer_ping() {
  timeout 4 tailscale ping --c 1 --timeout 2s "${PEER_HOST}" 2>&1 | head -3 || return 1
}

restore_mesh() {
  log "restore: CONNECT_VPN"
  ts_broadcast "com.tailscale.ipn.CONNECT_VPN" || true
  sleep 4
  peer_ping || true
  open_health
  tap_resource "health-refresh" || true
  sleep 2
  tap_resource "health-refresh" || true
  sleep 2
}

mkdir -p "${EVID_DIR}"
trap 'restore_mesh; log "trap restore done"' EXIT

log "=== uat-mesh-drop AC-003-01 ==="
log "serial=${PIXEL_SERIAL} peer=${PEER_HOST}"

if ! command -v adb >/dev/null 2>&1; then
  fail "adb missing"
  exit 1
fi
if ! adb_bin get-state 2>/dev/null | grep -q device; then
  fail "device ${PIXEL_SERIAL} not ready"
  exit 1
fi
if ! command -v tailscale >/dev/null 2>&1; then
  fail "tailscale CLI missing"
  exit 1
fi

open_health
ts_broadcast "com.tailscale.ipn.CONNECT_VPN" >/dev/null || true
sleep 3
if ! peer_ping; then
  fail "baseline peer ping failed — cannot start mesh-drop"
  exit 1
fi
tap_resource "health-refresh" || true
sleep 2
tap_resource "health-refresh" || true
sleep 2
UP_XML="$(ui_dump)"
printf '%s' "${UP_XML}" > "${EVID_DIR}/mesh-up-ui.xml"
UP_BLOB="$(ui_blob "${UP_XML}")"
if printf '%s' "${UP_BLOB}" | grep -q 'State: Ready'; then
  pass "baseline Health State: Ready"
else
  fail "baseline Health not Ready (need paired token + Hub up)"
  printf '%s\n' "${UP_BLOB}" | head -20
  exit 1
fi

log "DISCONNECT_VPN (Tailscale broadcast — not airplane / not force-stop)"
ts_broadcast "com.tailscale.ipn.DISCONNECT_VPN"
sleep 2
if vpn_connected; then
  fail "VPN still connected after DISCONNECT_VPN"
else
  pass "VPN interface gone after DISCONNECT_VPN"
fi
if peer_ping; then
  fail "peer still reachable after DISCONNECT_VPN"
else
  pass "peer ping timeout after DISCONNECT_VPN"
fi

# Cold-start companion so Health cannot keep a stale Ready snapshot.
log "force-stop companion + reopen Health (clear in-memory Ready)"
adb_bin shell am force-stop "${COMPANION_PKG}" || true
sleep 1
open_health
sleep 2

DOWN_BLOB=""
FOUND=0
for attempt in 1 2 3 4; do
  if tap_resource "health-refresh"; then
    log "health-refresh tap ok (attempt ${attempt})"
  else
    log "health-refresh tap miss (attempt ${attempt})"
  fi
  # HubClient default timeoutMs=8000 — wait past abort
  sleep 10
  DOWN_XML="$(ui_dump)"
  printf '%s' "${DOWN_XML}" > "${EVID_DIR}/mesh-down-ui.xml"
  DOWN_BLOB="$(ui_blob "${DOWN_XML}")"
  printf '%s\n' "${DOWN_BLOB}" | rg -i 'State:|Tailscale|Cannot reach|NETWORK|HubDown|Ready' | head -20 || true
  if printf '%s' "${DOWN_BLOB}" | grep -qiE 'State: TailscaleDown|Cannot reach Hub|open Tailscale'; then
    FOUND=1
    break
  fi
  # Stale Ready after VPN drop means refresh never observed NETWORK_ERROR yet
  if printf '%s' "${DOWN_BLOB}" | grep -q 'State: Ready'; then
    log "still Ready after attempt ${attempt} — retry refresh"
  fi
done

if [[ "${FOUND}" -eq 1 ]] && printf '%s' "${DOWN_BLOB}" | grep -qiE 'State: TailscaleDown'; then
  pass "APK State: TailscaleDown"
elif [[ "${FOUND}" -eq 1 ]]; then
  pass "APK actionable Tailscale/offline copy (label soft)"
else
  fail "APK missing Tailscale/offline actionable error"
fi

if printf '%s' "${DOWN_BLOB}" | grep -qiE 'Cannot reach Hub|open Tailscale'; then
  pass "actionable Tailscale guidance copy present"
fi

log "CONNECT_VPN restore"
ts_broadcast "com.tailscale.ipn.CONNECT_VPN"
sleep 4
if peer_ping; then
  pass "peer ping restored"
else
  fail "peer ping not restored"
fi
open_health
tap_resource "health-refresh" || true
sleep 2
tap_resource "health-refresh" || true
sleep 2
REST_XML="$(ui_dump)"
printf '%s' "${REST_XML}" > "${EVID_DIR}/mesh-restored-ui.xml"
REST_BLOB="$(ui_blob "${REST_XML}")"
if printf '%s' "${REST_BLOB}" | grep -q 'State: Ready'; then
  pass "Health Ready after mesh restore"
else
  fail "Health not Ready after restore"
fi
if vpn_connected; then
  pass "VPN CONNECTED after restore"
else
  fail "VPN missing after restore"
fi

# Disable trap restore (already restored)
trap - EXIT

echo
echo "=== summary ==="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "PASS=${PASS} FAIL=${FAIL}"
echo "Evidence: ${EVID_DIR}/"
if [[ "${FAIL}" -gt 0 ]]; then
  echo "VERDICT=FAIL"
  exit 1
fi
echo "VERDICT=PASS_PARTIAL  # AC-003-01 metal via DISCONNECT_VPN broadcast (not operator UI toggle)"
exit 0
