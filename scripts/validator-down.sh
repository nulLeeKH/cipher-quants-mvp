#!/usr/bin/env bash
# ============================================================================
# validator-down.sh — Stop the local solana-test-validator started by
# validator-up.sh. Safe to re-run; ignores already-stopped state.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PID_FILE=".anchor/validator.pid"

if [[ ! -f "$PID_FILE" ]]; then
  # Fallback: anything listening on 8899?
  if lsof -nP -iTCP:8899 -sTCP:LISTEN >/dev/null 2>&1; then
    PID=$(lsof -tnP -iTCP:8899 -sTCP:LISTEN | head -n 1)
    echo "==> no pid file, but :8899 occupied by pid $PID — killing"
    kill "$PID" 2>/dev/null || true
  else
    echo "==> no validator running"
  fi
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "==> stopping validator (pid $PID)"
  kill "$PID" 2>/dev/null || true
  for i in {1..20}; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "==> stopped"
