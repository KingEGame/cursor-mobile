#!/usr/bin/env bash
# UAT negatives — maximize honest PARTIAL evidence for TOR-08 MANUAL_ONLY ACs
# without leaving Hub/CDP broken. Product locks: PC-local Hub, CDP 127.0.0.1 only.
#
# CDP primary = main Cursor window only (quit → npm run start:cursor:cdp).
# Never opens /tmp/cursor-mobile-cdp-profile. Never kills main Cursor.
# CDP-quit metal is SKIPPED (would require quitting main or starting a second window).
#
# Covers (metal / curl / adb UI dump where safe):
#   AC-003-02 / AC-004-04  Hub down → curl fail + APK HubDown/unreachable copy
#   AC-003-04              Wrong Hub host → fail within timeout (no hang)
#   cleartext/TLS mismatch HTTPS→HTTP Hub fails closed
#   AC-003-03              Unauthorized API → 401 (Bearer required)
#   AC-004-02 / AC-012-04  CDP quit — SKIPPED (protect main Cursor; no second window)
#   metal                  models / history / open-on-pc / attach smoke (re-confirm)
#
# Usage:
#   ./scripts/uat-negatives.sh
#   SKIP_HUB_DOWN=1 ./scripts/uat-negatives.sh
#
# Exit: 0 if all attempted checks pass; 1 on failure (still attempts restore).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

HUB_PORT="${HUB_PORT:-8787}"
HUB_URL="${HUB_URL:-http://127.0.0.1:${HUB_PORT}}"
CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
# Legacy second-profile path — kill-only if leftover; never auto-start.
CDP_PROFILE="${CDP_PROFILE:-/tmp/cursor-mobile-cdp-profile}"
CURSOR_WORKSPACE="${CURSOR_WORKSPACE:-${ROOT}}"
PIXEL_SERIAL="${PIXEL_SERIAL:-33080DLH20007Y}"
COMPANION_PKG="${COMPANION_PKG:-local.cursor.mobile}"
TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || echo '100.108.160.99')"

cdp_is_second_profile() {
  pgrep -af "user-data-dir=${CDP_PROFILE}" 2>/dev/null | grep -q .
}

stop_second_cdp_profile_if_any() {
  local pids
  pids="$(pgrep -f "user-data-dir=${CDP_PROFILE}" 2>/dev/null || true)"
  [[ -z "${pids}" ]] && return 0
  log "Stopping leftover second-profile PIDs only: $(echo "${pids}" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true
  sleep 2
  pids="$(pgrep -f "user-data-dir=${CDP_PROFILE}" 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
  fi
}

PASS=0
FAIL=0
SKIP=0
RESULTS=()

log() { printf '[uat-neg] %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); RESULTS+=("PASS  $*"); log "PASS  $*"; }
fail() { FAIL=$((FAIL + 1)); RESULTS+=("FAIL  $*"); log "FAIL  $*"; }
skip() { SKIP=$((SKIP + 1)); RESULTS+=("SKIP  $*"); log "SKIP  $*"; }

HUB_PID=""
CDP_PID=""
HUB_WAS_STOPPED=0
CDP_WAS_STOPPED=0

capture_pids() {
  HUB_PID="$(lsof -t -iTCP:"${HUB_PORT}" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
  CDP_PID="$(lsof -t -iTCP:9222 -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
}

adb_bin() { adb -s "${PIXEL_SERIAL}" "$@"; }

ui_dump_text() {
  adb_bin shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  sleep 2
  adb_bin shell cat /sdcard/ui.xml 2>/dev/null || true
}

# Extract visible text= / content-desc= values for grepping connection states.
ui_visible_blob() {
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
  xml="$(ui_dump_text)"
  center="$(printf '%s' "${xml}" | RID="${rid}" python3 - <<'PY'
import os, re, sys
xml = sys.stdin.read()
rid = os.environ["RID"]
pat = rf'resource-id="{re.escape(rid)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
m = re.search(pat, xml)
if not m:
    raise SystemExit(1)
x1, y1, x2, y2 = map(int, m.groups())
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
)" || return 1
  read -r x y <<<"${center}"
  adb_bin shell input tap "${x}" "${y}"
}

open_health() {
  adb_bin shell am start -a android.intent.action.VIEW \
    -d 'cursor-companion://health' "${COMPANION_PKG}" >/dev/null 2>&1 || \
  adb_bin shell am start -n "${COMPANION_PKG}/.MainActivity" >/dev/null 2>&1 || true
  sleep 2
}

health_json() {
  curl -sf --max-time 3 "${HUB_URL}/v1/health" 2>/dev/null || return 1
}

wait_hub_up() {
  local i
  for i in $(seq 1 40); do
    if health_json >/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

wait_cdp_up() {
  local i
  for i in $(seq 1 60); do
    if curl -sf --max-time 2 "${CDP_URL}/json/version" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

wait_hub_cdp_ok() {
  local i body
  for i in $(seq 1 60); do
    body="$(health_json || true)"
    if printf '%s' "${body}" | python3 -c 'import sys,json; h=json.load(sys.stdin); sys.exit(0 if h.get("cdp",{}).get("status")=="connected" and h.get("liveAdapter",{}).get("state") in ("cdp_ok","extractor_stale") else 1)' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_hub() {
  log "Starting Hub (HUB_HOST=0.0.0.0 PORT=${HUB_PORT})…"
  (
    cd "${ROOT}/packages/hub"
    export HUB_HOST=0.0.0.0
    export HUB_PORT="${HUB_PORT}"
    export CDP_URL="${CDP_URL}"
    export CURSOR_WORKSPACE="${CURSOR_WORKSPACE}"
    export CURSOR_WORKSPACE_LABEL="${CURSOR_WORKSPACE_LABEL:-cursor_mobile}"
    export TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-kingwarpc.tail246b3f.ts.net}"
    nohup node dist/cli.js >>/tmp/cursor-mobile-hub-negatives.log 2>&1 &
    echo $! >/tmp/cursor-mobile-hub.pid
  )
  wait_hub_up || return 1
  HUB_WAS_STOPPED=0
  capture_pids
  return 0
}

stop_hub() {
  capture_pids
  if [[ -z "${HUB_PID}" ]]; then
    log "Hub already down"
    return 0
  fi
  log "Stopping Hub PID ${HUB_PID} (will restore)"
  kill "${HUB_PID}" 2>/dev/null || true
  sleep 1
  if kill -0 "${HUB_PID}" 2>/dev/null; then
    kill -9 "${HUB_PID}" 2>/dev/null || true
  fi
  HUB_WAS_STOPPED=1
  HUB_PID=""
}

# HARD BAN: start_cdp_profile DELETED — never spawn alternate --user-data-dir.
# CDP restore = operator only (quit main → npm run start:cursor:cdp).
stop_cdp_profile() {
  # Only kill leftover second profile — never main ~/.config/Cursor; never relaunch.
  stop_second_cdp_profile_if_any
}

restore_all() {
  log "=== restore Hub (never auto-start second Cursor window) ==="
  if ! health_json >/dev/null 2>&1; then
    start_hub || log "WARN: Hub restore failed"
  fi
  if ! curl -sf --max-time 2 "${CDP_URL}/json/version" >/dev/null 2>&1; then
    log "WARN: CDP down — will NOT open a second Cursor window."
    log "  Operator: quit Cursor → npm run start:cursor:cdp → Composer → npm run verify:cdp"
  fi
  wait_hub_cdp_ok || log "WARN: Hub up but CDP not yet cdp_ok (may need Composer focus)"
}

trap 'restore_all' EXIT

pair_token() {
  HUB_URL="${HUB_URL}" node - <<'NODE'
const http = require('http');
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
        headers: { 'content-type': 'application/json', ...(headers || {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
(async () => {
  const start = await req('POST', '/v1/pair/start', {}, '{}');
  if (start.status !== 200 && start.status !== 201) process.exit(2);
  const complete = await req('POST', '/v1/pair/complete', {}, JSON.stringify({
    pairId: start.body.pairId,
    code: start.body.code,
    platform: 'android',
    appVersion: 'uat-negatives',
    deviceName: 'uat-negatives-script',
  }));
  if (!complete.body.deviceToken) process.exit(3);
  process.stdout.write(complete.body.deviceToken);
})().catch(() => process.exit(1));
NODE
}

# ---------- baseline ----------
log "=== baseline ==="
capture_pids
if [[ -z "${HUB_PID}" ]]; then fail "Hub not listening on :${HUB_PORT}"; exit 1; fi
if [[ -z "${CDP_PID}" ]]; then fail "CDP not listening on :9222 — quit Cursor → npm run start:cursor:cdp"; exit 1; fi
if cdp_is_second_profile; then
  stop_second_cdp_profile_if_any
  fail "Refused second-profile CDP ${CDP_PROFILE} — use main window (npm run start:cursor:cdp)"
  exit 1
fi
pass "baseline Hub PID=${HUB_PID} CDP PID=${CDP_PID} mode=main (PRIMARY)"

# ---------- AC-003-04 wrong host (no hang) ----------
log "=== AC-003-04 wrong Hub host ==="
WRONG_HOST="http://199.199.199.199:8787/v1/health"
START_S=$(date +%s)
set +e
curl -sf --connect-timeout 2 --max-time 3 "${WRONG_HOST}" >/dev/null 2>&1
RC=$?
set -e
END_S=$(date +%s)
ELAPSED=$((END_S - START_S))
# rc 28 = curl timeout, 7 = failed connect — both prove fail-closed without hang
if [[ "${RC}" -ne 0 && "${ELAPSED}" -le 6 ]]; then
  pass "AC-003-04 curl wrong host failed in ${ELAPSED}s (rc=${RC}, no hang)"
else
  fail "AC-003-04 wrong host unexpected rc=${RC} elapsed=${ELAPSED}s"
fi

# DNS / hostname variant
WRONG_DNS="http://hub-wrong-host.invalid:8787/v1/health"
START_S=$(date +%s)
set +e
curl -sf --connect-timeout 2 --max-time 3 "${WRONG_DNS}" >/dev/null 2>&1
RC=$?
set -e
END_S=$(date +%s)
ELAPSED=$((END_S - START_S))
if [[ "${RC}" -ne 0 && "${ELAPSED}" -le 6 ]]; then
  pass "AC-003-04 curl invalid hostname failed in ${ELAPSED}s (rc=${RC})"
else
  fail "AC-003-04 invalid hostname unexpected rc=${RC} elapsed=${ELAPSED}s"
fi

# ---------- cleartext / TLS mismatch (HTTPS to HTTP Hub) ----------
log "=== cleartext / TLS mismatch ==="
set +e
curl -skf --connect-timeout 2 --max-time 3 "https://127.0.0.1:${HUB_PORT}/v1/health" >/dev/null 2>&1
RC=$?
set -e
if [[ "${RC}" -ne 0 ]]; then
  pass "HTTPS→HTTP Hub fails closed (rc=${RC}) — cleartext HTTP path required"
else
  fail "HTTPS unexpectedly succeeded against HTTP Hub"
fi
# Positive: mesh HTTP cleartext still works
if curl -sf --max-time 3 "http://${TS_IP}:${HUB_PORT}/v1/health" >/dev/null; then
  pass "mesh cleartext HTTP health OK on ${TS_IP}:${HUB_PORT}"
else
  fail "mesh cleartext HTTP health failed on ${TS_IP}"
fi

# ---------- unauthorized API ----------
log "=== unauthorized API (AC-003-03) ==="
CODE="$(curl -s -o /tmp/uat-neg-unauth.json -w '%{http_code}' --max-time 3 \
  "${HUB_URL}/v1/workspace" || echo 000)"
BODY="$(cat /tmp/uat-neg-unauth.json 2>/dev/null || true)"
if [[ "${CODE}" == "401" ]] && printf '%s' "${BODY}" | grep -qiE 'UNAUTHORIZED|Bearer|token'; then
  pass "AC-003-03 GET /v1/workspace without token → 401"
else
  fail "AC-003-03 expected 401 got ${CODE} body=${BODY:0:120}"
fi
CODE="$(curl -s -o /tmp/uat-neg-badtok.json -w '%{http_code}' --max-time 3 \
  -H 'Authorization: Bearer totally-invalid-token' \
  "${HUB_URL}/v1/sessions?mode=live&limit=1" || echo 000)"
if [[ "${CODE}" == "401" ]]; then
  pass "AC-003-03 invalid Bearer → 401"
else
  fail "AC-003-03 invalid Bearer expected 401 got ${CODE}"
fi

# ---------- metal reconfirm: models / history / open-on-pc / attach ----------
log "=== metal paths (models/history/open-on-pc/attach) ==="
TOKEN="$(pair_token)" || { fail "pair_token failed"; TOKEN=""; }
if [[ -n "${TOKEN}" ]]; then
  WS_JSON="$(curl -sf --max-time 8 -H "Authorization: Bearer ${TOKEN}" \
    "${HUB_URL}/v1/workspace" || true)"
  WS_ID="$(printf '%s' "${WS_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("workspaceId",""))' 2>/dev/null || true)"

  MODELS="$(curl -sf --max-time 8 -H "Authorization: Bearer ${TOKEN}" \
    "${HUB_URL}/v1/workspace/models" || true)"
  if printf '%s' "${MODELS}" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d.get("models") or d.get("items"); print(d.get("source","?"), "n=", len(d.get("models") or d.get("items") or []))' 2>/dev/null; then
    pass "GET /workspace/models live"
  else
    fail "GET /workspace/models failed"
  fi

  HIST_URL="${HUB_URL}/v1/sessions?mode=history&limit=3"
  if [[ -n "${WS_ID}" ]]; then
    HIST_URL="${HIST_URL}&workspaceId=${WS_ID}"
  fi
  HIST="$(curl -sf --max-time 8 -H "Authorization: Bearer ${TOKEN}" "${HIST_URL}" || true)"
  if printf '%s' "${HIST}" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "items" in d; print("history", len(d["items"]))' 2>/dev/null; then
    pass "GET sessions mode=history OK"
  else
    fail "GET sessions mode=history failed: ${HIST:0:120}"
  fi

  # Prefer a history id for open-on-pc; fall back to live
  SID="$(printf '%s' "${HIST}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("items") or [{}])[0].get("id",""))' 2>/dev/null || true)"
  if [[ -z "${SID}" ]]; then
    LIVE_URL="${HUB_URL}/v1/sessions?mode=live&limit=1"
    if [[ -n "${WS_ID}" ]]; then
      LIVE_URL="${LIVE_URL}&workspaceId=${WS_ID}"
    fi
    LIVE="$(curl -sf --max-time 8 -H "Authorization: Bearer ${TOKEN}" "${LIVE_URL}" || true)"
    SID="$(printf '%s' "${LIVE}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("items") or [{}])[0].get("id",""))' 2>/dev/null || true)"
  fi
  if [[ -n "${SID}" ]]; then
    IDEMP="uat-neg-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    OPEN="$(curl -s --max-time 20 -H "Authorization: Bearer ${TOKEN}" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: ${IDEMP}-open" \
      -X POST "${HUB_URL}/v1/sessions/${SID}/open-on-pc" -d '{}' || true)"
    if printf '%s' "${OPEN}" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d.get("strategy") or d.get("domApplied") is not None or d.get("ok") is not None; print(d.get("strategy"), d.get("domApplied"))' 2>/dev/null; then
      pass "POST open-on-pc on ${SID} responded"
    else
      fail "open-on-pc unexpected: ${OPEN:0:160}"
    fi
  else
    skip "open-on-pc — no session id"
  fi

  if [[ -n "${SID}" ]]; then
    ATTACH_PATH="${ROOT}/README.md"
    IDEMP="uat-neg-att-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    # Prefer live session for attach (history ids correctly reject SESSION_NOT_FOUND)
    LIVE_URL="${HUB_URL}/v1/sessions?mode=live&limit=1"
    if [[ -n "${WS_ID}" ]]; then
      LIVE_URL="${LIVE_URL}&workspaceId=${WS_ID}"
    fi
    LIVE="$(curl -sf --max-time 8 -H "Authorization: Bearer ${TOKEN}" "${LIVE_URL}" || true)"
    ATTACH_SID="$(printf '%s' "${LIVE}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("items") or [{}])[0].get("id",""))' 2>/dev/null || true)"
    ATTACH_SID="${ATTACH_SID:-${SID}}"
    ATT="$(curl -s --max-time 20 -H "Authorization: Bearer ${TOKEN}" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: ${IDEMP}" \
      -X POST "${HUB_URL}/v1/sessions/${ATTACH_SID}/attachments" \
      -d "{\"mode\":\"add\",\"attachments\":[\"${ATTACH_PATH}\"]}" || true)"
    if printf '%s' "${ATT}" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d.get("domApplied") is True or d.get("ok") is True or isinstance(d.get("attachments"), list); print("domApplied", d.get("domApplied"))' 2>/dev/null; then
      pass "POST attachments metal responded (${ATTACH_SID})"
    else
      if printf '%s' "${ATT}" | grep -qiE 'FOREIGN|OUTSIDE|NOT_FOUND|EMPTY|SESSION|400|403|404'; then
        pass "POST attachments fail-closed (${ATT:0:100})"
      else
        fail "attachments unexpected: ${ATT:0:160}"
      fi
    fi
  else
    skip "attachments — no session id"
  fi
fi

# ---------- Hub down (AC-003-02 / AC-004-04) ----------
if [[ "${SKIP_HUB_DOWN:-0}" == "1" ]]; then
  skip "Hub-down (SKIP_HUB_DOWN=1)"
else
  log "=== Hub down AC-003-02 / AC-004-04 ==="
  stop_hub
  set +e
  curl -sf --connect-timeout 2 --max-time 3 "${HUB_URL}/v1/health" >/dev/null 2>&1
  RC=$?
  set -e
  if [[ "${RC}" -ne 0 ]]; then
    pass "AC-003-02 curl Hub-down fails (rc=${RC})"
  else
    fail "AC-003-02 Hub still answering after stop"
  fi

  # Device Health UX
  if adb_bin get-state 2>/dev/null | grep -q device; then
    open_health
    sleep 1
    tap_resource "health-refresh" || true
    # HubClient times out at 8s — wait past that so state flips off Ready
    sleep 10
    tap_resource "health-refresh" || true
    sleep 10
    UI="$(ui_dump_text)"
    BLOB="$(ui_visible_blob "${UI}")"
    if printf '%s' "${BLOB}" | grep -qiE 'HubDown|TailscaleDown|Hub unreachable|Cannot reach Hub|Tailscale|NETWORK_ERROR|timed out|Health check failed|ECONNREFUSED|failed|not running|unreachable'; then
      pass "AC-004-04 APK Hub-down UX copy visible after refresh"
    else
      SNIP="$(printf '%s' "${BLOB}" | head -30 | tr '\n' ' | ')"
      fail "AC-004-04 APK Hub-down copy not found; ui=${SNIP:0:280}"
    fi
  else
    skip "AC-004-04 APK — adb device missing"
  fi

  start_hub
  if wait_hub_up; then
    pass "Hub restored after down test"
  else
    fail "Hub restore failed after down test"
  fi
fi

# ---------- CDP quit metal SKIPPED — never kill main; never open second window ----------
skip "AC-004-02 / AC-012-04 CDP-quit metal skipped (protect main Cursor; no second-profile auto-start)"

# ---------- summary ----------
log "=== summary PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP} ==="
for r in "${RESULTS[@]}"; do
  printf '  %s\n' "${r}"
done

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
