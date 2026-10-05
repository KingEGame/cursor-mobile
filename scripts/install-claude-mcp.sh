#!/usr/bin/env bash
# Install the cursor-hub Claude Code plugin (user scope, this PC only) from the repo's
# local marketplace. The plugin's MCP server talks to the Hub on 127.0.0.1 and pairs
# itself once as "Claude (MCP)".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH" >&2; exit 1; }

cd "${REPO_ROOT}"
node scripts/build-claude-plugin.mjs

# Older installs registered a bare MCP server; the plugin replaces it.
claude mcp remove cursor -s user >/dev/null 2>&1 || true

if claude plugin marketplace list 2>/dev/null | grep -q "cursor-mobile"; then
  claude plugin marketplace update cursor-mobile
else
  claude plugin marketplace add "${REPO_ROOT}/claude-plugin"
fi
claude plugin install cursor-hub@cursor-mobile -s user

echo "Installed plugin cursor-hub. Restart Claude Code sessions to load it."
