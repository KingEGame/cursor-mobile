#!/usr/bin/env bash
# Live E2E: start the bridge (real SessionStore, DB copy) and drive it with the app's own client code.
set -u
# Interpreter with the gateway deps: $HERMES_PY, else Hermes' own runtime (`hermes --print-runtime-command`,
# with its entry module swapped for our script), else python3.
RUN=()
if [ -n "${HERMES_PY:-}" ]; then
  RUN=("$HERMES_PY")
elif command -v hermes >/dev/null 2>&1; then
  mapfile -t RUN < <(hermes --print-runtime-command 2>/dev/null | python3 -c '
import json, sys
cmd = json.load(sys.stdin)
cmd[-1] = cmd[-1].replace("runpy.run_module(\x27hermes_cli.main\x27, run_name=\x27__main__\x27, alter_sys=True)",
                          "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name=\x27__main__\x27)")
print("\n".join(cmd))' 2>/dev/null)
fi
[ ${#RUN[@]} -gt 0 ] || RUN=(python3)
PORT=${PORT:-18098}
LOG=$(mktemp)
"${RUN[@]}" "$(cd "$(dirname "$0")/../../.." && pwd)/server/phone_bridge/e2e_server.py" "$PORT" >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 60); do grep -q '^PAIR' "$LOG" && break; sleep 0.5; done
read -r _ PAIR_ID CODE < <(grep '^PAIR' "$LOG") || { echo "server did not start:"; cat "$LOG"; exit 2; }
cd "$(dirname "$0")/.." && node --import tsx scripts/e2e-bridge.ts "http://127.0.0.1:$PORT" "$PAIR_ID" "$CODE"
