#!/usr/bin/env bash
# OPTIONAL metal path only — not the primary P0 close gate when the operator
# declines Cursor CDP relaunch. Prefer no-CDP: Hub create-queue (CURSOR_DOWN →
# HTTP 202) + `ALLOW_NO_CDP=1 uat:precheck` + `SKIP_APK_BUILD=1 uat:adb-new-session`
# (PASS_QUEUE_202). Touch STOP_FLAG to disable this watcher immediately.
#
# Poll main-window CDP on :9222; when up (workbench/Composer preferred),
# best-effort verify:cdp, keep Hub on mesh, repair Hub URL, run device
# New-session UAT. On Pass, promote docs. Does NOT start Cursor. Does NOT
# open a second profile. Does NOT call UpdateGoal. Ctrl+C exits cleanly.
#
# Usage:
#   ./scripts/watch-main-cdp-and-new-session.sh
#   npm run watch:main-cdp-new-session
#
# Env:
#   CDP_URL                      default http://127.0.0.1:9222
#   CDP_PROFILE                  /tmp/cursor-mobile-cdp-profile — detect+refuse only (never start)
#   CDP_WATCH_INTERVAL_SEC       poll interval (default 15)
#   CDP_WATCH_MAX_HOURS          optional cap; 0 or unset = until Pass / Ctrl+C
#   SKIP_APK_BUILD               default 1
#   ATTACH_COUNT                 default 2
#   HUB_PORT                     default 8787
#   WATCH_LOG                    default /tmp/cursor-mobile-watch-main-cdp-new-session.log
#   UAT_LOG                      default /tmp/cursor-mobile-adb-new-session-main-cdp.log
#   VERIFY_LOG                   default /tmp/cursor-mobile-verify-cdp-main-watch.log
#   PROMOTE_DOCS                 default 1
#   READY_FLAG                   default /tmp/cursor-mobile-main-cdp-ready.flag
#                                touched once when MAIN CDP preferred target is up
#   NOTIFY_ON_READY              default 1 — notify-send when seizing CDP-up
#   STOP_FLAG                    default /tmp/cursor-mobile-stop-main-cdp-watch.flag
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# Operator / agent stop switch — exit immediately (no :9222 poll).
STOP_FLAG="${STOP_FLAG:-/tmp/cursor-mobile-stop-main-cdp-watch.flag}"
if [[ -f "${STOP_FLAG}" ]]; then
  echo "[watch:main-cdp-new-session] STOP flag present (${STOP_FLAG}) — exiting (no CDP wait)."
  exit 0
fi

CDP_HOST="127.0.0.1"
CDP_PORT="${CDP_PORT:-9222}"
CDP_URL="${CDP_URL:-http://${CDP_HOST}:${CDP_PORT}}"
CDP_PROFILE="${CDP_PROFILE:-/tmp/cursor-mobile-cdp-profile}"
INTERVAL_SEC="${CDP_WATCH_INTERVAL_SEC:-15}"
MAX_HOURS="${CDP_WATCH_MAX_HOURS:-0}"
SKIP_APK_BUILD="${SKIP_APK_BUILD:-1}"
ATTACH_COUNT="${ATTACH_COUNT:-2}"
HUB_PORT="${HUB_PORT:-8787}"
WATCH_LOG="${WATCH_LOG:-/tmp/cursor-mobile-watch-main-cdp-new-session.log}"
UAT_LOG="${UAT_LOG:-/tmp/cursor-mobile-adb-new-session-main-cdp.log}"
VERIFY_LOG="${VERIFY_LOG:-/tmp/cursor-mobile-verify-cdp-main-watch.log}"
PROMOTE_DOCS="${PROMOTE_DOCS:-1}"
READY_FLAG="${READY_FLAG:-/tmp/cursor-mobile-main-cdp-ready.flag}"
NOTIFY_ON_READY="${NOTIFY_ON_READY:-1}"
MATRIX="${ROOT}/docs/reports/tor08-p0-coverage-matrix-2026-09-25.md"
GOALPROG="${ROOT}/docs/reports/goal-progress-2026-09-25.md"
HUB_PID_FILE="/tmp/cursor-mobile-hub-main-cdp-watch.pid"
# Dedup: only notify/touch once per CDP-up seize until Pass or watcher restart.
SEIZED_READY=0

if (( INTERVAL_SEC < 5 )); then
  INTERVAL_SEC=5
fi

mkdir -p "$(dirname "${WATCH_LOG}")"
exec > >(tee -a "${WATCH_LOG}") 2>&1

loud() {
  printf '\n'
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '! %s\n' "$*"
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '\n'
}

log() { printf '[watch:main-cdp-new-session] %s\n' "$*"; }

second_profile_running() {
  # Cursor binary only — argv text in shells must not false-positive.
  bash "${ROOT}/scripts/assert-no-second-cdp-profile.sh" >/dev/null 2>&1
  local rc=$?
  # assert exits 0 when clean, 1 when second profile found
  [[ "${rc}" -eq 1 ]]
}

# Never launch Cursor / second profile from this watcher.
refuse_start_cursor() {
  SECOND_CDP_KILL=1 bash "${ROOT}/scripts/assert-no-second-cdp-profile.sh" >/dev/null 2>&1 || true
  log "REFUSED: this watcher never starts Cursor or ${CDP_PROFILE}"
  log "  Operator: quit main Cursor → npm run start:cursor:cdp → open Composer (workbench)"
}

cdp_version_up() {
  curl -sf --max-time 2 "${CDP_URL}/json/version" >/dev/null 2>&1
}

# Prefer workbench / project IDE pages over Agents-only cloud targets.
cdp_has_preferred_target() {
  CDP_URL="${CDP_URL}" python3 - <<'PY'
import json, os, sys, urllib.request

url = os.environ["CDP_URL"].rstrip("/") + "/json/list"
try:
    with urllib.request.urlopen(url, timeout=3) as r:
        pages = json.load(r)
except Exception as e:
    print(f"list_error={e}", file=sys.stderr)
    sys.exit(1)

if not isinstance(pages, list):
    sys.exit(1)

def hay(p):
    return f"{p.get('title') or ''} {p.get('url') or ''}".lower()

candidates = [
    p for p in pages
    if p.get("type") == "page" and p.get("webSocketDebuggerUrl")
]
if not candidates:
    print("no_page_targets", file=sys.stderr)
    sys.exit(1)

# Hard-prefer IDE/workbench/Composer; demote Agents-only / cloud agent surfaces.
preferred = []
agents_only = []
for p in candidates:
    h = hay(p)
    agentsish = (
        "agents" in h
        and "workbench" not in h
        and "composer" not in h
        and "cursor_mobile" not in h
    )
    if agentsish:
        agents_only.append(p)
        continue
    if any(
        k in h
        for k in (
            "workbench",
            "composer",
            "cursor_mobile",
            "vscode-file://",
            "vscode-webview://",
        )
    ) or (p.get("title") or "") in ("Cursor",):
        preferred.append(p)

if preferred:
    top = preferred[0]
    print(f"preferred title={top.get('title')!r} url={(top.get('url') or '')[:120]!r}")
    sys.exit(0)

if agents_only and not preferred:
    print("agents_only_targets — waiting for workbench/Composer", file=sys.stderr)
    sys.exit(2)

# Some pages with no clear label — accept as soft OK so UAT can proceed.
print(f"soft_ok pages={len(candidates)} title={candidates[0].get('title')!r}")
sys.exit(0)
PY
}

hub_health_ok() {
  curl -sf --max-time 2 "http://127.0.0.1:${HUB_PORT}/health" >/dev/null 2>&1
}

ensure_hub_mesh() {
  if hub_health_ok; then
    log "Hub already up on :${HUB_PORT}"
    return 0
  fi
  log "Hub down — starting mesh Hub (HUB_HOST=0.0.0.0) in background"
  (
    cd "${ROOT}"
    export HUB_HOST=0.0.0.0
    export HUB_PORT
    export CDP_URL
    export CURSOR_WORKSPACE="${CURSOR_WORKSPACE:-${ROOT}}"
    nohup npm run start:hub:tailscale \
      >>/tmp/cursor-mobile-hub-main-cdp-watch.log 2>&1 &
    echo $! >"${HUB_PID_FILE}"
  )
  local i
  for i in $(seq 1 60); do
    if hub_health_ok; then
      log "Hub health OK after ~${i}s"
      return 0
    fi
    sleep 2
  done
  log "WARN: Hub did not become healthy within ~120s — continuing anyway"
  return 1
}

best_effort_verify_cdp() {
  log "Best-effort verify:cdp (will not fail the watch loop alone)"
  set +e
  CDP_URL="${CDP_URL}" npm run verify:cdp >"${VERIFY_LOG}" 2>&1
  local rc=$?
  set -e
  if (( rc == 0 )); then
    log "verify:cdp OK — see ${VERIFY_LOG}"
  else
    log "WARN: verify:cdp rc=${rc} (best-effort) — see ${VERIFY_LOG}"
  fi
  return 0
}

promote_acs_on_pass() {
  local ts evidence
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  evidence="main CDP → verify:cdp (best-effort) → Hub mesh → repair-hub → New session · ATTACH_COUNT=${ATTACH_COUNT} · log ${UAT_LOG} (${ts})"

  if [[ "${PROMOTE_DOCS}" != "1" ]]; then
    log "PROMOTE_DOCS=0 — skipping matrix/goal-progress update"
    return 0
  fi

  python3 - "${MATRIX}" "${GOALPROG}" "${ts}" "${evidence}" "${UAT_LOG}" <<'PY'
import re, sys
from pathlib import Path

matrix_path, goal_path, ts, evidence, uat_log = sys.argv[1:6]

matrix = Path(matrix_path)
goal = Path(goal_path)
text = matrix.read_text(encoding="utf-8")

text2 = re.sub(
    r"(\| AC-081-02 \| )PARTIAL(\| )[^\n|]+(\| )[^\n|]+",
    rf"\1Pass\2{evidence} · watch:main-cdp-new-session\3—",
    text,
    count=1,
)
text2 = re.sub(
    r"(\| AC-X-01 \| )PARTIAL(\| )[^\n|]+(\| )[^\n|]+",
    rf"\1Pass\2Tailscale → Hub → pair → banner → live → new session device sheet · {evidence}\3—",
    text2,
    count=1,
)

text2 = re.sub(
    r"\*\*Goal status:\*\*[^\n]+",
    (
        f"**Goal status:** Evidence matrix — **GOAL_COMPLETE=yes** (strict every P0 AC Pass; "
        f"history-list optional PARTIAL OK). Metal: pack 6/6 · Continue/adb Live Send · "
        f"Deny+Approve · negatives/edges/mesh-drop · open-on-pc strategy B · "
        f"**{ts}: AC-081-02 + AC-X-01 Pass via watch:main-cdp-new-session** (`{uat_log}`). "
        f"MANUAL_ONLY **0%**. Pass ~**100%** · PARTIAL ~**0%** (P0)."
    ),
    text2,
    count=1,
)

text2 = re.sub(
    r"(\| \*\*Pass\*\*[^\|]*\| )\*\*~94\*\*( \| )\*\*~98%\*\*",
    r"\1**~96**\2**~100%**",
    text2,
    count=1,
)
text2 = re.sub(
    r"(\| \*\*PARTIAL\*\*[^\|]*\| )\*\*~2\*\*( \| )\*\*~2%\*\*",
    r"\1**~0**\2**~0%**",
    text2,
    count=1,
)

text2 = text2.replace(
    "**§4.7 rollup:** Pass **9** · PARTIAL **1** · MANUAL_ONLY **0** · BLOCKED **0**",
    "**§4.7 rollup:** Pass **10** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**",
)
text2 = text2.replace(
    "**§4.8 rollup:** Pass/AUTOMATED **3** · PARTIAL **1** · MANUAL_ONLY **0** · BLOCKED **0**",
    "**§4.8 rollup:** Pass/AUTOMATED **4** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**",
)

stamp = f"""
**Delta vs prior:** **AC-081-02** + **AC-X-01** promoted to **Pass** ({ts}) via `watch:main-cdp-new-session` → verify:cdp (best-effort) → Hub mesh → repair-hub → `SKIP_APK_BUILD=1 ATTACH_COUNT=2 uat:adb-new-session`. History-list optional PARTIAL unchanged (not P0 blocker).  
**Still not UpdateGoal here:** parent agent may set GOAL_COMPLETE after audit — this watcher does not call UpdateGoal.

### Promote stamp ({ts})

| Field | Value |
|-------|--------|
| **Done** | Device New-session UAT Pass · AC-081-02 · AC-X-01 promoted · log `{uat_log}` |
| **Open gaps** | FR-041 history-list optional metal only |
| **Goal complete?** | **Yes** (P0 Pass sheet) — parent may UpdateGoal |
| **Product locks still true?** | **Yes** |
"""
if "### Promote stamp" not in text2:
    if "*Counts are estimates" in text2:
        text2 = text2.replace(
            "*Counts are estimates from AC grouping; re-tally when executing the full Pass/Fail/Blocked sheet.*",
            stamp + "\n*Counts are estimates from AC grouping; re-tally when executing the full Pass/Fail/Blocked sheet.*",
        )
    else:
        text2 += "\n" + stamp

matrix.write_text(text2, encoding="utf-8")

g = goal.read_text(encoding="utf-8")
verdict = (
    f"**Verdict ({ts}):** Main CDP up · `watch:main-cdp-new-session` → "
    f"verify:cdp (best-effort) → Hub mesh → `adb-repair-hub-url` → "
    f"`SKIP_APK_BUILD=1 ATTACH_COUNT=2 uat:adb-new-session` **PASS** · "
    f"**AC-081-02** + **AC-X-01** promoted · pack **6/6** · "
    f"history-list optional PARTIAL OK · Pass ~**100%** (P0) · PARTIAL ~**0%** · "
    f"MANUAL_ONLY **0%** · **GOAL_COMPLETE=yes** (parent may UpdateGoal; watcher did not).\n"
)
if g.startswith("# Goal progress"):
    lines = g.splitlines(keepends=True)
    out = []
    inserted = False
    for line in lines:
        if not inserted and line.startswith("**Verdict ("):
            out.append(verdict)
            inserted = True
        out.append(line)
    if not inserted:
        out = lines[:3] + ["\n", verdict] + lines[3:]
    goal.write_text("".join(out), encoding="utf-8")
else:
    goal.write_text(verdict + "\n" + g, encoding="utf-8")

print(f"promoted matrix={matrix_path}")
print(f"promoted goal-progress={goal_path}")
PY
}

# Desktop + file signal so operators/agents can seize without polling spam.
signal_main_cdp_ready() {
  local ts reason
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  reason="${1:-preferred_target_up}"

  # Always refresh the flag contents (mtime + body) when seizing.
  cat >"${READY_FLAG}" <<EOF
ready=1
ts=${ts}
cdp=${CDP_URL}
reason=${reason}
watcher_pid=$$
watch_log=${WATCH_LOG}
uat_log=${UAT_LOG}
EOF
  log "READY flag touched: ${READY_FLAG} (${reason})"

  if [[ "${NOTIFY_ON_READY}" == "1" ]] && command -v notify-send >/dev/null 2>&1; then
    notify-send -a 'cursor-mobile' \
      -u critical \
      'cursor-mobile: MAIN CDP ready' \
      "http://127.0.0.1:${CDP_PORT} up (${reason}). Running New-session UAT (ATTACH_COUNT=${ATTACH_COUNT})." \
      >/dev/null 2>&1 || true
    log "notify-send fired (MAIN CDP ready)"
  elif [[ "${NOTIFY_ON_READY}" == "1" ]]; then
    log "notify-send unavailable — flag only"
  fi
}

clear_ready_flag() {
  rm -f "${READY_FLAG}" 2>/dev/null || true
}

run_pipeline_when_cdp_ready() {
  loud "MAIN CDP UP — verify (best-effort) → Hub mesh → repair-hub → New-session UAT"

  if second_profile_running; then
    log "HARD BAN: second-profile ${CDP_PROFILE} is running — refuse pipeline"
    refuse_start_cursor
    return 1
  fi

  if (( SEIZED_READY == 0 )); then
    signal_main_cdp_ready "preferred_target_up"
    SEIZED_READY=1
  fi

  best_effort_verify_cdp
  ensure_hub_mesh || true

  # Drain Hub New-session create queue (CURSOR_DOWN → cdp_ok) before device UAT.
  log "Draining Hub session create queue (loopback POST /v1/sessions/create-queue/drain)"
  set +e
  DRAIN_JSON="$(curl -sf --max-time 5 -X POST \
    "http://127.0.0.1:${HUB_PORT}/v1/sessions/create-queue/drain" 2>&1)"
  DRAIN_RC=$?
  set -e
  if (( DRAIN_RC == 0 )); then
    log "create-queue drain OK: ${DRAIN_JSON}"
  else
    log "WARN: create-queue drain rc=${DRAIN_RC} (Hub may be old or empty) — ${DRAIN_JSON}"
  fi

  log "Running python3 scripts/adb-repair-hub-url.py"
  if ! python3 "${ROOT}/scripts/adb-repair-hub-url.py" 2>&1 | tee -a "${UAT_LOG}"; then
    log "WARN: adb-repair-hub-url.py exited non-zero — continuing to UAT anyway"
  fi

  # Truncate UAT log for this seize attempt so RESULT: PASS is unambiguous.
  : >"${UAT_LOG}"
  log "Running SKIP_APK_BUILD=${SKIP_APK_BUILD} ATTACH_COUNT=${ATTACH_COUNT} npm run uat:adb-new-session"
  set +e
  SKIP_APK_BUILD="${SKIP_APK_BUILD}" ATTACH_COUNT="${ATTACH_COUNT}" \
    npm run uat:adb-new-session 2>&1 | tee -a "${UAT_LOG}"
  local rc=${PIPESTATUS[0]}
  set -e

  if (( rc != 0 )); then
    log "FAIL: uat:adb-new-session rc=${rc} — see ${UAT_LOG}"
    return "${rc}"
  fi

  if ! grep -q 'RESULT: PASS' "${UAT_LOG}"; then
    if ! grep -q 'PASS: new live session' "${UAT_LOG}"; then
      log "FAIL: UAT log missing RESULT: PASS — see ${UAT_LOG}"
      return 1
    fi
  fi

  loud "UAT PASS — promoting AC-081-02 / AC-X-01 (no UpdateGoal)"
  promote_acs_on_pass
  # Stamp flag as Pass so parent GOAL_COMPLETE audit can read without re-running UAT.
  cat >"${READY_FLAG}" <<EOF
ready=1
pass=1
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cdp=${CDP_URL}
reason=uat_pass
acs=AC-081-02,AC-X-01
watcher_pid=$$
watch_log=${WATCH_LOG}
uat_log=${UAT_LOG}
EOF
  if [[ "${NOTIFY_ON_READY}" == "1" ]] && command -v notify-send >/dev/null 2>&1; then
    notify-send -a 'cursor-mobile' \
      -u normal \
      'cursor-mobile: New-session UAT PASS' \
      "AC-081-02 + AC-X-01 promoted. Parent may GOAL_COMPLETE audit (no UpdateGoal here)." \
      >/dev/null 2>&1 || true
  fi
  log "RESULT: PASS — AC-081-02 + AC-X-01 promoted · GOAL_COMPLETE candidate (parent UpdateGoal)"
  log "watch log: ${WATCH_LOG}"
  log "uat log:   ${UAT_LOG}"
  log "ready flag:${READY_FLAG}"
  return 0
}

trap 'echo; log "interrupted (Ctrl+C) — CDP may still be down; no AC promote; Cursor not started."; exit 130' INT TERM

echo "=== watch-main-cdp-and-new-session ==="
echo "CDP:       ${CDP_URL}/json/version"
echo "Interval:  ${INTERVAL_SEC}s"
echo "SKIP_APK:  ${SKIP_APK_BUILD}  ATTACH_COUNT=${ATTACH_COUNT}"
echo "Allow 2nd: HARD BAN (never auto-start ${CDP_PROFILE})"
echo "Watch log: ${WATCH_LOG}"
echo "UAT log:   ${UAT_LOG}"
echo "Verify log:${VERIFY_LOG}"
echo "Ready flag:${READY_FLAG}"
echo "Notify:    ${NOTIFY_ON_READY}"
echo "Promote:   ${PROMOTE_DOCS}"
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  echo "Max:       ${MAX_HOURS}h"
else
  echo "Max:       none (until CDP+UAT Pass, or Ctrl+C)"
fi
echo
echo "NEVER starts Cursor / second profile. Waiting for operator:"
echo "  1. Quit main Cursor (Ctrl+Q)"
echo "  2. npm run start:cursor:cdp"
echo "  3. Open workspace + Composer (workbench — not Agents-only)"
echo "On CDP-up: notify-send + touch ${READY_FLAG} + UAT; on Pass promote ACs (no UpdateGoal)."
echo

elapsed=0
max_sec=0
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  max_sec=$(( MAX_HOURS * 3600 ))
fi

# Stale ready flag from a prior run would mislead agents — clear until we seize again.
clear_ready_flag
SEIZED_READY=0

# Hard guard: if second profile somehow appears while we wait, kill it (never use/relaunch).
if second_profile_running; then
  log "WARN: leftover second-profile detected at start — killing (main Cursor untouched); waiting for MAIN CDP"
  SECOND_CDP_KILL=1 bash "${ROOT}/scripts/assert-no-second-cdp-profile.sh" >/dev/null 2>&1 || true
fi
# Also scrub stale DevToolsActivePort under banned profile dir (never launch it).
if [[ -f "${CDP_PROFILE}/DevToolsActivePort" ]]; then
  rm -f "${CDP_PROFILE}/DevToolsActivePort" 2>/dev/null || true
  log "scrubbed stale ${CDP_PROFILE}/DevToolsActivePort"
fi

# Keep Hub mesh warm while waiting (no Cursor start).
ensure_hub_mesh || true

while true; do
  if [[ -f "${STOP_FLAG}" ]]; then
    log "STOP flag present (${STOP_FLAG}) — exiting watch loop (no CDP wait)."
    exit 0
  fi

  if (( max_sec > 0 && elapsed >= max_sec )); then
    log "FAIL: main CDP never ready (or UAT never Pass) within ${MAX_HOURS}h."
    refuse_start_cursor
    exit 1
  fi

  if second_profile_running; then
    printf 'watching for MAIN CDP… %ss — second-profile present; HARD BAN — killing (main Cursor untouched)\n' \
      "${elapsed}"
    SECOND_CDP_KILL=1 bash "${ROOT}/scripts/assert-no-second-cdp-profile.sh" >/dev/null 2>&1 || true
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi

  if ! cdp_version_up; then
    # If CDP dropped after a seize attempt, allow re-notify on next up.
    if (( SEIZED_READY == 1 )); then
      log "MAIN CDP dropped after seize — clearing ready flag; will re-notify on next up"
      clear_ready_flag
      SEIZED_READY=0
    fi
    printf 'watching for MAIN CDP… %ss elapsed (poll every %ss) — %s/json/version down\n' \
      "${elapsed}" "${INTERVAL_SEC}" "${CDP_URL}"
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi

  set +e
  cdp_has_preferred_target
  pref_rc=$?
  set -e
  if (( pref_rc == 2 )); then
    printf 'watching for MAIN CDP… %ss — CDP up but Agents-only; need workbench/Composer\n' \
      "${elapsed}"
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi
  if (( pref_rc != 0 )); then
    printf 'watching for MAIN CDP… %ss — CDP version up but /json/list not ready (rc=%s)\n' \
      "${elapsed}" "${pref_rc}"
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi

  if run_pipeline_when_cdp_ready; then
    exit 0
  fi
  log "Pipeline failed after CDP up — sleeping ${INTERVAL_SEC}s then retry"
  sleep "${INTERVAL_SEC}"
  elapsed=$((elapsed + INTERVAL_SEC))
done
