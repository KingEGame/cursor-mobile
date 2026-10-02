#!/usr/bin/env bash
# adb UAT: New Session sheet on Pixel — models from Hub (CDP scrape when up,
# env stub when CursorDown), optional multi-attach via deep-link inject,
# Create → Hub (201 metal when cdp_ok, or 202 create-queue when CURSOR_DOWN).
#
# HARD BAN: never rely on RN controlled TextInput + adb `input text` for the
# prompt (React state stays empty → promptHit=false). Use deep-link inject:
#   cursor-companion://new?prompt=&model=&attach=&attach=&auto=1
#
# No-CDP primary (default): when MAIN :9222 is down, deep-link → Hub
# lastSessionCreateAttempt with non-empty prompt (+ queued when Hub supports
# create-queue) is RESULT PASS_QUEUE_202 (exit 0). Set REQUIRE_CDP_METAL=1 to
# keep the old exit-2 "wait for CDP metal" gate.
#
# Usage:
#   ./scripts/adb-new-session-uat.sh
#   ATTACH_COUNT=2 ./scripts/adb-new-session-uat.sh
#   SKIP_APK_BUILD=1 ./scripts/adb-new-session-uat.sh
#   REQUIRE_CDP_METAL=1 ./scripts/adb-new-session-uat.sh
#
# Env:
#   PIXEL_SERIAL    default 33080DLH20007Y
#   HUB_URL         default http://127.0.0.1:8787
#   ATTACH_COUNT    0|1|2 (default 2) — deep-link inject that many workspace files
#   SKIP_ATTACH     1 to skip attachments (create with zero attachments)
#   SKIP_APK_BUILD  1 to skip assembleRelease / install
#   MODEL_ID        optional model chip id (default: first available from Hub)
#   USE_PICKER_UI   1 to also try file-picker UI (default 0 — deep-link only)
#   REQUIRE_CDP_METAL 1 = exit 2 when CDP down after DEEP_LINK_POST_OK (legacy)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

PIXEL_SERIAL="${PIXEL_SERIAL:-33080DLH20007Y}"
HUB_URL="${HUB_URL:-http://127.0.0.1:8787}"
COMPANION_PKG="${COMPANION_PKG:-local.cursor.mobile}"
ATTACH_COUNT="${ATTACH_COUNT:-2}"
SKIP_ATTACH="${SKIP_ATTACH:-0}"
SKIP_APK_BUILD="${SKIP_APK_BUILD:-0}"
USE_PICKER_UI="${USE_PICKER_UI:-0}"
REQUIRE_CDP_METAL="${REQUIRE_CDP_METAL:-0}"
APK_PATH="${APK_PATH:-apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
PROMPT_MSG="${UAT_PROMPT:-adb-new-session-$(date -u +%Y%m%dT%H%M%SZ)}"

log() { printf '[adb-new-session] %s\n' "$*"; }
fail() { log "FAIL: $*"; exit 1; }

adb_bin() { adb -s "${PIXEL_SERIAL}" "$@"; }

ui_dump() {
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
  local tries="${2:-4}"
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
    if center="$(_node_center content-desc "${rid}" "${ui_file}")"; then
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

tap_text() {
  local text="$1"
  local tries="${2:-3}"
  local center x y ui_file i
  for ((i = 1; i <= tries; i++)); do
    ui_file="$(mktemp)"
    printf '%s' "$(ui_dump)" >"${ui_file}"
    if center="$(_node_center text "${text}" "${ui_file}")"; then
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

hub_catalog() {
  HUB_URL="${HUB_URL}" MODEL_ID="${MODEL_ID:-}" node - <<'NODE'
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
    appVersion: 'adb-new-session',
    deviceName: 'adb-new-session-script',
  }));
  const token = complete.body.deviceToken;
  const auth = { Authorization: 'Bearer ' + token };
  const models = await req('GET', '/v1/workspace/models?refresh=1', auth);
  const list = models.body.models || [];
  let model = process.env.MODEL_ID || '';
  if (!model) {
    model = list.find((m) => m.available)?.id || list[0]?.id || '';
  }
  const files = await req('GET', '/v1/workspace/files?q=package.json&limit=8', auth);
  const filePaths = (files.body.items || [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.path);
  const before = await req('GET', '/v1/workspace', auth).then(async (ws) => {
    const live = await req(
      'GET',
      '/v1/sessions?workspaceId=' + ws.body.workspaceId + '&mode=live&limit=20',
      auth,
    );
    return { workspaceId: ws.body.workspaceId, liveIds: (live.body.items || []).map((i) => i.id) };
  });
  process.stdout.write(JSON.stringify({
    token,
    model,
    modelsSource: models.body.source,
    modelsCount: list.length,
    domSelectVerified: models.body.domSelectVerified === true,
    filePaths,
    workspaceId: before.workspaceId,
    liveIdsBefore: before.liveIds,
  }));
})().catch(() => process.exit(1));
NODE
}

verify_new_live() {
  HUB_URL="${HUB_URL}" NEEDLE="${1}" LIVE_BEFORE="${2}" EXPECT_ATTACH="${3:-0}" node - <<'NODE'
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
  const complete = await req('POST', '/v1/pair/complete', {}, JSON.stringify({
    pairId: start.body.pairId,
    code: start.body.code,
    platform: 'android',
    appVersion: 'adb-new-session-verify',
    deviceName: 'adb-new-session-verify',
  }));
  const token = complete.body.deviceToken;
  const auth = { Authorization: 'Bearer ' + token };
  const ws = await req('GET', '/v1/workspace', auth);
  const live = await req(
    'GET',
    '/v1/sessions?workspaceId=' + ws.body.workspaceId + '&mode=live&limit=20',
    auth,
  );
  const before = new Set(JSON.parse(process.env.LIVE_BEFORE || '[]'));
  const items = live.body.items || [];
  const newest = items.find((i) => !before.has(i.id)) || items[0];
  if (!newest) process.exit(4);
  const detail = await req('GET', '/v1/sessions/' + encodeURIComponent(newest.id), auth);
  const msgs = detail.body?.transcript?.messages ?? [];
  const needle = process.env.NEEDLE || '';
  const title = String(newest.title || detail.body?.title || '');
  const inMsgs = msgs.some((m) => String(m.content || '').includes(needle));
  const inTitle = !!(needle && title.includes(needle));
  const hit = !needle || inMsgs || inTitle;
  const atts = detail.body?.attachments || [];
  const expectAttach = Number(process.env.EXPECT_ATTACH || '0');
  const attOk = expectAttach <= 0 || (Array.isArray(atts) && atts.length >= expectAttach);
  process.stdout.write(JSON.stringify({
    sessionId: newest.id,
    title,
    promptHit: hit,
    promptInMessages: inMsgs,
    promptInTitle: inTitle,
    attachmentCount: Array.isArray(atts) ? atts.length : 0,
    attachments: atts,
    expectAttach,
    attOk,
  }));
  if (!hit) process.exit(5);
  if (!attOk) process.exit(6);
  process.exit(0);
})().catch(() => process.exit(1));
NODE
}

build_new_session_deeplink() {
  PROMPT_MSG="${PROMPT_MSG}" MODEL="${MODEL}" ATTACH_JSON="${1}" python3 - <<'PY'
import json, os, urllib.parse
prompt = os.environ["PROMPT_MSG"]
model = os.environ.get("MODEL") or ""
attach = json.loads(os.environ.get("ATTACH_JSON") or "[]")
qs = [("prompt", prompt)]
if model:
    qs.append(("model", model))
for p in attach:
    if p:
        qs.append(("attach", p))
qs.append(("auto", "1"))
print("cursor-companion://new?" + urllib.parse.urlencode(qs, doseq=True))
PY
}

command -v adb >/dev/null || fail "adb not on PATH"
adb_bin get-state >/dev/null 2>&1 || fail "Pixel ${PIXEL_SERIAL} not authorized"

# HARD BAN guard — never proceed while second CDP profile holds :9222
if command -v npm >/dev/null; then
  npm run assert:no-second-cdp >/dev/null || fail "second CDP profile running — SECOND_CDP_KILL=1 npm run assert:no-second-cdp"
fi

log "=== Hub catalog ==="
CATALOG_JSON="$(hub_catalog)" || fail "Hub catalog / pair failed"
MODEL="$(printf '%s' "${CATALOG_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["model"])')"
MODELS_SRC="$(printf '%s' "${CATALOG_JSON}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("modelsSource"), d.get("modelsCount"), "dom=", d.get("domSelectVerified"))')"
LIVE_BEFORE="$(printf '%s' "${CATALOG_JSON}" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin).get("liveIdsBefore") or []))')"
FILE_PATHS="$(printf '%s' "${CATALOG_JSON}" | python3 -c 'import sys,json; print("\n".join(json.load(sys.stdin).get("filePaths") or []))')"
[[ -n "${MODEL}" ]] || fail "No model from Hub CDP scrape catalog"
log "models: ${MODELS_SRC}"
log "model chip: ${MODEL}"
log "prompt: ${PROMPT_MSG}"

ATTACH_LIST_JSON='[]'
EXPECT_ATTACH=0
if [[ "${SKIP_ATTACH}" != "1" && "${ATTACH_COUNT}" -gt 0 ]]; then
  ATTACH_LIST_JSON="$(printf '%s' "${FILE_PATHS}" | ATTACH_COUNT="${ATTACH_COUNT}" python3 - <<'PY'
import json, os, sys
n = int(os.environ.get("ATTACH_COUNT") or "2")
paths = [ln.strip() for ln in sys.stdin if ln.strip()]
# Fallback workspace-relative paths when Hub file search returns empty (CDP down / stub).
if not paths:
    paths = ["package.json", "README.md", "apps/mobile/package.json"]
print(json.dumps(paths[:n]))
PY
)"
  EXPECT_ATTACH="$(printf '%s' "${ATTACH_LIST_JSON}" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')"
fi
DEEPLINK="$(build_new_session_deeplink "${ATTACH_LIST_JSON}")"
log "deep-link: ${DEEPLINK:0:120}..."
log "expectAttach: ${EXPECT_ATTACH}"

if [[ "${SKIP_APK_BUILD}" != "1" ]]; then
  log "=== assembleRelease + install ==="
  [[ -d apps/mobile/android ]] || fail "android/ missing — run expo prebuild first"
  (cd apps/mobile/android && ./gradlew assembleRelease -q) || fail "assembleRelease failed"
  adb_bin install -r "${APK_PATH}" || fail "adb install failed"
else
  log "SKIP_APK_BUILD=1 — using installed APK"
fi

log "=== Launch Health → Ready ==="
adb_bin shell am force-stop "${COMPANION_PKG}" || true
sleep 1
adb_bin shell am start -a android.intent.action.VIEW \
  -d 'cursor-companion://health' -f 0x14008000 \
  -n "${COMPANION_PKG}/.MainActivity" >/dev/null
sleep 4
if ! tap_resource "health-refresh"; then
  fail "health-refresh not found — pair APK to Hub first"
fi
ready=0
cdp_off=0
for _ in $(seq 1 15); do
  sleep 2
  xml="$(ui_dump)"
  if grep -q 'State: Ready' <<<"${xml}" && grep -qE 'Workspace|cursor_mobile' <<<"${xml}"; then
    ready=1
    break
  fi
  # CDP down on MAIN: Health shows CDPOff but Hub+workspace may still be bound —
  # allow deep-link inject proof (create POST) without claiming full metal Pass.
  if grep -qE 'State: CDPOff|State: Degraded' <<<"${xml}" && grep -qE 'Hub: http|Workspace|cursor_mobile' <<<"${xml}"; then
    cdp_off=1
    ready=1
    break
  fi
  if grep -q 'State: Unknown' <<<"${xml}"; then
    tap_resource "health-refresh" 1 || true
  fi
done
[[ "${ready}" -eq 1 ]] || fail "Health never Ready/CDPOff with workspace (pair + Tailscale mesh required)"
if [[ "${cdp_off}" -eq 1 ]]; then
  log "PASS: Health CDPOff/Degraded + Hub bound (MAIN :9222 down — deep-link proof only)"
else
  log "PASS: Health Ready + workspace bound"
fi

log "=== Deep-link inject New session (prompt+model+attach+auto) ==="
# Do NOT type into TextInput — RN controlled state ignores adb.
# Quote -d for adb shell so '&' in query is not interpreted as shell background.
adb_bin shell am start -a android.intent.action.VIEW \
  -d "'${DEEPLINK}'" -f 0x14008000 \
  -n "${COMPANION_PKG}/.MainActivity" >/dev/null
sleep 4

if [[ "${USE_PICKER_UI}" == "1" && "${EXPECT_ATTACH}" -gt 0 ]]; then
  log "USE_PICKER_UI=1 — supplemental picker taps (non-blocking)"
  tap_resource "new-session-add-files" 2 || true
fi

# Detect MAIN CDP before requiring live session metal
CDP_UP=0
if curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/json/version 2>/dev/null | grep -q '^200$'; then
  CDP_UP=1
fi
log "MAIN :9222 up=${CDP_UP} (HARD BAN: never use /tmp/cursor-mobile-cdp-profile)"

live_ok=0
create_err=0
prompt_ui=0
for _ in $(seq 1 20); do
  sleep 2
  xml="$(ui_dump)"
  if grep -Fq "${PROMPT_MSG}" <<<"${xml}"; then
    prompt_ui=1
  fi
  if grep -qE 'live-chat-composer|Live chat|Message input' <<<"${xml}"; then
    live_ok=1
    break
  fi
  if grep -qE 'CDP_UNAVAILABLE|Create failed|new-session-create-error|LIVE_PATH|cursor_down' <<<"${xml}"; then
    create_err=1
    log "create error visible in UI (expected when MAIN CDP down)"
    break
  fi
done

# Poll Hub health for lastSessionCreateAttempt OR create-queue item matching our prompt
HUB_ATTEMPT=""
MATCHED=0
for _ in $(seq 1 15); do
  HUB_ATTEMPT="$(curl -s -m 3 "${HUB_URL}/v1/health" 2>/dev/null || curl -s -m 3 "${HUB_URL}/health" 2>/dev/null || true)"
  if HUB_JSON="${HUB_ATTEMPT}" PROMPT_MSG="${PROMPT_MSG}" EXPECT_ATTACH="${EXPECT_ATTACH}" python3 -c '
import json, os, sys
try:
    d = json.loads(os.environ.get("HUB_JSON") or "")
except Exception:
    sys.exit(1)
needle = os.environ.get("PROMPT_MSG") or ""
expect_att = int(os.environ.get("EXPECT_ATTACH") or "0")
if not needle:
    sys.exit(1)
att = (d.get("liveAdapter") or {}).get("lastSessionCreateAttempt") or {}
prefix = str(att.get("promptPrefix") or "")
ok = bool(needle[:64] in prefix and int(att.get("promptLen") or 0) > 0)
if ok and expect_att > 0 and int(att.get("attachmentCount") or 0) < expect_att:
    ok = False
qitems = ((d.get("sessionCreateQueue") or {}).get("items") or [])
for it in qitems:
    pfx = str(it.get("promptPrefix") or "")
    if needle[:64] in pfx and int(it.get("promptLen") or 0) > 0:
        if expect_att <= 0 or int(it.get("attachmentCount") or 0) >= expect_att:
            ok = True
            att = {"via": "sessionCreateQueue", **it}
            break
print(json.dumps(att) if att else "{}")
sys.exit(0 if ok else 1)
'; then
    MATCHED=1
    log "PASS: Hub create attempt/queue matches deep-link prompt (+attaches)"
    break
  fi
  sleep 2
done

if [[ "${live_ok}" -eq 1 ]]; then
  log "PASS: navigated to Live chat after deep-link Create"
elif [[ "${CDP_UP}" -eq 0 ]]; then
  log "NO_CDP_PRIMARY: MAIN :9222 down — proving deep-link → Hub create (202 queue or CURSOR_DOWN attempt)"
  if [[ "${prompt_ui}" -eq 1 ]]; then
    log "PASS: prompt visible in UI after deep-link inject (no TextInput adb)"
  else
    log "WARN: prompt not scraped from UI (RN may not expose value); Hub queue/attempt is source of truth"
  fi
  if [[ "${MATCHED}" -eq 1 ]] || HUB_JSON="${HUB_ATTEMPT}" PROMPT_MSG="${PROMPT_MSG}" EXPECT_ATTACH="${EXPECT_ATTACH}" python3 -c '
import json, os, sys
try:
    d = json.loads(os.environ.get("HUB_JSON") or "")
except Exception:
    sys.exit(1)
needle = os.environ.get("PROMPT_MSG") or ""
expect_att = int(os.environ.get("EXPECT_ATTACH") or "0")
if not needle:
    sys.exit(1)
att = (d.get("liveAdapter") or {}).get("lastSessionCreateAttempt") or {}
ok = bool(needle[:64] in str(att.get("promptPrefix") or "") and int(att.get("promptLen") or 0) > 0)
if ok and expect_att > 0 and int(att.get("attachmentCount") or 0) < expect_att:
    ok = False
for it in ((d.get("sessionCreateQueue") or {}).get("items") or []):
    if needle[:64] in str(it.get("promptPrefix") or "") and int(it.get("promptLen") or 0) > 0:
        if expect_att <= 0 or int(it.get("attachmentCount") or 0) >= expect_att:
            ok = True
            break
print(json.dumps({"matched": ok, "pending": (d.get("sessionCreateQueue") or {}).get("pending")}))
sys.exit(0 if ok else 1)
'; then
    if [[ "${REQUIRE_CDP_METAL}" == "1" ]]; then
      log "RESULT: DEEP_LINK_POST_OK; REQUIRE_CDP_METAL=1 → exit 2 (legacy CDP wait)"
      log "HARD BAN: never launch /tmp/cursor-mobile-cdp-profile"
      exit 2
    fi
    log "RESULT: PASS_QUEUE_202 (device New-session → Hub CURSOR_DOWN create-queue; no CDP metal claimed)"
    log "SCOPE: operator CDP relaunch OUT OF SCOPE — AC-081-02/AC-X-01 stay PARTIAL (FR-053 Composer apply)"
    log "HARD BAN: never launch /tmp/cursor-mobile-cdp-profile / never start Cursor"
    exit 0
  fi
  fail "Deep-link did not produce Hub create-queue/attempt with prompt+attaches"
fi

VERIFY="$(LIVE_BEFORE="${LIVE_BEFORE}" EXPECT_ATTACH="${EXPECT_ATTACH}" verify_new_live "${PROMPT_MSG}" "${LIVE_BEFORE}" "${EXPECT_ATTACH}")" || {
  log "verify body: ${VERIFY:-}"
  fail "Hub did not evidence new live session / prompt (deep-link inject)"
}
log "Hub verify: ${VERIFY}"
SID="$(printf '%s' "${VERIFY}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionId"])')"
ATT_N="$(printf '%s' "${VERIFY}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("attachmentCount",0))')"
PROMPT_HIT="$(printf '%s' "${VERIFY}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("promptHit"))')"
[[ "${PROMPT_HIT}" == "True" || "${PROMPT_HIT}" == "true" ]] || fail "promptHit not true — deep-link prompt missing from Hub session"
log "PASS: new live session ${SID} attachments=${ATT_N} promptHit=${PROMPT_HIT}"
log "RESULT: PASS (device New session deep-link → Hub/CDP create path)"
exit 0
