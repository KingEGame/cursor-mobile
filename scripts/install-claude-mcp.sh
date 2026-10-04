#!/usr/bin/env bash
# Register the cursor-mobile MCP server with Claude Code (user scope, this PC only).
# The server talks to the local Hub on 127.0.0.1 and pairs itself once as "Claude (MCP)".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${MCP_NAME:-cursor}"
HUB_URL="${HUB_URL:-http://127.0.0.1:8787}"

command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH" >&2; exit 1; }

cd "${REPO_ROOT}"
npm run build -s -w @cursor-mobile/mcp

claude mcp remove "${NAME}" -s user >/dev/null 2>&1 || true
claude mcp add "${NAME}" -s user -e "HUB_URL=${HUB_URL}" -- node "${REPO_ROOT}/packages/mcp/dist/index.js"

echo "Registered MCP server '${NAME}' → ${HUB_URL}. Restart Claude Code sessions to load it."
