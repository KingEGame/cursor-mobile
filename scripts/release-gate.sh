#!/usr/bin/env bash
# Release gate — everything that must be green before code leaves this PC.
# Run by .githooks/pre-push and by CI (GATE_CI=1). Manual: npm run gate
#
# Steps stop at the first red one; later steps are reported as skipped.
# GATE_FULL=1 also runs the live checks that need main Cursor (CDP) on this PC.
# Full output: .gate/last-run.log
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .gate
LOG=".gate/last-run.log"
: >"$LOG"

if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; D=$'\e[2m'; B=$'\e[1m'; N=$'\e[0m'; else G=; R=; D=; B=; N=; fi

STEPS=(
  "build:packages|npm run build"
  # Hub (all of test/ + tests/phase0..4 + TOR-08), both adapters, and the Claude MCP server.
  "test:hub+adapters+mcp|npm test"
  # Mobile: tsc --noEmit + node:test suites.
  "test:mobile|npm run test:mobile"
  "test:release-scripts|node --test scripts/release-scripts.test.mjs"
  # The Claude plugin ships a bundled copy of packages/mcp; it must match the source.
  "plugin:bundle-fresh|git diff --quiet -- claude-plugin/cursor-hub/server || { echo 'claude-plugin bundle is stale: commit the output of npm run plugin:build'; exit 1; }"
)
# Needs the real Cursor window / processes on this PC — never in CI.
if [ "${GATE_CI:-0}" != "1" ]; then
  STEPS+=("assert:no-second-cdp|npm run assert:no-second-cdp")
fi
if [ "${GATE_FULL:-0}" = "1" ]; then
  STEPS+=("verify:cdp|npm run verify:cdp")
fi

echo "${D}release gate · $(git rev-parse --short HEAD 2>/dev/null || echo '?') · log: $LOG${N}"
failed=""
passed_tests=0
start=$(date +%s)
for entry in "${STEPS[@]}"; do
  name="${entry%%|*}"
  cmd="${entry#*|}"
  if [ -n "$failed" ]; then
    echo "${D}– $name skipped${N}"
    continue
  fi
  printf '%s\n' "===== $name: $cmd" >>"$LOG"
  t0=$(date +%s)
  out_file="$(mktemp)"
  if bash -c "$cmd" >"$out_file" 2>&1; then
    cat "$out_file" >>"$LOG"
    # vitest "Tests  N passed" and node:test "# pass N"
    n=$(grep -Eo 'Tests +[0-9]+ passed|^# pass [0-9]+|ℹ pass [0-9]+' "$out_file" | grep -Eo '[0-9]+' | awk '{s+=$1} END {print s+0}')
    passed_tests=$((passed_tests + n))
    echo "${G}✓${N} $name ${D}$(( $(date +%s) - t0 ))s${N}"
  else
    cat "$out_file" >>"$LOG"
    failed="$name"
    echo "${R}✗ $name${N}"
    echo "${D}---- last lines ----${N}"
    tail -n 25 "$out_file"
  fi
  rm -f "$out_file"
done

if [ -n "$failed" ]; then
  # A red run must never leave a count a release could pick up.
  rm -f .gate/tests-passed
  echo
  echo "${R}${B}Gate RED at $failed.${N} Nothing should ship. Full log: $LOG"
  echo "${D}Rerun: npm run gate${N}"
  exit 1
fi
echo "$passed_tests" >.gate/tests-passed
echo "${G}${B}Gate GREEN${N} · $passed_tests tests · $(( $(date +%s) - start ))s"
