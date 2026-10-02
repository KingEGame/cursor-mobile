#!/usr/bin/env bash
# Run the Hub for the systemd user service (scripts/systemd/cursor-mobile-hub.service).
# PC-local only: binds 0.0.0.0 for the Tailscale mesh; CDP stays on 127.0.0.1;
# POST /v1/pair/start and /v1/pair/prune stay loopback-only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HUB_HOST="${HUB_HOST:-0.0.0.0}"
export HUB_PORT="${HUB_PORT:-8787}"
export CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
export CURSOR_WORKSPACE="${CURSOR_WORKSPACE:-${REPO_ROOT}}"

# The QR must carry the Tailscale IPv4: Android does not reliably resolve MagicDNS.
# Wait briefly for tailscaled at login instead of advertising nothing.
if [[ -z "${TAILSCALE_HOSTNAME:-}" ]] && command -v tailscale >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
    [[ -n "${TS_IP}" ]] && break
    sleep 2
  done
  [[ -n "${TS_IP:-}" ]] && export TAILSCALE_HOSTNAME="${TS_IP}"
fi

cd "${REPO_ROOT}/packages/hub"
exec node dist/cli.js
