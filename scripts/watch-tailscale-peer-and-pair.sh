#!/usr/bin/env bash
# Long-poll Tailscale for an online phone/Android peer, then issue Hub pair/start
# on PC loopback and print the code loudly for the operator.
#
# Does NOT claim pairing complete — phone must confirm/complete over Tailscale.
# Does NOT flip selector VERIFIED. Ctrl+C exits cleanly.
#
# Usage:
#   ./scripts/watch-tailscale-peer-and-pair.sh
#   npm run watch:peer
#
# Env:
#   HUB_PAIR_URL              default http://127.0.0.1:8787/v1/pair/start
#   HUB_HEALTH_URL            default http://127.0.0.1:8787/health
#   PEER_WATCH_INTERVAL_SEC    poll interval (default 15)
#   PEER_WATCH_MAX_HOURS      optional cap; 0 or unset = until Ctrl+C
#   PEER_EXCLUDE              space/comma list of hostnames to ignore
#                             (default: kingwarpc node1)
#   PAIR_OUT                  default /tmp/cursor-mobile-pair.txt
#   PAIR_LOG                  default /tmp/cursor-mobile-watch-peer.log (when redirected)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

HUB_PAIR_URL="${HUB_PAIR_URL:-http://127.0.0.1:8787/v1/pair/start}"
HUB_HEALTH_URL="${HUB_HEALTH_URL:-http://127.0.0.1:8787/health}"
INTERVAL_SEC="${PEER_WATCH_INTERVAL_SEC:-15}"
MAX_HOURS="${PEER_WATCH_MAX_HOURS:-0}"
PAIR_OUT="${PAIR_OUT:-/tmp/cursor-mobile-pair.txt}"
EXCLUDE_RAW="${PEER_EXCLUDE:-kingwarpc node1}"

if (( INTERVAL_SEC < 5 )); then
  INTERVAL_SEC=5
fi

# Normalize exclude list to space-separated lowercase hostnames
EXCLUDE="$(echo "${EXCLUDE_RAW}" | tr ',;' '  ' | tr '[:upper:]' '[:lower:]')"

loud() {
  printf '\n'
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '! %s\n' "$*"
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '\n'
}

hub_up() {
  curl -sf --max-time 2 "${HUB_HEALTH_URL}" >/dev/null 2>&1
}

tailscale_available() {
  command -v tailscale >/dev/null 2>&1
}

# Returns online peer lines that are not this PC / excluded hosts.
# Prefer Android / Pixel; fall back to any non-excluded online peer.
# Prints: "<ip>\t<hostname>\t<os>\t<reason>"
find_candidate_peers() {
  local status line ip host os rest reason
  if ! status="$(tailscale status 2>/dev/null)"; then
    return 1
  fi

  local -a preferred=()
  local -a others=()

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    # Skip header / blank / relay-only noise
    [[ "${line}" == *"Tailscale IP"* ]] && continue
    [[ "${line}" == \#* ]] && continue

    # Columns: IP Hostname User OS … (status may include "offline")
    ip="$(echo "${line}" | awk '{print $1}')"
    host="$(echo "${line}" | awk '{print $2}')"
    os="$(echo "${line}" | awk '{print $4}')"
    [[ -z "${ip}" || -z "${host}" ]] && continue

    local host_lc
    host_lc="$(echo "${host}" | tr '[:upper:]' '[:lower:]')"
    local skip=0
    for ex in ${EXCLUDE}; do
      if [[ "${host_lc}" == "${ex}" ]]; then
        skip=1
        break
      fi
    done
    (( skip )) && continue

    # Offline peers are not candidates
    if echo "${line}" | grep -qi 'offline'; then
      continue
    fi

    reason="online-peer"
    if echo "${line}" | grep -qi 'android'; then
      reason="android"
    fi
    if echo "${host_lc}" | grep -qiE 'pixel|pixel[0-9]|33080'; then
      reason="pixel"
    fi

    if [[ "${reason}" == "pixel" || "${reason}" == "android" ]]; then
      preferred+=("${ip}"$'\t'"${host}"$'\t'"${os}"$'\t'"${reason}")
    else
      others+=("${ip}"$'\t'"${host}"$'\t'"${os}"$'\t'"${reason}")
    fi
  done <<< "${status}"

  if ((${#preferred[@]} > 0)); then
    printf '%s\n' "${preferred[@]}"
    return 0
  fi
  if ((${#others[@]} > 0)); then
    printf '%s\n' "${others[@]}"
    return 0
  fi
  return 1
}

# Pick best peer: pixel > android > first other
pick_peer() {
  local peers pixel android first
  peers="$(find_candidate_peers)" || return 1
  pixel="$(echo "${peers}" | awk -F'\t' '$4=="pixel"{print; exit}')"
  android="$(echo "${peers}" | awk -F'\t' '$4=="android"{print; exit}')"
  first="$(echo "${peers}" | head -n1)"
  if [[ -n "${pixel}" ]]; then
    echo "${pixel}"
  elif [[ -n "${android}" ]]; then
    echo "${android}"
  else
    echo "${first}"
  fi
}

issue_pair_code() {
  local body http_code tmp
  tmp="$(mktemp)"
  set +e
  http_code="$(curl -sS --max-time 5 -o "${tmp}" -w '%{http_code}' \
    -X POST "${HUB_PAIR_URL}" \
    -H 'content-type: application/json' \
    -d '{}')"
  local curl_rc=$?
  set -e
  body="$(cat "${tmp}" 2>/dev/null || true)"
  rm -f "${tmp}"

  if (( curl_rc != 0 )); then
    echo "FAIL: pair/start curl error (rc=${curl_rc}) — is Hub up on loopback?" >&2
    return 1
  fi
  if [[ "${http_code}" != "200" && "${http_code}" != "201" ]]; then
    echo "FAIL: pair/start HTTP ${http_code}: ${body}" >&2
    return 1
  fi

  # Prefer python/json if available; else sed fallbacks
  local code pair_id expires
  if command -v python3 >/dev/null 2>&1; then
    code="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("code",""))' <<<"${body}")"
    pair_id="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("pairId",""))' <<<"${body}")"
    expires="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("expiresAt",""))' <<<"${body}")"
  else
    code="$(echo "${body}" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
    pair_id="$(echo "${body}" | sed -n 's/.*"pairId":"\([^"]*\)".*/\1/p')"
    expires="$(echo "${body}" | sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p')"
  fi

  if [[ -z "${code}" ]]; then
    echo "FAIL: pair/start response missing code: ${body}" >&2
    return 1
  fi

  {
    echo "issuedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "pairId=${pair_id}"
    echo "code=${code}"
    echo "expiresAt=${expires}"
    echo "hubPairUrl=${HUB_PAIR_URL}"
    echo "note=Enter code on phone Pair screen. Pairing is NOT complete until phone confirm/complete."
  } > "${PAIR_OUT}"

  loud "PHONE PEER ONLINE — ENTER PAIR CODE ON PHONE: ${code}"
  echo "pairId:    ${pair_id}"
  echo "expiresAt: ${expires}"
  echo "wrote:     ${PAIR_OUT}"
  echo
  echo "Operator next:"
  echo "  1. On Pixel: open local.cursor.mobile → Pair"
  echo "  2. Hub URL: http://100.91.47.68:8787 (or MagicDNS)"
  echo "  3. Enter code ${code} → confirm/complete on the phone"
  echo "  4. This script does NOT claim pair complete — wait for phone confirm"
  echo
  echo "${code}"
}

code_still_valid() {
  if [[ ! -f "${PAIR_OUT}" ]]; then
    return 1
  fi
  local expires
  expires="$(grep -E '^expiresAt=' "${PAIR_OUT}" | head -n1 | cut -d= -f2- || true)"
  if [[ -z "${expires}" ]]; then
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
from datetime import datetime, timezone
import sys
exp = datetime.fromisoformat('${expires}'.replace('Z','+00:00'))
sys.exit(0 if exp > datetime.now(timezone.utc) else 1)
" 2>/dev/null
    return $?
  fi
  # Fallback: treat as expired if we cannot parse — re-issue
  return 1
}

trap 'echo; echo "watch:peer interrupted (Ctrl+C) — pair may still be pending phone confirm."; exit 130' INT TERM

echo "=== watch-tailscale-peer-and-pair ==="
echo "Hub health: ${HUB_HEALTH_URL}"
echo "pair/start: ${HUB_PAIR_URL} (loopback-only by design)"
echo "Interval:   ${INTERVAL_SEC}s"
echo "Exclude:    ${EXCLUDE}"
echo "Pair out:   ${PAIR_OUT}"
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  echo "Max:        ${MAX_HOURS}h"
else
  echo "Max:        none (until Ctrl+C)"
fi
echo
echo "Waiting for an online phone/Android peer (prefer Pixel)."
echo "Excluded hosts: ${EXCLUDE}"
echo "Will NOT claim pair complete without phone confirm/complete."
echo

elapsed=0
max_sec=0
if [[ "${MAX_HOURS}" != "0" && -n "${MAX_HOURS}" ]]; then
  max_sec=$(( MAX_HOURS * 3600 ))
fi

last_peer=""
issued_for_peer=""

while true; do
  if (( max_sec > 0 && elapsed >= max_sec )); then
    echo "FAIL: no qualifying online peer within ${MAX_HOURS}h." >&2
    exit 1
  fi

  if ! tailscale_available; then
    printf 'watching for peer… %ss — tailscale CLI missing\n' "${elapsed}"
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi

  if ! hub_up; then
    printf 'watching for peer… %ss — Hub down at %s (start: npm run start:hub:tailscale)\n' \
      "${elapsed}" "${HUB_HEALTH_URL}"
    sleep "${INTERVAL_SEC}"
    elapsed=$((elapsed + INTERVAL_SEC))
    continue
  fi

  peer_line=""
  if peer_line="$(pick_peer)"; then
    peer_host="$(echo "${peer_line}" | awk -F'\t' '{print $2}')"
    peer_reason="$(echo "${peer_line}" | awk -F'\t' '{print $4}')"
    peer_ip="$(echo "${peer_line}" | awk -F'\t' '{print $1}')"

    if [[ "${peer_host}" != "${last_peer}" ]]; then
      loud "PEER ONLINE: ${peer_host} (${peer_ip}) reason=${peer_reason}"
      last_peer="${peer_host}"
    fi

    # Issue (or refresh expired) pair code for this peer. Do not spam while valid.
    need_issue=0
    if [[ "${issued_for_peer}" != "${peer_host}" ]]; then
      need_issue=1
    elif ! code_still_valid; then
      need_issue=1
      echo "pair code expired — re-issuing for ${peer_host}"
    fi

    if (( need_issue )); then
      if issue_pair_code; then
        issued_for_peer="${peer_host}"
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) issued pair code for peer=${peer_host} (awaiting phone confirm — NOT complete)"
      else
        echo "WARN: pair/start failed — will retry next poll"
        issued_for_peer=""
      fi
    else
      code_now="$(grep -E '^code=' "${PAIR_OUT}" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
      printf 'peer still online (%s) — code %s pending phone confirm (NOT complete)… %ss\n' \
        "${peer_host}" "${code_now:-?}" "${elapsed}"
    fi
  else
    if [[ -n "${last_peer}" ]]; then
      echo "peer ${last_peer} no longer online — waiting again"
      last_peer=""
      # Keep last pair file; do not claim complete or clear code aggressively
    fi
    printf 'watching for phone peer… %ss elapsed (poll every %ss) — no Android/Pixel (excl. %s)\n' \
      "${elapsed}" "${INTERVAL_SEC}" "${EXCLUDE}"
  fi

  sleep "${INTERVAL_SEC}"
  elapsed=$((elapsed + INTERVAL_SEC))
done
