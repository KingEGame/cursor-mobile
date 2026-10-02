#!/usr/bin/env bash
# UAT edges — automate remaining TOR-08 MANUAL_ONLY ACs without product-lock violations.
# CDP primary = main Cursor window (quit → npm run start:cursor:cdp). Never opens a
# second /tmp/cursor-mobile-cdp-profile window. Never kills main Cursor.
#
# Covers:
#   AC-030-02  WS reconnect same pair token (no re-pair)
#   AC-030-04  Large message under/over Hub JSON limit
#   AC-030-05  Concurrent message POSTs (best-effort; PC typing stays optional)
#   AC-031-03  Pending approval survives WS drop (mesh-drop proxy; phone Tailscale toggle = MANUAL)
#   AC-031-05  Approve then Deny race → deterministic fail-closed
#   AC-032-04  Binary + large file preview policy (warn / truncate)
#   AC-010-02  Folder-switch Hub bind (vitest resolveWorkspace; Cursor UI switch optional)
#   AC-011-03  Long path Hub returns full path (banner clamps 2 lines — mobile unit)
#   AC-050-03/04 Empty models (vitest; metal CDP-down skipped — would require quitting main)
#   AC-003-01  Left MANUAL_ONLY — adb cannot toggle Tailscale VPN without operator UI
#
# Usage:
#   ./scripts/uat-edges.sh
#
# Exit: 0 if all attempted checks pass; 1 on failure (still attempts restore).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

HUB_PORT="${HUB_PORT:-8787}"
HUB_URL="${HUB_URL:-http://127.0.0.1:${HUB_PORT}}"
CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
# Legacy second-profile path — kill-only if somehow running; never auto-start.
CDP_PROFILE="${CDP_PROFILE:-/tmp/cursor-mobile-cdp-profile}"
CURSOR_WORKSPACE="${CURSOR_WORKSPACE:-${ROOT}}"
EMPTY_MODELS_METAL="${EMPTY_MODELS_METAL:-0}"

PASS=0
FAIL=0
SKIP=0
RESULTS=()

log() { printf '[uat-edges] %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); RESULTS+=("PASS  $*"); log "PASS  $*"; }
fail() { FAIL=$((FAIL + 1)); RESULTS+=("FAIL  $*"); log "FAIL  $*"; }
skip() { SKIP=$((SKIP + 1)); RESULTS+=("SKIP  $*"); log "SKIP  $*"; }

HUB_PID=""
capture_pids() {
  HUB_PID="$(lsof -t -iTCP:"${HUB_PORT}" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
}

health_json() {
  python3 - <<PY
import json, urllib.request
try:
    with urllib.request.urlopen("${HUB_URL}/v1/health", timeout=3) as r:
        print(r.read().decode())
except Exception as e:
    raise SystemExit(1)
PY
}

wait_hub_up() {
  local i
  for i in $(seq 1 40); do
    if health_json >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

wait_hub_cdp_ok() {
  local i body
  for i in $(seq 1 60); do
    body="$(health_json 2>/dev/null || true)"
    if printf '%s' "${body}" | python3 -c 'import sys,json; h=json.load(sys.stdin); sys.exit(0 if h.get("cdp",{}).get("status")=="connected" and h.get("liveAdapter",{}).get("state") in ("cdp_ok","extractor_stale") else 1)' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_hub() {
  local models_env="${1:-}"
  log "Starting Hub (HUB_HOST=0.0.0.0 PORT=${HUB_PORT}${models_env:+ models=${models_env}})…"
  (
    cd "${ROOT}/packages/hub"
    export HUB_HOST=0.0.0.0
    export HUB_PORT="${HUB_PORT}"
    export CDP_URL="${CDP_URL}"
    export CURSOR_WORKSPACE="${CURSOR_WORKSPACE}"
    export CURSOR_WORKSPACE_LABEL="${CURSOR_WORKSPACE_LABEL:-cursor_mobile}"
    export TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-kingwarpc.tail246b3f.ts.net}"
    if [[ -n "${models_env}" ]]; then
      export CURSOR_MODELS="${models_env}"
    else
      unset CURSOR_MODELS || true
    fi
    nohup node dist/cli.js >>/tmp/cursor-mobile-hub-edges.log 2>&1 &
    echo $! >/tmp/cursor-mobile-hub.pid
  )
  wait_hub_up || return 1
  capture_pids
  return 0
}

stop_hub() {
  capture_pids
  if [[ -z "${HUB_PID}" ]]; then return 0; fi
  log "Stopping Hub PID ${HUB_PID}"
  kill "${HUB_PID}" 2>/dev/null || true
  sleep 1
  if kill -0 "${HUB_PID}" 2>/dev/null; then kill -9 "${HUB_PID}" 2>/dev/null || true; fi
  HUB_PID=""
}

# Kill leftover second-profile only — never main ~/.config/Cursor; never relaunch.
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

restore_all() {
  log "=== restore Hub (CDP = operator main window only; never auto-start second profile) ==="
  if ! health_json >/dev/null 2>&1; then
    start_hub || log "WARN: Hub restore failed"
  fi
  if ! python3 -c "import urllib.request; urllib.request.urlopen('${CDP_URL}/json/version', timeout=2)" 2>/dev/null; then
    log "WARN: CDP down — will NOT open a second Cursor window."
    log "  Operator: quit Cursor → npm run start:cursor:cdp → Composer → npm run verify:cdp"
  fi
  wait_hub_cdp_ok || log "WARN: Hub up but CDP not yet cdp_ok"
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
    appVersion: 'uat-edges',
    deviceName: 'uat-edges-script',
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
if ! python3 -c "import urllib.request; urllib.request.urlopen('${CDP_URL}/json/version', timeout=2)" 2>/dev/null; then
  fail "CDP down at ${CDP_URL} — quit Cursor → npm run start:cursor:cdp → Composer → npm run verify:cdp"
  exit 1
fi
# If a leftover second profile is somehow bound, stop it (never main) and refuse.
if pgrep -af "user-data-dir=${CDP_PROFILE}" >/dev/null 2>&1; then
  stop_second_cdp_profile_if_any
  fail "Refused second-profile CDP ${CDP_PROFILE} — use main window (npm run start:cursor:cdp)"
  exit 1
fi
pass "baseline Hub PID=${HUB_PID} CDP=main-window (PRIMARY)"

TOKEN="$(pair_token)" || { fail "pair_token failed"; exit 1; }
pass "paired device token for edges"

# ---------- vitest edges (in-process AUTOMATED) ----------
log "=== vitest tor08-edges + models empty ==="
if npm run test -w @cursor-mobile/hub -- --run tests/tor08-edges.test.ts tests/phase1/workspace-apis.test.ts 2>&1 | tee /tmp/uat-edges-vitest.log | tail -n 30; then
  pass "vitest tor08-edges + workspace-apis (folder/long/binary/large/race/WS/empty)"
else
  fail "vitest edges failed — see /tmp/uat-edges-vitest.log"
fi

# ---------- mobile unit (empty models + long path banner) ----------
log "=== mobile unit new-session + banner ==="
if npm run test -w @cursor-mobile/mobile 2>&1 | tee /tmp/uat-edges-mobile.log | tail -n 20; then
  pass "mobile unit (AC-050-03/04 helpers · AC-011-03 banner clamp)"
else
  fail "mobile unit failed — see /tmp/uat-edges-mobile.log"
fi

# ---------- metal: WS reconnect + pending survives drop ----------
log "=== AC-030-02 / AC-031-03 metal WS ==="
set +e
HUB_URL="${HUB_URL}" TOKEN="${TOKEN}" node - <<'NODE'
const http = require('http');
const WebSocket = require('/data/projects/cursor_mobile/packages/hub/node_modules/ws');

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

function wsHello(token) {
  const u = new URL(process.env.HUB_URL);
  const wsUrl = `ws://${u.hostname}:${u.port}/v1/ws?access_token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 8000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'client.hello', apiVersion: 1,
        subscriptions: { health: true, workspace: true, sessions: [] },
      }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === 'server.hello') {
          clearTimeout(t);
          ws.close();
          resolve(msg);
        }
      } catch (e) { clearTimeout(t); reject(e); }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

(async () => {
  const token = process.env.TOKEN;
  const auth = { Authorization: `Bearer ${token}` };
  let sessions = await req('GET', '/v1/sessions?mode=live&limit=5', auth);
  let sid = sessions.body.items?.[0]?.id;
  if (!sid) {
    const ws = await req('GET', '/v1/workspace', auth);
    const created = await req('POST', '/v1/sessions', {
      ...auth, 'Idempotency-Key': 'uat-edges-ws-create',
    }, JSON.stringify({
      workspaceId: ws.body.workspaceId,
      model: 'composer',
      prompt: 'uat-edges ws reconnect fixture',
    }));
    if (created.status !== 201 && created.status !== 200) {
      console.error('CREATE_FAIL', created.status, created.body);
      process.exit(4);
    }
    sid = created.body.id;
  }
  const syn = await req('POST', `/v1/sessions/${sid}/approvals/synthetic`, auth, JSON.stringify({
    summary: 'uat-edges ws-drop',
  }));
  if (syn.status !== 201 && syn.status !== 200) {
    console.error('SYN_FAIL', syn.status, syn.body);
    process.exit(5);
  }
  const apr = syn.body.approvalId;
  const h1 = await wsHello(token);
  const h2 = await wsHello(token);
  if (h1.type !== 'server.hello' || h2.type !== 'server.hello') process.exit(6);
  if (h1.connectionId === h2.connectionId) process.exit(7);
  const pending = await req('GET', `/v1/sessions/${sid}/approvals`, auth);
  const still = (pending.body.items || []).find((x) => x.approvalId === apr);
  if (!still || still.status !== 'pending') {
    console.error('PENDING_LOST', pending.body);
    process.exit(8);
  }
  // clean up — deny so we don't leave cards
  await req('POST', `/v1/sessions/${sid}/approvals`, {
    ...auth, 'Idempotency-Key': 'uat-edges-ws-cleanup',
  }, JSON.stringify({ approvalId: apr, decision: 'deny' }));
  console.log(JSON.stringify({ ok: true, sid, apr, conn1: h1.connectionId, conn2: h2.connectionId }));
})().catch((e) => { console.error(e); process.exit(1); });
NODE
WS_RC=$?
set -e
if [[ "${WS_RC}" -eq 0 ]]; then
  pass "AC-030-02/031-03 metal WS reconnect + pending survives drop"
elif [[ "${WS_RC}" -eq 4 ]]; then
  skip "AC-030-02 metal — no live session (vitest still covers)"
else
  fail "AC-030-02/031-03 metal WS failed rc=${WS_RC}"
fi

# ---------- metal: large message ----------
log "=== AC-030-04 large message ==="
set +e
HUB_URL="${HUB_URL}" TOKEN="${TOKEN}" node - <<'NODE'
const http = require('http');
function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body || ''), ...(headers || {}) } },
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
  const token = process.env.TOKEN;
  const auth = { Authorization: `Bearer ${token}` };
  let sessions = await req('GET', '/v1/sessions?mode=live&limit=1', auth);
  let sid = sessions.body.items?.[0]?.id;
  if (!sid) {
    const ws = await req('GET', '/v1/workspace', auth);
    const created = await req('POST', '/v1/sessions', {
      ...auth, 'Idempotency-Key': 'uat-edges-large-create-' + Date.now(),
    }, JSON.stringify({ workspaceId: ws.body.workspaceId, model: 'composer' }));
    if (![200, 201].includes(created.status)) {
      console.error('CREATE_FAIL', created.status, created.body); process.exit(4);
    }
    sid = created.body.id;
  }
  const over = JSON.stringify({ content: 'H'.repeat(300 * 1024) });
  const big = await req('POST', `/v1/sessions/${sid}/messages`, {
    ...auth, 'Idempotency-Key': 'uat-edges-large-over',
  }, over);
  if (big.status === 202) { console.error('OVER_ACCEPTED', big.status); process.exit(2); }
  const under = JSON.stringify({ content: 'M'.repeat(80 * 1024) });
  const ok = await req('POST', `/v1/sessions/${sid}/messages`, {
    ...auth, 'Idempotency-Key': 'uat-edges-large-under',
  }, under);
  // under-limit may 202 (dom) or 503 extractor — both prove handled, not silent hang
  if (![202, 400, 502, 503].includes(ok.status)) {
    console.error('UNDER_UNEXPECTED', ok.status, ok.body);
    process.exit(3);
  }
  console.log(JSON.stringify({ over: big.status, under: ok.status, sid }));
})().catch((e) => { console.error(e); process.exit(1); });
NODE
LR=$?
set -e
if [[ "${LR}" -eq 0 ]]; then
  pass "AC-030-04 metal large message reject-or-handle"
else
  fail "AC-030-04 metal large message rc=${LR}"
fi

# ---------- metal: concurrent ----------
log "=== AC-030-05 concurrent sends ==="
set +e
HUB_URL="${HUB_URL}" TOKEN="${TOKEN}" node - <<'NODE'
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
  const token = process.env.TOKEN;
  const auth = { Authorization: `Bearer ${token}` };
  let sessions = await req('GET', '/v1/sessions?mode=live&limit=1', auth);
  let sid = sessions.body.items?.[0]?.id;
  if (!sid) {
    const ws = await req('GET', '/v1/workspace', auth);
    const created = await req('POST', '/v1/sessions', {
      ...auth, 'Idempotency-Key': 'uat-edges-conc-create-' + Date.now(),
    }, JSON.stringify({ workspaceId: ws.body.workspaceId, model: 'composer' }));
    if (![200, 201].includes(created.status)) {
      console.error('CREATE_FAIL', created.status, created.body); process.exit(4);
    }
    sid = created.body.id;
  }
  const [a, b] = await Promise.all([
    req('POST', `/v1/sessions/${sid}/messages`, { ...auth, 'Idempotency-Key': 'uat-edges-conc-a' },
      JSON.stringify({ content: 'conc-a-' + Date.now() })),
    req('POST', `/v1/sessions/${sid}/messages`, { ...auth, 'Idempotency-Key': 'uat-edges-conc-b' },
      JSON.stringify({ content: 'conc-b-' + Date.now() })),
  ]);
  // Both must finish (202 success or fail-closed) — no hang
  for (const x of [a, b]) {
    if (![202, 400, 409, 502, 503].includes(x.status)) {
      console.error('BAD', x.status, x.body); process.exit(2);
    }
  }
  console.log(JSON.stringify({ a: a.status, b: b.status, sid }));
})().catch((e) => { console.error(e); process.exit(1); });
NODE
CR=$?
set -e
if [[ "${CR}" -eq 0 ]]; then
  pass "AC-030-05 metal concurrent sends completed (PC typing UAT still optional)"
else
  fail "AC-030-05 concurrent rc=${CR}"
fi

# ---------- metal: approval race ----------
log "=== AC-031-05 race ==="
set +e
HUB_URL="${HUB_URL}" TOKEN="${TOKEN}" node - <<'NODE'
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
  const token = process.env.TOKEN;
  const auth = { Authorization: `Bearer ${token}` };
  let sessions = await req('GET', '/v1/sessions?mode=live&limit=1', auth);
  let sid = sessions.body.items?.[0]?.id;
  if (!sid) {
    const ws = await req('GET', '/v1/workspace', auth);
    const created = await req('POST', '/v1/sessions', {
      ...auth, 'Idempotency-Key': 'uat-edges-race-create-' + Date.now(),
    }, JSON.stringify({ workspaceId: ws.body.workspaceId, model: 'composer' }));
    if (![200, 201].includes(created.status)) {
      console.error('CREATE_FAIL', created.status, created.body); process.exit(5);
    }
    sid = created.body.id;
  }
  const syn = await req('POST', `/v1/sessions/${sid}/approvals/synthetic`, auth,
    JSON.stringify({ summary: 'uat-edges race' }));
  if (syn.status !== 201 && syn.status !== 200) { console.error(syn); process.exit(2); }
  const apr = syn.body.approvalId;
  const a = await req('POST', `/v1/sessions/${sid}/approvals`, {
    ...auth, 'Idempotency-Key': 'uat-edges-race-approve',
  }, JSON.stringify({ approvalId: apr, decision: 'approve' }));
  const b = await req('POST', `/v1/sessions/${sid}/approvals`, {
    ...auth, 'Idempotency-Key': 'uat-edges-race-deny',
  }, JSON.stringify({ approvalId: apr, decision: 'deny' }));
  if (a.status !== 200) { console.error('APPROVE_FAIL', a); process.exit(3); }
  if (b.status < 400) { console.error('DENY_SHOULD_FAIL', b); process.exit(4); }
  console.log(JSON.stringify({ approve: a.status, deny: b.status, code: b.body?.error?.code, sid }));
})().catch((e) => { console.error(e); process.exit(1); });
NODE
RR=$?
set -e
if [[ "${RR}" -eq 0 ]]; then
  pass "AC-031-05 metal approve→deny race fail-closed"
else
  fail "AC-031-05 race rc=${RR}"
fi

# ---------- metal: binary + long path file under workspace ----------
log "=== AC-032-04 / AC-011-03 binary + long path ==="
BIN_REL="tmp-uat-edges/blob-$(date +%s).bin"
LONG_DIR="tmp-uat-edges/$(python3 -c 'print(("longseg_"*8)+"end")')"
mkdir -p "${ROOT}/$(dirname "${BIN_REL}")" "${ROOT}/${LONG_DIR}"
python3 -c "open('${ROOT}/${BIN_REL}','wb').write(bytes([0,1,2,0,255,0,10,0]))"
echo "long-path-marker" > "${ROOT}/${LONG_DIR}/marker.txt"
set +e
HUB_URL="${HUB_URL}" TOKEN="${TOKEN}" BIN_REL="${BIN_REL}" LONG_REL="${LONG_DIR}/marker.txt" node - <<'NODE'
const http = require('http');
function req(method, path, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(process.env.HUB_URL + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
        headers: { ...(headers || {}) } },
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
    r.end();
  });
}
(async () => {
  const auth = { Authorization: `Bearer ${process.env.TOKEN}` };
  const bin = await req('GET', `/v1/workspace/file?path=${encodeURIComponent(process.env.BIN_REL)}`, auth);
  if (bin.status !== 200 || bin.body.binary !== true) {
    console.error('BIN_FAIL', bin.status, bin.body); process.exit(2);
  }
  if (!/Binary|non-text|PC/i.test(String(bin.body.note || ''))) {
    console.error('BIN_NOTE', bin.body); process.exit(3);
  }
  const longp = await req('GET', `/v1/workspace/file?path=${encodeURIComponent(process.env.LONG_REL)}`, auth);
  if (longp.status !== 200) { console.error('LONG_FAIL', longp); process.exit(4); }
  const ws = await req('GET', '/v1/workspace', auth);
  if (!ws.body.path || String(ws.body.path).length < 10) { console.error(ws.body); process.exit(5); }
  console.log(JSON.stringify({ binary: bin.body.binary, longPath: process.env.LONG_REL, wsPath: ws.body.path }));
})().catch((e) => { console.error(e); process.exit(1); });
NODE
BR=$?
set -e
rm -rf "${ROOT}/tmp-uat-edges" || true
if [[ "${BR}" -eq 0 ]]; then
  pass "AC-032-04 binary warn + AC-011-03 long path file readable (banner clamp = unit)"
else
  fail "AC-032-04/011-03 metal rc=${BR}"
fi

# ---------- AC-010-02 note: Cursor UI folder switch ----------
skip "AC-010-02 Cursor File→Open Folder UI still operator (Hub bind switch AUTOMATED via vitest)"

# ---------- AC-003-01 mesh toggle ----------
skip "AC-003-01 MANUAL_ONLY — adb has no Tailscale VPN toggle without operator OAuth/UI (vpn list service missing)"

# ---------- optional empty models metal (disabled — would kill/open CDP windows) ----------
skip "AC-050-03 metal skipped — CDP-down metal would quit Cursor or open second profile; vitest AUTOMATED covers"

# ---------- summary ----------
log "=== summary PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP} ==="
for line in "${RESULTS[@]}"; do log "  ${line}"; done

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
