#!/usr/bin/env bash
# From the operator PC: register node1 as this repo's self-hosted Actions runner.
# Needs `gh auth login` (repo admin) and `ssh node1` working.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${NODE1_HOST:-node1}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

# Short-lived (1h) registration token; passed over ssh stdin-env, never written to disk here.
TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)"
ssh "$HOST" "REPO_URL=https://github.com/$REPO RUNNER_TOKEN=$TOKEN bash -s" \
  < "$ROOT/scripts/ci/setup-node1-runner.sh"
gh api "repos/$REPO/actions/runners" --jq '.runners[] | "\(.name)  \(.status)  [\(.labels | map(.name) | join(","))]"'
