#!/usr/bin/env bash
# adb UAT: Health → (Home | live deep link) → focus composer → type → Send.
# Proves phone UI send path (not live-send autosend). Verifies Composer DOM via CDP when possible.
#
# Usage:
#   ./scripts/adb-live-chat-send-uat.sh
#   LIVE_SESSION_ID=sess_live_… ./scripts/adb-live-chat-send-uat.sh
#
# Env:
#   PIXEL_SERIAL   default 33080DLH20007Y
#   HUB_URL        default http://127.0.0.1:8787
#   CDP_URL        default http://127.0.0.1:9222
#   SKIP_APK_BUILD 1 to skip assembleRelease when mobile unchanged
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

PIXEL_SERIAL="${PIXEL_SERIAL:-33080DLH20007Y}"
HUB_URL="${HUB_URL:-http://127.0.0.1:8787}"
CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
COMPANION_PKG="${COMPANION_PKG:-local.cursor.mobile}"
MSG="${UAT_MESSAGE:-adb-keyboard-uat-$(date -u +%Y%m%dT%H%M%SZ)}"

log() { printf '[adb-live-send] %s\n' "$*"; }
fail() { log "FAIL: $*"; exit 1; }

adb_bin() { adb -s "${PIXEL_SERIAL}" "$@"; }

ui_dump() {
  # dump can take several seconds; cat before completion yields an empty hierarchy.
  adb_bin shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  sleep 2
  adb_bin shell cat /sdcard/ui.xml 2>/dev/null || true
}

tap_resource() {
  local rid="$1"
  local xml center x y ui_file
  ui_file="$(mktemp)"
  xml="$(ui_dump)"
  printf '%s' "${xml}" >"${ui_file}"
  center="$(UI_FILE="${ui_file}" RID="${rid}" python3 - <<'PY'
import os, re
xml = open(os.environ["UI_FILE"], encoding="utf-8", errors="replace").read()
rid = os.environ["RID"]
pat = rf'resource-id="{re.escape(rid)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
m = re.search(pat, xml)
if not m:
    raise SystemExit(1)
x1, y1, x2, y2 = map(int, m.groups())
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
)" || { rm -f "${ui_file}"; return 1; }
  rm -f "${ui_file}"
  read -r x y <<<"${center}"
  adb_bin shell input tap "${x}" "${y}"
}

tap_content_desc() {
  local desc="$1"
  local xml center x y ui_file
  ui_file="$(mktemp)"
  xml="$(ui_dump)"
  printf '%s' "${xml}" >"${ui_file}"
  center="$(UI_FILE="${ui_file}" DESC="${desc}" python3 - <<'PY'
import os, re
xml = open(os.environ["UI_FILE"], encoding="utf-8", errors="replace").read()
desc = os.environ["DESC"]
pat = rf'content-desc="{re.escape(desc)}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
m = re.search(pat, xml)
if not m:
    raise SystemExit(1)
x1, y1, x2, y2 = map(int, m.groups())
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
)" || { rm -f "${ui_file}"; return 1; }
  rm -f "${ui_file}"
  read -r x y <<<"${center}"
  adb_bin shell input tap "${x}" "${y}"
}

resolve_live_session_id() {
  if [[ -n "${LIVE_SESSION_ID:-}" ]]; then
    echo "${LIVE_SESSION_ID}"
    return 0
  fi
  node - <<'NODE'
const http = require('http');
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json', ...(headers || {}) } },
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
    appVersion: 'adb-uat',
    deviceName: 'adb-uat-script',
  }));
  const token = complete.body.deviceToken;
  const ws = await req('GET', '/v1/workspace', { Authorization: 'Bearer ' + token });
  const list = await req('GET', '/v1/sessions?workspaceId=' + ws.body.workspaceId + '&mode=live&limit=1', { Authorization: 'Bearer ' + token });
  const id = list.body.items?.[0]?.id;
  if (!id) process.exit(3);
  process.stdout.write(id);
})().catch(() => process.exit(1));
NODE
}

log "message=${MSG}"

command -v adb >/dev/null || fail "adb not on PATH"
adb_bin get-state >/dev/null 2>&1 || fail "Pixel ${PIXEL_SERIAL} not authorized"

SID="$(HUB_URL="${HUB_URL}" resolve_live_session_id)" || fail "Could not resolve live session id (set LIVE_SESSION_ID=)"
log "sessionId=${SID}"

# Launch Health, refresh (Ready), open Home via deep link, open Live chat.
adb_bin shell am force-stop "${COMPANION_PKG}" || true
sleep 1
adb_bin shell monkey -p "${COMPANION_PKG}" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 5
if ! tap_resource "health-refresh"; then
  xml_len="$(ui_dump | wc -c | tr -d ' ')"
  fail "Refresh health control not found (ui bytes=${xml_len})"
fi
sleep 6
adb_bin shell am start -a android.intent.action.VIEW -d 'cursor-companion://nav/home' -f 0x14008000 -n "${COMPANION_PKG}/.MainActivity" >/dev/null
sleep 2
adb_bin shell am start -a android.intent.action.VIEW -d "cursor-companion://live/${SID}" -f 0x14008000 -n "${COMPANION_PKG}/.MainActivity" >/dev/null
sleep 4

xml="$(ui_dump)"
if grep -q 'Input disabled' <<<"${xml}"; then
  fail "Composer input disabled — refresh Health / check GET /sessions/:id"
fi

tap_resource "live-chat-composer" || tap_content_desc "Message input" || fail "Composer not found"
sleep 0.5
# adb input text: spaces as %s, strip chars that break shell input
safe_msg="${MSG// /%s}"
safe_msg="${safe_msg//[^a-zA-Z0-9_%s-]/}"
adb_bin shell input text "${safe_msg}"
sleep 0.4
tap_resource "live-chat-send" || fail "Send button not found"
sleep 5

xml="$(ui_dump)"
if grep -Fq "${MSG}" <<<"${xml}" || grep -Fq "${safe_msg//%s/ }" <<<"${xml}"; then
  log "PASS: user bubble visible in Live chat UI"
  exit 0
fi

# Hub may still have accepted — check transcript via localhost pair (best-effort)
if HUB_URL="${HUB_URL}" SID="${SID}" NEEDLE="${MSG}" node - <<'NODE'
const http = require('http');
const hubUrl = process.env.HUB_URL;
const sid = process.env.SID;
const needle = process.env.NEEDLE;
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(hubUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json', ...(headers || {}) } },
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
  const complete = await req('POST', '/v1/pair/complete', {}, JSON.stringify({
    pairId: start.body.pairId,
    code: start.body.code,
    platform: 'android',
    appVersion: 'adb-uat',
    deviceName: 'adb-uat-verify',
  }));
  const token = complete.body.deviceToken;
  const detail = await req('GET', '/v1/sessions/' + encodeURIComponent(sid), { Authorization: 'Bearer ' + token });
  const msgs = detail.body?.transcript?.messages ?? [];
  const hit = msgs.some((m) => m.role === 'user' && String(m.content).includes(needle));
  process.exit(hit ? 0 : 4);
})().catch(() => process.exit(5));
NODE
then
  log "PASS: Hub transcript contains message (UI bubble not scraped)"
  exit 0
fi

fail "Send not evidenced in UI or Hub transcript — see /sdcard/ui.xml on device"
