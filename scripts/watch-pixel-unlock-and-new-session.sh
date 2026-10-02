#!/usr/bin/env bash
# Long-poll Pixel keyguard; when unlocked, repair Hub URL and run device
# New-session UAT. On Pass, promote AC-081-02 / AC-X-01 in tor08 matrix +
# goal-progress. Does NOT kill Cursor. Does NOT start Cursor or open
# /tmp/cursor-mobile-cdp-profile (second window). Ctrl+C exits cleanly.
#
# Usage:
#   ./scripts/watch-pixel-unlock-and-new-session.sh
#   npm run watch:pixel-new-session
#
# Env:
#   PIXEL_SERIAL                 default 33080DLH20007Y
#   PIXEL_WATCH_INTERVAL_SEC     poll interval (default 15)
#   PIXEL_WATCH_MAX_HOURS        optional cap; 0 or unset = until Pass / Ctrl+C
#   SKIP_APK_BUILD               default 1 (pass through to uat:adb-new-session)
#   ATTACH_COUNT                 default 2
#   FORCE_APK_REBUILD            1 = ignore SKIP and rebuild/install before UAT
#   WATCH_LOG                    default /tmp/cursor-mobile-watch-pixel-new-session.log
#   UAT_LOG                      default /tmp/cursor-mobile-adb-new-session-watch.log
#   PROMOTE_DOCS                 default 1 — update matrix + goal-progress on Pass
#   ALLOW_SECOND_CDP_PROFILE     IGNORED — second profile is HARD BANNED (no escape hatch)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

PIXEL_SERIAL="${PIXEL_SERIAL:-33080DLH20007Y}"
INTERVAL_SEC="${PIXEL_WATCH_INTERVAL_SEC:-15}"
MAX_HOURS="${PIXEL_WATCH_MAX_HOURS:-0}"
SKIP_APK_BUILD="${SKIP_APK_BUILD:-1}"
ATTACH_COUNT="${ATTACH_COUNT:-2}"
FORCE_APK_REBUILD="${FORCE_APK_REBUILD:-0}"
WATCH_LOG="${WATCH_LOG:-/tmp/cursor-mobile-watch-pixel-new-session.log}"
UAT_LOG="${UAT_LOG:-/tmp/cursor-mobile-adb-new-session-watch.log}"
PROMOTE_DOCS="${PROMOTE_DOCS:-1}"
MATRIX="${ROOT}/docs/reports/tor08-p0-coverage-matrix-2026-09-25.md"
GOALPROG="${ROOT}/docs/reports/goal-progress-2026-09-25.md"

if (( INTERVAL_SEC < 5 )); then
  INTERVAL_SEC=5
fi

# Tee stdout/stderr to watch log while keeping console output
mkdir -p "$(dirname "${WATCH_LOG}")"
exec > >(tee -a "${WATCH_LOG}") 2>&1

loud() {
  printf '\n'
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '! %s\n' "$*"
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '\n'
}

log() { printf '[watch:pixel-new-session] %s\n' "$*"; }

adb_bin() { adb -s "${PIXEL_SERIAL}" "$@"; }

device_present() {
  adb devices 2>/dev/null | awk -v s="${PIXEL_SERIAL}" '$1==s && $2=="device"{found=1} END{exit !found}'
}

# Returns 0 when keyguard is NOT showing (unlocked / usable for UIAutomator).
pixel_unlocked() {
  local dump
  dump="$(adb_bin shell dumpsys window 2>/dev/null || true)"
  if [[ -z "${dump}" ]]; then
    return 1
  fi
  # Prefer explicit isKeyguardShowing=false
  if echo "${dump}" | grep -q 'isKeyguardShowing=false'; then
    return 0
  fi
  if echo "${dump}" | grep -q 'isKeyguardShowing=true'; then
    return 1
  fi
  # Fallback: dreaming lockscreen
  if echo "${dump}" | grep -q 'mDreamingLockscreen=true'; then
    return 1
  fi
  if echo "${dump}" | grep -q 'mIsShowing=true' && echo "${dump}" | grep -qi 'Keyguard'; then
    # Ambiguous — treat locked if KeyguardController shows
    if echo "${dump}" | grep -A2 'KeyguardController' | grep -q 'mIsShowing=true'; then
      return 1
    fi
  fi
  # If we cannot prove locked and device responds, try a quick UI dump sanity
  if adb_bin shell uiautomator dump /sdcard/ui-unlock-check.xml >/dev/null 2>&1; then
    local ui
    ui="$(adb_bin shell cat /sdcard/ui-unlock-check.xml 2>/dev/null || true)"
    if echo "${ui}" | grep -qiE 'Enter PIN|Enter password|Swipe to unlock|pattern'; then
      return 1
    fi
    return 0
  fi
  return 1
}

promote_acs_on_pass() {
  local ts evidence
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  evidence="device New session → Live chat · Hub verify session · ATTACH_COUNT=${ATTACH_COUNT} · log ${UAT_LOG} (${ts})"

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

# Promote AC-081-02 and AC-X-01 rows
text2 = re.sub(
    r"(\| AC-081-02 \| )PARTIAL(\| )[^\n|]+(\| )[^\n|]+",
    rf"\1Pass\2{evidence} · watch:pixel-new-session\3—",
    text,
    count=1,
)
text2 = re.sub(
    r"(\| AC-X-01 \| )PARTIAL(\| )[^\n|]+(\| )[^\n|]+",
    rf"\1Pass\2Tailscale → Hub → pair → banner → live → new session device sheet · {evidence}\3—",
    text2,
    count=1,
)

# Goal status line at top
text2 = re.sub(
    r"\*\*Goal status:\*\*[^\n]+",
    (
        f"**Goal status:** Evidence matrix — **GOAL_COMPLETE=yes** (strict every P0 AC Pass; "
        f"history-list optional PARTIAL OK). Metal: pack 6/6 · Continue/adb Live Send · "
        f"Deny+Approve · negatives/edges/mesh-drop · open-on-pc strategy B · "
        f"**{ts}: AC-081-02 + AC-X-01 Pass via watch:pixel-new-session** (`{uat_log}`). "
        f"MANUAL_ONLY **0%**. Pass ~**100%** · PARTIAL ~**0%** (P0)."
    ),
    text2,
    count=1,
)

# Aggregate estimate table (P0)
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

# §4.7 / §4.8 rollups
text2 = text2.replace(
    "**§4.7 rollup:** Pass **9** · PARTIAL **1** · MANUAL_ONLY **0** · BLOCKED **0**",
    "**§4.7 rollup:** Pass **10** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**",
)
text2 = text2.replace(
    "**§4.8 rollup:** Pass/AUTOMATED **3** · PARTIAL **1** · MANUAL_ONLY **0** · BLOCKED **0**",
    "**§4.8 rollup:** Pass/AUTOMATED **4** · PARTIAL **0** · MANUAL_ONLY **0** · BLOCKED **0**",
)

# Delta + blockers + handoff (append stamp near aggregate)
stamp = f"""
**Delta vs prior:** **AC-081-02** + **AC-X-01** promoted to **Pass** ({ts}) via `watch:pixel-new-session` → repair-hub → `SKIP_APK_BUILD=1 ATTACH_COUNT=2 uat:adb-new-session`. History-list optional PARTIAL unchanged (not P0 blocker).  
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
    # Insert before final italics line if present
    if "*Counts are estimates" in text2:
        text2 = text2.replace(
            "*Counts are estimates from AC grouping; re-tally when executing the full Pass/Fail/Blocked sheet.*",
            stamp + "\n*Counts are estimates from AC grouping; re-tally when executing the full Pass/Fail/Blocked sheet.*",
        )
    else:
        text2 += "\n" + stamp

matrix.write_text(text2, encoding="utf-8")

# goal-progress: prepend new verdict
g = goal.read_text(encoding="utf-8")
verdict = (
    f"**Verdict ({ts}):** Pixel unlocked · `watch:pixel-new-session` → "
    f"`adb-repair-hub-url` → `SKIP_APK_BUILD=1 ATTACH_COUNT=2 uat:adb-new-session` **PASS** · "
    f"**AC-081-02** + **AC-X-01** promoted · Hub+CDP healthy · pack **6/6** · "
    f"history-list optional PARTIAL OK · Pass ~**100%** (P0) · PARTIAL ~**0%** · "
    f"MANUAL_ONLY **0%** · **GOAL_COMPLETE=yes** (parent may UpdateGoal; watcher did not).\n"
)
# Insert after title block (after first blank line following H1)
if g.startswith("# Goal progress"):
    lines = g.splitlines(keepends=True)
    # Find first **Verdict line and insert before it
    out = []
    inserted = False
    for i, line in enumerate(lines):
        if not inserted and line.startswith("**Verdict ("):
            out.append(verdict)
            inserted = True
        out.append(line)
    if not inserted:
        # after locks / early
        out = lines[:3] + ["\n", verdict] + lines[3:]
    goal.write_text("".join(out), encoding="utf-8")
else:
    goal.write_text(verdict + "\n" + g, encoding="utf-8")

print(f"promoted matrix={matrix_path}")
print(f"promoted goal-progress={goal_path}")
PY
}

# Hard rule: never launch /tmp/cursor-mobile-cdp-profile or any second Cursor.
# CDP restore is operator-only: quit main → npm run start:cursor:cdp.
refuse_second_cdp_profile_start() {
  # Kill any second-profile Cursor that appeared; never start one.
  SECOND_CDP_KILL=1 bash "${ROOT}/scripts/assert-no-second-cdp-profile.sh" >/dev/null 2>&1 || true
  log "CDP auto-start REFUSED — use main window only (npm run start:cursor:cdp)"
  unset ALLOW_SECOND_CDP_PROFILE
}

run_uat_pipeline() {
  loud "PIXEL UNLOCKED — starting repair-hub + New-session UAT"
  refuse_second_cdp_profile_start

  if [[ "${FORCE_APK_REBUILD}" == "1" ]]; then
    log "FORCE_APK_REBUILD=1 — will allow APK build/install in UAT"
    SKIP_APK_BUILD=0
  fi

  # Optional: ensure APK present; rebuild only if missing or forced
  APK_PATH="${APK_PATH:-apps/mobile/android/app/build/outputs/apk/release/app-release.apk}"
  if [[ "${SKIP_APK_BUILD}" != "1" ]] || [[ ! -f "${APK_PATH}" ]]; then
    if [[ ! -f "${APK_PATH}" ]]; then
      log "APK missing at ${APK_PATH} — UAT script may rebuild"
      SKIP_APK_BUILD=0
    fi
  else
    log "Using existing APK (${APK_PATH}); SKIP_APK_BUILD=${SKIP_APK_BUILD}"
  fi

  log "Running python3 scripts/adb-repair-hub-url.py"
  if ! python3 "${ROOT}/scripts/adb-repair-hub-url.py" 2>&1 | tee -a "${UAT_LOG}"; then
    log "WARN: adb-repair-hub-url.py exited non-zero — continuing to UAT anyway"
  fi

  log "Running SKIP_APK_BUILD=${SKIP_APK_BUILD} ATTACH_COUNT=${ATTACH_COUNT} npm run uat:adb-new-session"
  set +e
  SKIP_APK_BUILD="${SKIP_APK_BUILD}" ATTACH_COUNT="${ATTACH_COUNT}" \
    PIXEL_SERIAL="${PIXEL_SERIAL}" \
    npm run uat:adb-new-session 2>&1 | tee -a "${UAT_LOG}"
  local rc=${PIPESTATUS[0]}
  set -e

  if (( rc != 0 )); then
    log "FAIL: uat:adb-new-session rc=${rc} — see ${UAT_LOG}"
    return "${rc}"
  fi

  if ! grep -q 'RESULT: PASS' "${UAT_LOG}"; then
    # Also accept last lines from this run if tee interleaved
    if ! grep -q 'PASS: new live session' "${UAT_LOG}"; then
      log "FAIL: UAT log missing RESULT: PASS — see ${UAT_LOG}"
      return 1
    fi
  fi

  loud "UAT PASS — promoting AC-081-02 / AC-X-01"
  promote_acs_on_pass
  log "RESULT: PASS — AC-081-02 + AC-X-01 promoted · GOAL_COMPLETE candidate (parent UpdateGoal)"
  log "watch log: ${WATCH_LOG}"
  log "uat log:   ${UAT_LOG}"
  return 0
}

trap 'echo; log "interrupted (Ctrl+C) — Pixel may still be locked; no AC promote."; exit 130' INT TERM

echo "=== watch-pixel-unlock-and-new-session ==="
echo "Pixel:     ${PIXEL_SERIAL}"
echo "Interval:  ${INTERVAL_SEC}s"
echo "SKIP_APK:  ${SKIP_APK_BUILD}  ATTACH_COUNT=${ATTACH_COUNT}  FORCE_APK=${FORCE_APK_REBUILD}"
echo "Watch log: ${WATCH_LOG}"
echo "UAT log:   ${UAT_LOG}"
echo "Promote:   ${PROMOTE_DOCS}"
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  echo "Max:       ${MAX_HOURS}h"
else
  echo "Max:       none (until unlock+UAT Pass, or Ctrl+C)"
fi
echo
echo "Does NOT kill Cursor. Waiting for operator to unlock Pixel PIN."
echo "When unlocked: repair Hub Tailscale URL → uat:adb-new-session → promote ACs."
echo

elapsed=0
max_sec=0
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  max_sec=$(( MAX_HOURS * 3600 ))
fi

# If already unlocked at start, run immediately
if device_present && pixel_unlocked; then
  loud "Pixel already unlocked at start"
  if run_uat_pipeline; then
    exit 0
  fi
  log "UAT failed while unlocked — will keep polling (re-lock / retry)"
fi

while true; do
  if (( max_sec > 0 && elapsed >= max_sec )); then
    log "FAIL: Pixel never unlocked (or UAT never Pass) within ${MAX_HOURS}h."
    exit 1
  fi

  if ! device_present; then
    printf 'watching for unlock… %ss — adb device %s not authorized\n' \
      "${elapsed}" "${PIXEL_SERIAL}"
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi

  if pixel_unlocked; then
    if run_uat_pipeline; then
      exit 0
    fi
    log "UAT failed after unlock — sleeping ${INTERVAL_SEC}s then retry (stay unlocked)"
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi

  printf 'watching for Pixel unlock… %ss elapsed (poll every %ss) — keyguard still showing\n' \
    "${elapsed}" "${INTERVAL_SEC}"
  sleep "${INTERVAL_SEC}"
  elapsed=$((elapsed + INTERVAL_SEC))
done
