#!/usr/bin/env bash
# Live E2E: start the bridge (real SessionStore, DB copy) and drive it with the app's own client code.
set -u
PY=${HERMES_PY:-python3}  # set HERMES_PY to the Hermes venv python (needs the gateway deps)
PORT=${PORT:-18098}
LOG=$(mktemp)
"$PY" "$(cd "$(dirname "$0")/../../.." && pwd)/server/phone_bridge/e2e_server.py" "$PORT" >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 60); do grep -q '^PAIR' "$LOG" && break; sleep 0.5; done
read -r _ PAIR_ID CODE < <(grep '^PAIR' "$LOG") || { echo "server did not start:"; cat "$LOG"; exit 2; }
cd "$(dirname "$0")/.." && node --import tsx scripts/e2e-bridge.ts "http://127.0.0.1:$PORT" "$PAIR_ID" "$CODE"
