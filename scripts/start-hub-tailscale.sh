#!/usr/bin/env bash
# Start Hub bound for Tailscale phone reachability (PC-local only).
# CDP stays on loopback; phone never dials CDP. pair/start remains localhost-only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HUB_HOST="${HUB_HOST:-0.0.0.0}"
export HUB_PORT="${HUB_PORT:-8787}"
export CURSOR_WORKSPACE="${CURSOR_WORKSPACE:-${REPO_ROOT}}"
export CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"

TS_IP=""
TS_DNS=""
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  TS_DNS="$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
fi

# Phone-reachable Hub URL for pair complete baseUrlHint / QR (never leave as 127.0.0.1).
if [[ -z "${TAILSCALE_HOSTNAME:-}" ]]; then
  # Prefer the IPv4: Android Tailscale does not reliably resolve MagicDNS (*.ts.net),
  # so a QR with the hostname fails to pair from the phone (2026-10-01 device test).
  if [[ -n "${TS_IP}" ]]; then
    export TAILSCALE_HOSTNAME="${TS_IP}"
  elif [[ -n "${TS_DNS}" ]]; then
    export TAILSCALE_HOSTNAME="${TS_DNS}"
  fi
fi

cat <<EOF
=== cursor-mobile Hub (Tailscale bind) ===
  HUB_HOST=${HUB_HOST}
  HUB_PORT=${HUB_PORT}
  CURSOR_WORKSPACE=${CURSOR_WORKSPACE}
  CDP_URL=${CDP_URL}  (loopback only — phone never dials CDP)

EOF

if [[ -n "${TS_IP}" ]]; then
  cat <<EOF
  Tailscale IPv4: ${TS_IP}
  Phone EXPO_PUBLIC_HUB_URL:
    export EXPO_PUBLIC_HUB_URL="http://${TS_IP}:${HUB_PORT}"

EOF
else
  cat <<EOF
  Tailscale IPv4: (unavailable — is \`tailscale\` on PATH / signed in?)
  Known operator IP (2026-09-25): 100.91.47.68
  Phone EXPO_PUBLIC_HUB_URL (example):
    export EXPO_PUBLIC_HUB_URL="http://100.91.47.68:${HUB_PORT}"

EOF
fi

cat <<EOF
  Pairing:
    POST /v1/pair/start is localhost-only — generate the code on the PC
    (curl -X POST http://127.0.0.1:${HUB_PORT}/v1/pair/start), then
    confirm/complete from the phone over Tailscale.

  Health check (from PC or phone on same tailnet):
    curl -s http://127.0.0.1:${HUB_PORT}/health
EOF

if [[ -n "${TS_IP}" ]]; then
  echo "    curl -s http://${TS_IP}:${HUB_PORT}/health"
fi

echo
echo "Building workspace packages (adapters → hub dist/), then starting Hub"
echo "  npm run build && npm run start  (workspace @cursor-mobile/hub)"
echo

cd "${REPO_ROOT}"
# Production start uses node on dist/; adapter package.json exports point at
# dist/*.js (not src/*.ts). Build first so operators are never stuck on tsx-only.
npm run build
exec npm run start
