#!/usr/bin/env bash
# adb UAT: Live chat Approve/Deny cards on Pixel.
#
# Prefers live (non-synthetic) when a Cursor tool card is present (Run/Skip).
# Falls back to synthetic enqueue for device UI path — honest PARTIAL (no DOM).
#
# Usage:
#   ./scripts/adb-approvals-uat.sh
#   DECISION=deny LIVE_SESSION_ID=sess_live_… ./scripts/adb-approvals-uat.sh
#   ALLOW_TRIGGER=1 ./scripts/adb-approvals-uat.sh   # send shell probe to raise card
#
# Env:
#   PIXEL_SERIAL    default 33080DLH20007Y
#   HUB_URL         default http://127.0.0.1:8787
#   CDP_URL         default http://127.0.0.1:9222
#   DECISION        approve|deny (default deny — safer for shell probes)
#   ALLOW_TRIGGER   1 to Hub-send a shell probe and wait for Run/Skip
#   SKIP_APK_BUILD  1 to skip assembleRelease / install
#   REQUIRE_LIVE    1 to fail if only synthetic path available
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

PIXEL_SERIAL="${PIXEL_SERIAL:-33080DLH20007Y}"
HUB_URL="${HUB_URL:-http://127.0.0.1:8787}"
CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
COMPANION_PKG="${COMPANION_PKG:-local.cursor.mobile}"
DECISION="${DECISION:-deny}"
ALLOW_TRIGGER="${ALLOW_TRIGGER:-1}"
SKIP_APK_BUILD="${SKIP_APK_BUILD:-0}"
REQUIRE_LIVE="${REQUIRE_LIVE:-0}"
TRIGGER_WAIT_SEC="${TRIGGER_WAIT_SEC:-90}"

log() { printf '[adb-approvals] %s\n' "$*"; }
fail() { log "FAIL: $*"; exit 1; }

adb_bin() { adb -s "${PIXEL_SERIAL}" "$@"; }

ui_dump() {
  # Pull a local copy — never cat mid-dump.
  local local_xml
  local_xml="$(mktemp)"
  adb_bin shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  sleep 2
  adb_bin pull /sdcard/ui.xml "${local_xml}" >/dev/null 2>&1 || true
  if [[ -s "${local_xml}" ]]; then
    cat "${local_xml}"
  else
    adb_bin shell cat /sdcard/ui.xml 2>/dev/null || true
  fi
  rm -f "${local_xml}"
}

# Match attr regardless of attribute order within the <node ...> tag.
_node_center() {
  local attr="$1" value="$2" ui_file="$3"
  ATTR="${attr}" VALUE="${value}" UI_FILE="${ui_file}" python3 - <<'PY'
import os, re
xml = open(os.environ["UI_FILE"], encoding="utf-8", errors="replace").read()
attr = os.environ["ATTR"]
value = os.environ["VALUE"]
pat = rf'<node\b(?=[^>]*\b{re.escape(attr)}="{re.escape(value)}")(?=[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]")[^>]*>'
m = re.search(pat, xml)
if not m:
    raise SystemExit(1)
x1, y1, x2, y2 = map(int, m.groups())
print((x1 + x2) // 2, (y1 + y2) // 2)
PY
}

tap_resource() {
  local rid="$1"
  local tries="${2:-3}"
  local center x y ui_file i
  for ((i = 1; i <= tries; i++)); do
    ui_file="$(mktemp)"
    printf '%s' "$(ui_dump)" >"${ui_file}"
    if center="$(_node_center resource-id "${rid}" "${ui_file}")"; then
      rm -f "${ui_file}"
      read -r x y <<<"${center}"
      adb_bin shell input tap "${x}" "${y}"
      return 0
    fi
    rm -f "${ui_file}"
    sleep 2
  done
  return 1
}

tap_content_desc() {
  local desc="$1"
  local tries="${2:-3}"
  local center x y ui_file i
  for ((i = 1; i <= tries; i++)); do
    ui_file="$(mktemp)"
    printf '%s' "$(ui_dump)" >"${ui_file}"
    if center="$(_node_center content-desc "${desc}" "${ui_file}")"; then
      rm -f "${ui_file}"
      read -r x y <<<"${center}"
      adb_bin shell input tap "${x}" "${y}"
      return 0
    fi
    rm -f "${ui_file}"
    sleep 2
  done
  return 1
}

# --- Hub helpers (pair via loopback) ---
hub_node() {
  HUB_URL="${HUB_URL}" node - "$@"
}

resolve_pair_and_session() {
  HUB_URL="${HUB_URL}" LIVE_SESSION_ID="${LIVE_SESSION_ID:-}" node - <<'NODE'
const http = require('http');
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
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
    appVersion: 'adb-approvals-uat',
    deviceName: 'adb-approvals-script',
  }));
  const token = complete.body.deviceToken;
  if (!token) process.exit(3);
  const ws = await req('GET', '/v1/workspace', { Authorization: 'Bearer ' + token });
  let sid = process.env.LIVE_SESSION_ID || '';
  if (!sid) {
    const list = await req(
      'GET',
      '/v1/sessions?workspaceId=' + ws.body.workspaceId + '&mode=live&limit=1',
      { Authorization: 'Bearer ' + token },
    );
    sid = list.body.items?.[0]?.id || '';
  }
  if (!sid) process.exit(4);
  process.stdout.write(JSON.stringify({ token, sessionId: sid, workspaceId: ws.body.workspaceId }));
})().catch(() => process.exit(1));
NODE
}

cdp_tool_card_counts() {
  CDP_URL="${CDP_URL}" node - <<'NODE'
const WebSocket = require('ws');
(async () => {
  const base = process.env.CDP_URL.replace(/\/$/, '');
  const list = await fetch(base + '/json/list').then((r) => r.json());
  // Prefer IDE workbench with a live Run/Skip card over Agents/Cloud window.
  const pages = list.filter((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  const ranked = [
    ...pages.filter((p) => /cursor_mobile/i.test(p.title || '')),
    ...pages.filter((p) => (p.title || '') === 'Cursor'),
    ...pages.filter((p) => (p.url || '').includes('workbench')),
    ...pages,
  ].filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);

  const expr = `(() => {
    const run = document.querySelectorAll('button.ui-shell-tool-call__run-btn').length;
    const skip = document.querySelectorAll('button.ui-shell-tool-call__skip-btn').length;
    const t = document.body?.innerText || '';
    const waiting =
      /Waiting for Approval/.test(t) ||
      /Pending approval/.test(t);
    return { run, skip, waiting, ok: true, title: document.title };
  })()`;

  let best = { run: 0, skip: 0, waiting: false, ok: false, title: null, pageId: null };
  for (const page of ranked) {
    try {
      const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise((res, rej) => {
        ws.on('open', res);
        ws.on('error', rej);
      });
      let id = 1;
      function cdp(method, params) {
        return new Promise((resolve, reject) => {
          const mid = id++;
          const onMsg = (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === mid) {
              ws.off('message', onMsg);
              resolve(msg);
            }
          };
          ws.on('message', onMsg);
          ws.send(JSON.stringify({ id: mid, method, params }));
          setTimeout(() => reject(new Error('timeout ' + method)), 10000);
        });
      }
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
      const v = r.result?.result?.value ?? { run: 0, skip: 0, waiting: false, ok: false };
      ws.close();
      const scored = { ...v, pageId: page.id || null };
      if ((scored.run || 0) > (best.run || 0) || (scored.skip || 0) > (best.skip || 0)) {
        best = scored;
      } else if (!best.ok && scored.ok) {
        best = scored;
      }
      if ((best.run || 0) > 0 || (best.skip || 0) > 0) break;
    } catch {
      /* try next page */
    }
  }
  console.log(JSON.stringify(best));
})().catch(() => {
  console.log(JSON.stringify({ run: 0, skip: 0, waiting: false, ok: false }));
});
NODE
}

[[ "${DECISION}" == "approve" || "${DECISION}" == "deny" ]] || fail "DECISION must be approve|deny"

command -v adb >/dev/null || fail "adb not on PATH"
adb_bin get-state >/dev/null 2>&1 || fail "Pixel ${PIXEL_SERIAL} not authorized"

PAIR_JSON="$(resolve_pair_and_session)" || fail "Could not pair / resolve live session"
TOKEN="$(printf '%s' "${PAIR_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"
SID="$(printf '%s' "${PAIR_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionId"])')"
log "sessionId=${SID} decision=${DECISION}"

CARD_BEFORE="$(cdp_tool_card_counts)"
log "cdp tool card before: ${CARD_BEFORE}"
RUN_BEFORE="$(printf '%s' "${CARD_BEFORE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("run",0))')"
SKIP_BEFORE="$(printf '%s' "${CARD_BEFORE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("skip",0))')"

# Optional: raise a live Ask Every Time card via Composer send
if [[ "${ALLOW_TRIGGER}" == "1" && "${RUN_BEFORE}" -eq 0 && "${SKIP_BEFORE}" -eq 0 ]]; then
  # Prefer a non-echo Shell command — Ask Every Time may still auto-allow trivial echo.
  PROBE="UAT approval probe $(date -u +%Y%m%dT%H%M%SZ): use Shell tool only to run exactly: python3 -c \"open('/tmp/cursor_mobile_uat_probe.txt','w').write('PROBE')\". Do not skip."
  log "TRIGGER: posting shell probe to raise tool card…"
  TRIGGER_RES="$(
    HUB_URL="${HUB_URL}" TOKEN="${TOKEN}" SID="${SID}" PROBE="${PROBE}" node - <<'NODE'
const http = require('http');
const crypto = require('crypto');
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
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
  const key = 'adb-apr-trigger-' + crypto.randomBytes(6).toString('hex');
  const res = await req(
    'POST',
    '/v1/sessions/' + encodeURIComponent(process.env.SID) + '/messages',
    { Authorization: 'Bearer ' + process.env.TOKEN, 'Idempotency-Key': key },
    JSON.stringify({ content: process.env.PROBE }),
  );
  process.stdout.write(JSON.stringify({ status: res.status, domApplied: res.body?.domApplied, body: res.body }));
})().catch((e) => {
  process.stdout.write(JSON.stringify({ status: 0, error: String(e) }));
  process.exit(0);
});
NODE
  )"
  log "trigger send: ${TRIGGER_RES}"
  log "waiting up to ${TRIGGER_WAIT_SEC}s for Run/Skip…"
  deadline=$((SECONDS + TRIGGER_WAIT_SEC))
  while (( SECONDS < deadline )); do
    CARD_BEFORE="$(cdp_tool_card_counts)"
    RUN_BEFORE="$(printf '%s' "${CARD_BEFORE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("run",0))')"
    SKIP_BEFORE="$(printf '%s' "${CARD_BEFORE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("skip",0))')"
    if [[ "${RUN_BEFORE}" -gt 0 || "${SKIP_BEFORE}" -gt 0 ]]; then
      log "tool card appeared: ${CARD_BEFORE}"
      break
    fi
    sleep 3
  done
fi

MODE="synthetic"
if [[ "${RUN_BEFORE}" -gt 0 || "${SKIP_BEFORE}" -gt 0 ]]; then
  MODE="live"
fi
log "enqueue mode=${MODE}"

ENQUEUE="$(
  HUB_URL="${HUB_URL}" SID="${SID}" MODE="${MODE}" node - <<'NODE'
const http = require('http');
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
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
  const live = process.env.MODE === 'live';
  const body = live
    ? { live: true, tool: { name: 'Shell', kind: 'shell' }, summary: 'adb live tool card pending approval' }
    : { tool: 'synthetic.uat', summary: 'adb synthetic approval (device UI path)' };
  const res = await req(
    'POST',
    '/v1/sessions/' + encodeURIComponent(process.env.SID) + '/approvals/synthetic',
    {},
    JSON.stringify(body),
  );
  if (res.status !== 201) {
    console.error(JSON.stringify(res));
    process.exit(5);
  }
  process.stdout.write(JSON.stringify(res.body));
})().catch(() => process.exit(1));
NODE
)" || fail "enqueue pending approval failed"
APPROVAL_ID="$(printf '%s' "${ENQUEUE}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["approvalId"])')"
SYNTH_FLAG="$(printf '%s' "${ENQUEUE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("synthetic", True))')"
log "enqueued approvalId=${APPROVAL_ID} synthetic=${SYNTH_FLAG}"

if [[ "${REQUIRE_LIVE}" == "1" && "${MODE}" != "live" ]]; then
  fail "REQUIRE_LIVE=1 but no Cursor Run/Skip tool card (Ask Every Time + Agent shell needed)"
fi

# Ensure APK has approval-* testIDs (rebuild when not skipped)
APK_PATH="apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
if [[ "${SKIP_APK_BUILD}" != "1" ]]; then
  log "building + installing release APK (testIDs)…"
  if [[ ! -d apps/mobile/android ]]; then
    (cd apps/mobile && npx expo prebuild --platform android --no-install) || fail "expo prebuild failed"
  fi
  (cd apps/mobile/android && ./gradlew assembleRelease -q) || fail "assembleRelease failed"
  adb_bin install -r "${APK_PATH}" || fail "adb install failed"
else
  log "SKIP_APK_BUILD=1 — using installed APK"
fi

# Launch Health → Ready → Live chat deep link
adb_bin shell am force-stop "${COMPANION_PKG}" || true
sleep 1
adb_bin shell monkey -p "${COMPANION_PKG}" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 5
adb_bin shell am start -a android.intent.action.VIEW -d 'cursor-companion://health' -f 0x14008000 -n "${COMPANION_PKG}/.MainActivity" >/dev/null
sleep 3
if ! tap_resource "health-refresh" 5; then
  tap_content_desc "Refresh health" 3 || {
    xml_len="$(ui_dump | wc -c | tr -d ' ')"
    fail "Refresh health control not found (ui bytes=${xml_len})"
  }
fi
# Wait until Health banner shows Ready (decide needs live Hub path; unknown health flakes taps).
ready=0
for _ in $(seq 1 12); do
  sleep 2
  xml="$(ui_dump)"
  if grep -q 'State: Ready' <<<"${xml}" || grep -q 'Connected — Hub and Cursor path look healthy' <<<"${xml}"; then
    ready=1
    break
  fi
  tap_resource "health-refresh" 1 || true
done
if [[ "${ready}" -ne 1 ]]; then
  fail "Health never reached Ready after refresh — check Hub mesh / pair token on device"
fi
log "Health Ready"
adb_bin shell am start -a android.intent.action.VIEW -d 'cursor-companion://nav/home' -f 0x14008000 -n "${COMPANION_PKG}/.MainActivity" >/dev/null
sleep 2
adb_bin shell am start -a android.intent.action.VIEW -d "cursor-companion://live/${SID}" -f 0x14008000 -n "${COMPANION_PKG}/.MainActivity" >/dev/null
sleep 6

xml="$(ui_dump)"
if ! grep -qE 'approval-(approve|deny)|Deny tool|Approve tool|PC tool approval|UAT synthetic' <<<"${xml}"; then
  # Retry — list may lag WS / GET approvals
  for _ in 1 2 3; do
    sleep 3
    xml="$(ui_dump)"
    grep -qE 'approval-(approve|deny)|Deny tool|Approve tool|PC tool approval|UAT synthetic' <<<"${xml}" && break
  done
fi
if ! grep -qE 'approval-(approve|deny)|Deny tool|Approve tool|PC tool approval|UAT synthetic' <<<"${xml}"; then
  fail "Approval card not visible in Live chat UI — see /sdcard/ui.xml"
fi
log "approval card visible in UI"

TAP_RID="approval-${DECISION}"
TAP_DESC=$([ "${DECISION}" = "approve" ] && echo "Approve tool" || echo "Deny tool")
if ! tap_resource "${TAP_RID}" 4; then
  tap_content_desc "${TAP_DESC}" 3 || fail "Could not tap ${DECISION} control"
fi
log "tapped ${DECISION}"
sleep 6

xml_after="$(ui_dump)"
CARD_AFTER="$(cdp_tool_card_counts)"
log "cdp tool card after: ${CARD_AFTER}"

# Hub list should be empty (resolved)
LIST_AFTER="$(
  HUB_URL="${HUB_URL}" TOKEN="${TOKEN}" SID="${SID}" node - <<'NODE'
const http = require('http');
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
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
  const res = await req(
    'GET',
    '/v1/sessions/' + encodeURIComponent(process.env.SID) + '/approvals',
    { Authorization: 'Bearer ' + process.env.TOKEN },
  );
  process.stdout.write(JSON.stringify(res.body));
})().catch(() => process.exit(1));
NODE
)"
PENDING_COUNT="$(printf '%s' "${LIST_AFTER}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("items") or []))')"
log "hub pending after decide: ${PENDING_COUNT}"

RUN_AFTER="$(printf '%s' "${CARD_AFTER}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("run",0))')"
SKIP_AFTER="$(printf '%s' "${CARD_AFTER}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("skip",0))')"

UI_RESOLVED=0
if grep -qE 'Status: (approved|denied)' <<<"${xml_after}"; then
  UI_RESOLVED=1
fi
if ! grep -qE 'approval-(approve|deny)' <<<"${xml_after}" && [[ "${PENDING_COUNT}" -eq 0 ]]; then
  UI_RESOLVED=1
fi

if [[ "${MODE}" == "live" ]]; then
  DOM_CLEARED=0
  if [[ "${RUN_AFTER}" -lt "${RUN_BEFORE}" || "${SKIP_AFTER}" -lt "${SKIP_BEFORE}" ]]; then
    DOM_CLEARED=1
  fi
  if [[ "${PENDING_COUNT}" -eq 0 && "${UI_RESOLVED}" -eq 1 && "${DOM_CLEARED}" -eq 1 ]]; then
    log "PASS: in-app ${DECISION} · live DOM (tool card cleared) · Hub pending=0"
    log "VERDICT=PASS_LIVE"
    exit 0
  fi
  if [[ "${PENDING_COUNT}" -eq 0 && "${UI_RESOLVED}" -eq 1 ]]; then
    log "PARTIAL: in-app ${DECISION} recorded · live enqueue but DOM clear not evidenced (run ${RUN_BEFORE}->${RUN_AFTER})"
    log "VERDICT=PARTIAL_LIVE_UI"
    exit 0
  fi
  fail "live path incomplete — pending=${PENDING_COUNT} ui_resolved=${UI_RESOLVED} card=${CARD_AFTER}"
fi

# Synthetic path — device UI only
if [[ "${PENDING_COUNT}" -eq 0 && "${UI_RESOLVED}" -eq 1 ]]; then
  log "PARTIAL: in-app ${DECISION} · synthetic only (domApplied=false expected) — not live DOM proof"
  log "VERDICT=PARTIAL_SYNTHETIC"
  exit 0
fi
if [[ "${PENDING_COUNT}" -eq 0 ]]; then
  log "PARTIAL: Hub pending cleared after in-app tap (synthetic); UI status scrape weak"
  log "VERDICT=PARTIAL_SYNTHETIC"
  exit 0
fi
fail "synthetic decide not evidenced — pending=${PENDING_COUNT}"
