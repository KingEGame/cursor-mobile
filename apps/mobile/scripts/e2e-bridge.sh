#!/usr/bin/env bash
# Live E2E: start the bridge (real SessionStore, DB copy) and drive it with the app's own client code.
set -u
PY=${HERMES_PY:-/home/kingwar/.hermes/installs/cec2c3a4299eff54/environments/0b0a3d193df1479da3932830a8ba32ff/venv/bin/python}
PORT=${PORT:-18098}
LOG=$(mktemp)
"$PY" "$(cd "$(dirname "$0")/../../.." && pwd)/server/phone_bridge/e2e_server.py" "$PORT" >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 60); do grep -q '^PAIR' "$LOG" && break; sleep 0.5; done
read -r _ PAIR_ID CODE < <(grep '^PAIR' "$LOG") || { echo "server did not start:"; cat "$LOG"; exit 2; }
cd "$(dirname "$0")/.." && node --import tsx scripts/e2e-bridge.ts "http://127.0.0.1:$PORT" "$PAIR_ID" "$CODE"
